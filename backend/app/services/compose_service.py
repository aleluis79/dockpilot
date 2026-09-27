# SPDX-License-Identifier: AGPL-3.0-or-later
import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any

import aiodocker
from fastapi import HTTPException

from app.core.config import settings
from app.core.docker import docker_error_message
from app.schemas.compose import (
    BrowseEntry,
    BrowseResult,
    ComposeNetwork,
    ComposeOverview,
    ComposePlan,
    ComposePlanRequest,
    ComposeProjectDetail,
    ComposeProjectSummary,
    ComposeService,
    ComposeVolume,
    PlannedMount,
    PlannedNetwork,
    PlannedPort,
    PlannedService,
    PlannedVolume,
)
from app.services import compose_cli

logger = logging.getLogger(__name__)

# Única clave de agrupación. Tener etiquetas no significa ser de compose: los
# volúmenes anónimos llevan `com.docker.volume.anonymous` y ningún proyecto, así
# que agrupar por "tiene labels" inventaría proyectos que no existen
# (SPEC-11 §3.2).
PROJECT_LABEL = "com.docker.compose.project"
SERVICE_LABEL = "com.docker.compose.service"
NETWORK_LABEL = "com.docker.compose.network"
VOLUME_LABEL = "com.docker.compose.volume"
NUMBER_LABEL = "com.docker.compose.container-number"
IMAGE_LABEL = "com.docker.compose.image"
CONFIG_FILES_LABEL = "com.docker.compose.project.config_files"
WORKING_DIR_LABEL = "com.docker.compose.project.working_dir"
VERSION_LABEL = "com.docker.compose.version"

RUNNING_STATES = frozenset({"running"})


def compose_project_of(labels: Any) -> str | None:
    """Proyecto compose de un recurso, o `None` si no lleva la etiqueta.

    Vive aquí para que el nombre de la etiqueta este definido en un solo sitio y
    los resúmenes de contenedor, red y volumen no repitan la constante. Acepta
    cualquier cosa porque el daemon no es uniforme: `/volumes` entrega `None`
    donde los otros dos entregan `{}` (SPEC-11 §3.2).
    """
    return _labels(labels).get(PROJECT_LABEL) or None


class ComposeProjectService:
    """Inventario de proyectos Docker Compose, derivado de etiquetas.

    El Engine API no tiene noción de proyecto: compose la construye con
    etiquetas `com.docker.compose.*` sobre contenedores, redes y volúmenes. Este
    servicio lee los tres listados y los agrupa.

    No usa `docker compose ls`: en el host de referencia ese comando devuelve un
    único proyecto y omite los huérfanos, que son justo los que hay que detectar
    (SPEC-11 §3.2).

    Se llama `ComposeProjectService` y no `ComposeService` porque el schema
    `ComposeService` ya ocupa ese nombre, y aqui significan cosas distintas: el
    schema es un servicio *dentro* de un proyecto, esta clase gestiona el
    inventario de proyectos.
    """

    @staticmethod
    async def list_projects(docker: aiodocker.Docker) -> ComposeOverview:
        """Agrupa contenedores, redes y volúmenes por proyecto compose."""
        index = await _collect(docker)
        summaries = [_to_summary(index, name) for name in index.projects]
        return ComposeOverview(
            projects=_ordered(summaries),
            total_projects=len(summaries),
            running_projects=sum(1 for p in summaries if p.containers_running > 0),
            orphaned_projects=sum(1 for p in summaries if p.orphaned),
            unlabelled_containers=index.unlabelled_containers,
            unlabelled_networks=index.unlabelled_networks,
            unlabelled_volumes=index.unlabelled_volumes,
        )

    @staticmethod
    async def get_project(docker: aiodocker.Docker, name: str) -> ComposeProjectDetail:
        """Detalle de un proyecto: servicios, redes y volúmenes."""
        index = await _collect(docker)
        if name not in index.projects:
            raise HTTPException(
                status_code=404,
                detail=f"No hay ningún proyecto Docker Compose llamado '{name}'",
            )
        summary = _to_summary(index, name)
        return ComposeProjectDetail(
            **summary.model_dump(),
            services=_services(index, name),
            networks=_networks(index, name),
            volumes=_volumes(index, name),
        )


# --- Índice intermedio --------------------------------------------------------


class _Index:
    """Agrupación intermedia de los tres listados por proyecto."""

    def __init__(self) -> None:
        self.projects: dict[str, dict[str, Any]] = {}
        self.unlabelled_containers = 0
        self.unlabelled_networks = 0
        self.unlabelled_volumes = 0

    def project(self, name: str) -> dict[str, Any]:
        return self.projects.setdefault(
            name,
            {
                "services": {},
                "networks": {},
                "volumes": {},
                "config_files": [],
                "working_dir": "",
                "compose_version": "",
            },
        )


async def _collect(docker: aiodocker.Docker) -> _Index:
    """Lee contenedores, redes y volúmenes y los agrupa por proyecto.

    Son tres llamadas y ninguna más: el detalle es de recuento, no de tamaño, así
    que no hace falta unirse a `/system/df` como sí hace SPEC-08 (SPEC-11 §3.3).
    """
    index = _Index()

    try:
        raw_containers = await docker.containers.list(all=True)
        raw_networks = await docker.networks.list()
        raw_volumes = await docker.volumes.list()
    except aiodocker.exceptions.DockerError as error:
        raise HTTPException(
            status_code=503,
            detail=f"El daemon de Docker no responde: {docker_error_message(error)}",
        ) from error

    for raw in _as_list(raw_containers):
        _add_container(index, _container_dict(raw))
    for raw in _as_list(raw_networks):
        _add_network(index, _as_dict(raw))
    for raw in _as_dict(raw_volumes).get("Volumes") or []:
        _add_volume(index, _as_dict(raw))

    return index


def _container_dict(c: Any) -> dict:
    """Extrae el dict subyacente de un `DockerContainer` o de un dict ordinario.

    `containers.list()` devuelve **objetos** `DockerContainer`, no dicts, y las
    etiquetas viven en su atributo `_container`. Sin esto, `info.get("Labels")`
    sobre el objeto devuelve nada y el inventario sale vacío: el síntoma es
    "hay contenedores compose en el host y el panel no ve ninguno".

    `networks.list()` sí devuelve dicts y `volumes.list()` un dict con clave
    `Volumes`, así que solo los contenedores necesitan esto.
    """
    inner = getattr(c, "_container", None)
    if isinstance(inner, dict):
        return inner
    return _as_dict(c)


def _add_container(index: _Index, info: dict[str, Any]) -> None:
    labels = _labels(info.get("Labels"))
    project = labels.get(PROJECT_LABEL)
    if not project:
        index.unlabelled_containers += 1
        return

    entry = index.project(project)
    if not entry["compose_version"]:
        entry["compose_version"] = labels.get(VERSION_LABEL, "")
    if not entry["working_dir"]:
        entry["working_dir"] = labels.get(WORKING_DIR_LABEL, "")

    for raw_file in _config_files(labels.get(CONFIG_FILES_LABEL, "")):
        if raw_file not in entry["config_files"]:
            entry["config_files"].append(raw_file)

    # Sin etiqueta de servicio el contenedor sigue perteneciendo al proyecto,
    # pero no se puede atribuir a un servicio concreto.
    service_name = labels.get(SERVICE_LABEL)
    container_id = _as_str(info.get("Id"))
    container_name = _container_name(info)
    state = _as_str(info.get("State"))

    if not service_name:
        service = entry["services"].setdefault(
            "",
            {"image": "", "containers": [], "running": 0},
        )
    else:
        service = entry["services"].setdefault(
            service_name,
            {"image": labels.get(IMAGE_LABEL, ""), "containers": [], "running": 0},
        )
        if not service["image"]:
            service["image"] = labels.get(IMAGE_LABEL, "")

    service["containers"].append(
        {
            "id": container_id,
            "name": container_name,
            "state": state,
            "number": labels.get(NUMBER_LABEL, ""),
        }
    )
    if state in RUNNING_STATES:
        service["running"] += 1


def _add_network(index: _Index, info: dict[str, Any]) -> None:
    labels = _labels(info.get("Labels"))
    project = labels.get(PROJECT_LABEL)
    if not project:
        index.unlabelled_networks += 1
        return
    name = _as_str(info.get("Name"))
    if not name:
        return
    index.project(project)["networks"][name] = {
        "logical_name": labels.get(NETWORK_LABEL, ""),
        "name": name,
        "driver": _as_str(info.get("Driver")) or "bridge",
    }


def _add_volume(index: _Index, info: dict[str, Any]) -> None:
    labels = _labels(info.get("Labels"))
    project = labels.get(PROJECT_LABEL)
    if not project:
        index.unlabelled_volumes += 1
        return
    name = _as_str(info.get("Name"))
    if not name:
        return
    index.project(project)["volumes"][name] = {
        "logical_name": labels.get(VOLUME_LABEL, ""),
        "name": name,
        "driver": _as_str(info.get("Driver")) or "local",
    }


# --- Proyección a schemas -----------------------------------------------------


def _to_summary(index: _Index, name: str) -> ComposeProjectSummary:
    entry = index.projects[name]
    services = entry["services"]
    containers_total = sum(len(s["containers"]) for s in services.values())
    running = sum(s["running"] for s in services.values())
    networks_count = len(entry["networks"])
    volumes_count = len(entry["volumes"])
    return ComposeProjectSummary(
        name=name,
        services_count=len([s for s in services if s]),
        containers_total=containers_total,
        containers_running=running,
        networks_count=networks_count,
        volumes_count=volumes_count,
        config_files=list(entry["config_files"]),
        working_dir=entry["working_dir"],
        compose_version=entry["compose_version"],
        # Huérfano = conserva recursos pero no tiene contenedores. Un proyecto
        # con contenedores parados NO lo es: se puede relanzar (SPEC-11 §3.3).
        orphaned=containers_total == 0 and (networks_count + volumes_count) > 0,
    )


def _services(index: _Index, project: str) -> list[ComposeService]:
    entry = index.projects[project]
    services: list[ComposeService] = []
    for name in sorted(entry["services"]):
        raw = entry["services"][name]
        containers = raw["containers"]
        services.append(
            ComposeService(
                name=name,
                image=raw["image"],
                container_names=[c["name"] for c in containers if c["name"]],
                container_ids=[c["id"] for c in containers if c["id"]],
                replicas=len(containers),
                running=raw["running"],
            )
        )
    return services


def _networks(index: _Index, project: str) -> list[ComposeNetwork]:
    entry = index.projects[project]
    return [
        ComposeNetwork(
            logical_name=entry["networks"][name]["logical_name"],
            name=name,
            driver=entry["networks"][name]["driver"],
        )
        for name in sorted(entry["networks"])
    ]


def _volumes(index: _Index, project: str) -> list[ComposeVolume]:
    entry = index.projects[project]
    return [
        ComposeVolume(
            logical_name=entry["volumes"][name]["logical_name"],
            name=name,
            driver=entry["volumes"][name]["driver"],
        )
        for name in sorted(entry["volumes"])
    ]


def _ordered(summaries: list[ComposeProjectSummary]) -> list[ComposeProjectSummary]:
    """Primero los proyectos con contenedores en ejecución, luego los huérfanos.

    Un inventario cuyo orden cambia en cada recarga es imposible de escanear, y
    el orden de un dict depende del orden de los listados del daemon.
    """
    return sorted(
        summaries,
        key=lambda p: (p.containers_running == 0, p.orphaned, p.name.lower()),
    )


# --- Normalizadores ------------------------------------------------------------
#
# `_labels` es el mismo criterio que `_clean_labels` de `volume_service`: `/volumes`
# devuelve `Labels: None` y los otros dos `{}`, y llamar a `.items()` sobre None
# revienta con `AttributeError` (SPEC-11 §3.2).


def _labels(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {str(k): str(v) for k, v in value.items()}


def _config_files(raw: str) -> list[str]:
    """La etiqueta `project.config_files` separa varios archivos por coma."""
    return [part.strip() for part in raw.split(",") if part.strip()]


def _container_name(info: dict[str, Any]) -> str:
    """`Names` llega como lista y con barra inicial: `/elasticsearch` -> `elasticsearch`."""
    names = info.get("Names")
    if isinstance(names, list) and names:
        return _as_str(names[0]).lstrip("/")
    return _as_str(info.get("Name")).lstrip("/")


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _as_str(value: Any) -> str:
    return value if isinstance(value, str) else ""


# --- SPEC-12: previsualización de un archivo compose ----------------------------

# Tope del archivo (o del contenido editado). Un compose file son unos pocos KiB;
# un megabyte es holgado y evita que un archivo enorme se pase a compose para que
# lo rechace él.
MAX_ARCHIVO_BYTES = 1024 * 1024

# Presupuesto de la petición. Se lee como global y no como valor por defecto
# para que los tests puedan ajustarlo por `monkeypatch`.
TIMEOUT_PLAN_S = 10.0

# Prefijo del temporal del contenido editado, para poder identificarlo al
# comprobar que no se queda nada en /tmp.
TEMP_PREFIX = "dockpilot-compose-"


async def build_plan(docker: aiodocker.Docker, payload: ComposePlanRequest) -> ComposePlan:
    """Resuelve un archivo compose y devuelve lo que crearía, sin crearlo.

    **No muta el host en ningún caso.** Es la última spec antes de que SPEC-13
    introduzca la escritura, y el plan solo llama a `config`, que no toca nada.
    """
    ruta = _validar_ruta(payload.path, payload.content)

    temporal: Path | None = None
    a_resolver = Path(ruta)
    if payload.content is not None:
        temporal = _escribir_temporal(Path(ruta).parent, payload.content)
        a_resolver = temporal

    try:
        resultado = await compose_cli.ejecutar_config(
            a_resolver,
            project_name=payload.project_name,
            timeout=TIMEOUT_PLAN_S,
        )
    except compose_cli.ComposeCliAusente as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except compose_cli.ComposeCliTimeout as error:
        raise HTTPException(status_code=504, detail=str(error)) from error
    except compose_cli.ComposeCliFallo as error:
        # 422 y no 500: el archivo es inválido, y el panel tiene que poder
        # distinguir "lo has escrito mal" de "el panel se ha roto".
        raise HTTPException(
            status_code=422,
            detail=_mensaje_validacion(error.stderr),
        ) from error
    finally:
        if temporal is not None:
            # Obligación: el temporal puede contener secretos y se borra tanto si
            # compose validó como si falló.
            _borrar_temporal(temporal)

    datos = _parsear_json(resultado.stdout)
    if datos is None:
        raise HTTPException(
            status_code=422,
            detail=(
                "Docker Compose devolvió una respuesta que no es un plan legible. "
                "Comprueba la versión del CLI."
            ),
        )

    return _a_plan(
        datos,
        payload.path,
        resultado.stderr,
        await _nombres_existentes(docker, datos),
    )


def _validar_ruta(path: str, content: str | None) -> str:
    """Valida la ruta antes de leer nada del disco ni lanzar el CLI.

    El orden importa: una ruta relativa se rechazaría más tarde, en el CLI, con un
    error que no menciona que el problema es la ruta.
    """
    if not path.startswith("/"):
        raise HTTPException(
            status_code=400,
            detail=(
                "La ruta debe ser absoluta. Una ruta relativa se resolvería contra "
                "el directorio del servidor, no contra el tuyo."
            ),
        )
    if content is not None and len(content.encode("utf-8")) > MAX_ARCHIVO_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"El contenido editado supera el máximo de {MAX_ARCHIVO_BYTES} bytes",
        )

    ruta = Path(path)
    if not ruta.exists():
        raise HTTPException(
            status_code=404, detail=f"No existe el archivo: {path}"
        )
    if not ruta.is_file():
        raise HTTPException(
            status_code=400, detail=f"No es un archivo: {path}"
        )
    try:
        tamano = ruta.stat().st_size
    except OSError as error:
        raise HTTPException(
            status_code=404, detail=f"No se pudo leer {path}: {error}"
        ) from error
    if tamano > MAX_ARCHIVO_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"El archivo supera el máximo de {MAX_ARCHIVO_BYTES} bytes",
        )
    return path


def _escribir_temporal(directorio: Path, content: str) -> Path:
    """Escribe el contenido editado junto al archivo original.

    En **su mismo directorio**, no en /tmp: los `env_file` y los `build.context`
    relativos se resuelven contra el directorio del archivo, y un temporal en
    /tmp haría que compose leyera otros archivos o ninguno.
    """
    try:
        descriptor, nombre = tempfile.mkstemp(
            prefix=TEMP_PREFIX, suffix=".yml", dir=str(directorio)
        )
    except OSError as error:
        raise HTTPException(
            status_code=400,
            detail=(
                f"No se pudo preparar el contenido editado en {directorio}: {error}"
            ),
        ) from error
    with os.fdopen(descriptor, "w", encoding="utf-8") as archivo:
        archivo.write(content)
    return Path(nombre)


def _borrar_temporal(ruta: Path) -> None:
    try:
        ruta.unlink(missing_ok=True)
    except OSError:
        # Si no se puede borrar, el aviso va al log del servidor: no vale la pena
        # convertir un preview correcto en un error.
        logger.warning("No se pudo borrar el temporal %s", ruta)


def _parsear_json(stdout: str) -> dict[str, Any] | None:
    try:
        datos = json.loads(stdout) if stdout.strip() else {}
    except json.JSONDecodeError:
        return None
    return datos if isinstance(datos, dict) else None


def _mensaje_validacion(stderr: str) -> str:
    """El mensaje de compose es lo más útil que el panel puede mostrar.

    El usuario reconoce ese texto porque es el mismo que ve en su terminal.
    """
    limpio = stderr.strip()
    if not limpio:
        return "Docker Compose no pudo validar el archivo"
    return limpio


def _a_plan(
    datos: dict[str, Any],
    source_path: str,
    stderr: str,
    existentes: dict[str, set[str]],
) -> ComposePlan:
    """Proyecta el JSON de `config` al contrato del plan.

    `stderr` con código 0 son avisos, no errores: compose valida el archivo y aun
    así avisa de una variable sin definir (SPEC-12 §3.3).
    """
    servicios = datos.get("services")
    return ComposePlan(
        project_name=_as_str(datos.get("name")) or Path(source_path).resolve().parent.name,
        source_path=source_path,
        services=[_a_servicio(nombre, raw) for nombre, raw in sorted(_as_dict(servicios).items())],
        networks=_a_recursos(datos.get("networks"), PlannedNetwork, existentes),
        volumes=_a_recursos(datos.get("volumes"), PlannedVolume, existentes),
        warnings=_warnings(stderr),
        resolved_by="docker-compose-cli",
    )


def _a_servicio(nombre: str, raw: Any) -> PlannedService:
    servicio = _as_dict(raw)
    return PlannedService(
        name=nombre,
        image=_as_str_or_none(servicio.get("image")),
        build=bool(servicio.get("build")),
        container_name=_as_str_or_none(servicio.get("container_name")),
        command=_as_str_or_none(servicio.get("command")),
        entrypoint=_as_str_or_none(servicio.get("entrypoint")),
        restart=_as_str_or_none(servicio.get("restart")),
        ports=[_a_puerto(p) for p in _as_list(servicio.get("ports"))],
        mounts=[_a_montaje(m) for m in _as_list(servicio.get("volumes"))],
        # `networks` de un servicio es un MAPA con valor null: interesan las claves.
        networks=sorted(_as_dict(servicio.get("networks")).keys()),
        depends_on=_a_dependencias(servicio.get("depends_on")),
        profiles=[_as_str(p) for p in _as_list(servicio.get("profiles")) if _as_str(p)],
        environment_count=_a_conteo_entorno(servicio.get("environment")),
    )


def _a_puerto(raw: Any) -> PlannedPort:
    puerto = _as_dict(raw)
    # `published` es una CADENA: un rango "8000-8010" llega como texto y tiparlo
    # como int revienta con cualquier rango de puertos.
    publicado = puerto.get("published")
    return PlannedPort(
        target=_as_int(puerto.get("target")),
        published=None if publicado is None else str(publicado),
        protocol=_as_str(puerto.get("protocol")) or "tcp",
        mode=_as_str(puerto.get("mode")) or "ingress",
    )


def _a_montaje(raw: Any) -> PlannedMount:
    montaje = _as_dict(raw)
    return PlannedMount(
        type=_as_str(montaje.get("type")) or "volume",
        source=_as_str(montaje.get("source")),
        target=_as_str(montaje.get("target")),
        read_only=bool(montaje.get("read_only")),
    )


def _a_dependencias(raw: Any) -> list[str]:
    """`depends_on` es un mapa con la condición por servicio; interesan las claves.

    Se tolera también la forma de lista por si una versión del CLI la emitiera así.
    """
    if isinstance(raw, dict):
        return sorted(str(clave) for clave in raw)
    return [_as_str(item) for item in _as_list(raw) if _as_str(item)]


def _a_conteo_entorno(raw: Any) -> int:
    """Solo el recuento. Los valores pueden traer contraseñas."""
    if isinstance(raw, dict):
        return len(raw)
    return len(_as_list(raw))


def _a_recursos(
    raw: Any,
    clase: type[PlannedNetwork] | type[PlannedVolume],
    existentes: dict[str, set[str]],
) -> list[PlannedNetwork] | list[PlannedVolume]:
    """Proyecta las redes o los volúmenes de la raíz.

    Son **mapas**: la clave es el nombre lógico que declara el archivo y el
    valor trae el nombre real, ya prefijado con el proyecto. Iterarlos como lista
    da TypeError, y quedarse con la clave muestra `elastic` donde el usuario
    necesita `tienda_elastic` (SPEC-12 §3.2).
    """
    clave = "networks" if clase is PlannedNetwork else "volumes"
    ya_existentes = existentes.get(clave, set())
    default = "bridge" if clase is PlannedNetwork else "local"

    salida: list[PlannedNetwork] | list[PlannedVolume] = []
    for logico, raw_item in sorted(_as_dict(raw).items()):
        item = _as_dict(raw_item)
        real = _as_str(item.get("name")) or str(logico)
        salida.append(
            clase(
                logical_name=str(logico),
                name=real,
                driver=_as_str(item.get("driver")) or default,
                external=bool(item.get("external")),
                # Distinguir "esto ya está" de "esto se crearía" es la pregunta
                # que hace que el plan sirva de algo (SPEC-12 §3.7).
                exists=real in ya_existentes,
            )
        )
    return salida


async def _nombres_existentes(
    docker: aiodocker.Docker, datos: dict[str, Any]
) -> dict[str, set[str]]:
    """Nombres de redes y volúmenes que ya existen en el daemon.

    Sirve para que la UI distinga "esto ya está" de "esto se crearía". Son dos
    llamadas de lectura, y si el daemon falla se devuelve vacío en vez de romper
    el plan: el preview es válido aunque no se pueda cruzar con el host.
    """
    declaradas = {
        "networks": {
            _as_str(_as_dict(v).get("name")) or str(k)
            for k, v in _as_dict(datos.get("networks")).items()
        },
        "volumes": {
            _as_str(_as_dict(v).get("name")) or str(k)
            for k, v in _as_dict(datos.get("volumes")).items()
        },
    }
    try:
        redes = {str(_as_dict(n).get("Name")) for n in await docker.networks.list()}
        crudos = await docker.volumes.list()
        volumenes = {str(_as_dict(v).get("Name")) for v in _as_dict(crudos).get("Volumes") or []}
    except Exception:  # El plan no debe depender de esta lectura
        return declaradas
    return {
        "networks": redes & declaradas["networks"],
        "volumes": volumenes & declaradas["volumes"],
    }


def _warnings(stderr: str) -> list[str]:
    """Avisos de compose, línea a línea y sin tocar el texto.

    Vienen en formato logrus (`time=... level=warning msg=...`). Se devuelven
    crudos porque el usuario reconoce ese texto: es el mismo de su terminal.
    """
    return [linea.strip() for linea in stderr.splitlines() if linea.strip()]


def _as_str_or_none(value: Any) -> str | None:
    """Un texto opcional de verdad: `None` si no viene, no cadena vacía.

    Compose omite la clave entera cuando el servicio no la declara, y `"image": null`
    y `""` no significan lo mismo que no declararlo.
    """
    if value is None:
        return None
    return value if isinstance(value, str) else str(value)


def _as_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


# --- SPEC-14: explorador de archivos compose -----------------------------------
#
# El motivo de que esto exista: en el host de referencia hay 4 archivos compose y
# el inventario solo conoce 1. Los otros tres no estan en marcha, no dejan
# etiquetas `com.docker.compose.*` y son invisibles para el panel (SPEC-11 §1), asi
# que la unica forma de llegar a ellos era copiar la ruta de memoria.


def _parece_compose(nombre: str) -> bool:
    """Si el nombre delata un compose file. Solo ordena: nunca filtra.

    Un fichero llamado `stack.yml` es un compose file perfectamente valido. Si se
    filtrara por nombre, se dejarian fuera proyectos reales, que es justo el
    problema que esta spec viene a resolver.
    """
    base = nombre.lower()
    if not (base.endswith(".yml") or base.endswith(".yaml")):
        return False
    return "compose" in base


def _raiz_browse() -> Path:
    """La raiz del explorador, resuelta en cada llamada.

    `expanduser` y no un literal: el backend puede correr como otro usuario del
    host o dentro de un contenedor, y lo que interesa es el home de quien ejecuta
    el panel, que es de donde se sirve el resto del sistema de archivos.
    """
    configurada = settings.COMPOSE_BROWSE_ROOT
    return Path(configurada or os.path.expanduser("~")).resolve()


def _dentro_de(objetivo: Path, raiz: Path) -> bool:
    """Si `objetivo` esta en `raiz` o es `raiz` misma.

    Se comparan `parents` y no el texto porque `str.startswith()` se equivoca en
    los dos sentidos: sin separador acepta `/home/alejandro` para una raiz
    `/home/al`, y con separador rechaza todo cuando la raiz es `/`, porque
    buscaria `//`. Comprobado con directorios reales en `test_compose_browse.py`.
    """
    return objetivo == raiz or raiz in objetivo.parents


def _resolver_dentro(path: str, raiz: Path) -> Path:
    """Valida la ruta y la deja resuelta, dentro de la raiz o no.

    El orden importa: tiene que ser absoluta antes de nada, porque
    `Path("sica").resolve()` la resolveria contra el directorio de trabajo del
    servidor y devolveria una ruta que parece estar dentro de la raiz sin que
    nadie haya dicho donde.
    """
    if not path.startswith("/"):
        raise HTTPException(
            status_code=400,
            detail=(
                "La ruta debe ser absoluta. Una ruta relativa se resolvería contra "
                "el directorio del servidor, no contra el tuyo."
            ),
        )

    try:
        objetivo = Path(path).resolve()
    except (OSError, RuntimeError) as error:
        # `RuntimeError` es el bucle de enlaces simbolicos. Un `..` normal no
        # lanza nada: `resolve()` lo resuelve y por eso el filtro de debajo sigue
        # siendo imprescindible.
        raise HTTPException(
            status_code=400, detail=f"No se pudo resolver la ruta: {error}"
        ) from error

    if not _dentro_de(objetivo, raiz):
        # El mismo mensaje para "fuera de la raiz" y para una ruta que no existe:
        # si se distinguieran, el endpoint serviria para mapear el disco probando
        # rutas y leyendo los codigos de respuesta.
        raise HTTPException(
            status_code=403,
            detail=(
                "Esa ruta está fuera del explorador. Solo se puede llegar a "
                "archivos dentro del directorio permitido."
            ),
        )
    return objetivo


def _es_fichero_compose(nombre: str) -> bool:
    """Solo se listan los YAML: compose no acepta nada mas como archivo de entrada."""
    base = nombre.lower()
    return base.endswith(".yml") or base.endswith(".yaml")


def _ordinar(
    entradas, raiz: Path
) -> tuple[list[BrowseEntry], list[BrowseEntry], int]:
    """Reparte las entradas en directorios y ficheros, ya ordenados.

    Los directorios que resuelven fuera de la raiz se descartan: un enlace a
    `~/.ssh` pasa cualquier comparacion de texto, y ofrecerlo para luego
    rechazarlo al entrar seria peor que no ofrecerlo.
    """
    omitidos = 0
    directorios: list[BrowseEntry] = []
    ficheros: list[BrowseEntry] = []

    for entrada in entradas:
        completa = entrada.path
        try:
            # Se resuelve para que un enlace simbolico no cuelgue de la comparacion
            # de texto, que es la unica parte de esto que decide si algo se ve.
            dentro = _dentro_de(Path(completa).resolve(), raiz)
        except (OSError, RuntimeError):
            dentro = False

        if not dentro:
            omitidos += 1
            continue

        if entrada.is_dir(follow_symlinks=True):
            directorios.append(
                BrowseEntry(
                    name=entrada.name,
                    path=completa,
                    kind="dir",
                    es_compose=False,
                    size=0,
                    modificado=_mtime(entrada),
                )
            )
            continue

        if not _es_fichero_compose(entrada.name):
            continue

        try:
            info = entrada.stat(follow_symlinks=False)
        except OSError:
            # Una entrada que desaparece entre el listado y el `stat` se salta:
            # es lo normal en cualquier explorador de ficheros.
            continue

        ficheros.append(
            BrowseEntry(
                name=entrada.name,
                path=completa,
                kind="file",
                es_compose=_parece_compose(entrada.name),
                size=info.st_size,
                modificado=info.st_mtime,
            )
        )

    directorios.sort(key=lambda e: e.name.lower())
    # Los compose primero, y a igualdad por nombre para que el orden sea estable
    # entre recargas: un listado que se reordena solo no se puede escanear.
    ficheros.sort(key=lambda e: (not e.es_compose, e.name.lower()))
    return directorios, ficheros, omitidos


def _mtime(entrada) -> float:
    try:
        return entrada.stat(follow_symlinks=True).st_mtime
    except OSError:
        return 0.0


def _truncar(
    directorios: list[BrowseEntry], ficheros: list[BrowseEntry], maximo: int
) -> tuple[list[BrowseEntry], bool]:
    """Recorta el listado a `maximo` entradas, sin callar lo que se ha dejado fuera.

    Si hay que cortar, se cortan primero los ficheros: los directorios son la
    navegacion, y llegar al fichero concreto ya es un paso posterior.
    """
    if len(directorios) + len(ficheros) <= maximo:
        return directorios + ficheros, False

    elegidos = directorios[:maximo]
    sobrantes = maximo - len(elegidos)
    if sobrantes > 0:
        elegidos = elegidos + ficheros[:sobrantes]
    return elegidos, True


async def browse(path: str | None = None) -> BrowseResult:
    """Lista un directorio para elegir un compose file.

    Sin `path` se lista la raiz. El cliente no puede deducirla: `~` es relativo
    al usuario del *backend*, no al del navegador, asi que la unica forma de que
    sepa donde esta el confineamiento es que se lo diga el backend.

    Devuelve **nombres, tipos y tamanos, nunca contenido**: leer el archivo es
    cosa de `build_plan` (SPEC-12), con su limite de tamano y su validacion. Abrir
    aqui una segunda via de lectura seria superficie que nadie ha pedido.

    No habla con Docker: es una lectura del sistema de archivos y nada mas.
    """
    raiz = _raiz_browse()
    objetivo = raiz if path is None else _resolver_dentro(path, raiz)

    if not objetivo.exists():
        raise HTTPException(
            status_code=404, detail=f"No existe el directorio: {objetivo}"
        )
    if not objetivo.is_dir():
        raise HTTPException(status_code=400, detail=f"No es un directorio: {objetivo}")

    try:
        with os.scandir(objetivo) as entradas:
            directorios, ficheros, omitidos = _ordinar(entradas, raiz)
    except PermissionError as error:
        raise HTTPException(
            status_code=403, detail=f"No se puede leer el directorio: {error}"
        ) from error
    except OSError as error:
        raise HTTPException(
            status_code=404, detail=f"No se pudo leer el directorio: {error}"
        ) from error

    entradas_finales, truncado = _truncar(
        directorios, ficheros, settings.COMPOSE_BROWSE_MAX
    )

    return BrowseResult(
        path=str(objetivo),
        root=str(raiz),
        # `None` en la raiz, y no la raiz misma: es lo que deshabilita el boton de
        # subir y lo que marca en la interfaz donde acaba el confinamiento.
        parent=(
            str(objetivo.parent)
            if objetivo != raiz and _dentro_de(objetivo.parent, raiz)
            else None
        ),
        entries=entradas_finales,
        total=len(directorios) + len(ficheros),
        truncado=truncado,
        ocultos=omitidos,
    )
