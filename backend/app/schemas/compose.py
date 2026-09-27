# SPDX-License-Identifier: AGPL-3.0-or-later
from typing import Literal

from pydantic import BaseModel, Field


class ComposeService(BaseModel):
    """Un servicio del proyecto, con los contenedores que lo materializan."""

    name: str = Field(..., description="Valor de com.docker.compose.service")
    image: str = Field("", description="Etiqueta com.docker.compose.image; vacía si no está")
    container_names: list[str] = Field(default_factory=list)
    container_ids: list[str] = Field(default_factory=list)
    replicas: int = Field(
        0, description="Contenedores del servicio, contando container-number"
    )
    running: int = 0


class ComposeNetwork(BaseModel):
    """Red declarada por el proyecto.

    `logical_name` es la clave dentro del archivo compose y `name` el nombre real
    en Docker, que compose prefija con el proyecto. No son lo mismo: el archivo
    puede declarar `elastic` y en Docker ser `tienda_elastic` (SPEC-11 §3.2).
    """

    logical_name: str = Field("", description="Valor de com.docker.compose.network")
    name: str = Field(..., description="Nombre real de la red en Docker")
    driver: str = "bridge"


class ComposeVolume(BaseModel):
    """Volumen declarado por el proyecto. Misma dualidad de nombres que la red."""

    logical_name: str = Field("", description="Valor de com.docker.compose.volume")
    name: str = Field(..., description="Nombre real del volumen en Docker")
    driver: str = "local"


class ComposeProjectSummary(BaseModel):
    """Fila del inventario: lo justo para ordenar y decidir sin abrir nada."""

    name: str = Field(..., description="Valor de com.docker.compose.project")
    services_count: int = 0
    containers_total: int = 0
    containers_running: int = 0
    networks_count: int = 0
    volumes_count: int = 0
    config_files: list[str] = Field(default_factory=list)
    working_dir: str = ""
    compose_version: str = ""
    orphaned: bool = Field(
        False,
        description="Sin contenedores pero con red o volúmenes: conserva recursos del proyecto",
    )


class ComposeProjectDetail(ComposeProjectSummary):
    """Resumen más el desglose de servicios, redes y volúmenes."""

    services: list[ComposeService] = Field(default_factory=list)
    networks: list[ComposeNetwork] = Field(default_factory=list)
    volumes: list[ComposeVolume] = Field(default_factory=list)


class ComposeOverview(BaseModel):
    """Inventario completo, para la pestaña y sus contadores."""

    projects: list[ComposeProjectSummary] = Field(default_factory=list)
    total_projects: int = 0
    running_projects: int = Field(
        0, description="Proyectos con al menos un contenedor en ejecución"
    )
    orphaned_projects: int = 0
    unlabelled_containers: int = Field(
        0,
        description="Contenedores sin com.docker.compose.project: los gestiona DockPilot o a mano",
    )
    unlabelled_networks: int = 0
    unlabelled_volumes: int = 0


# --- SPEC-12: previsualización de un archivo compose ---------------------------


class ComposePlanRequest(BaseModel):
    path: str = Field(
        ...,
        min_length=1,
        description="Ruta absoluta de un archivo compose. Debe existir y ser legible.",
    )
    content: str | None = Field(
        None,
        description=(
            "Contenido a validar en lugar del del disco. No se escribe nunca en "
            "disco: se valida en un temporal que se borra al terminar."
        ),
    )
    project_name: str | None = Field(
        None,
        description="Nombre de proyecto (-p). Si se omite, compose lo deduce del directorio.",
    )


class PlannedPort(BaseModel):
    """Puerto publicado por un servicio.

    `published` es una CADENA en la salida de compose, no un entero: un rango
    como "8000-8010:8000" llega como texto (SPEC-12 §3.2).
    """

    target: int = 0
    published: str | None = None
    protocol: str = "tcp"
    mode: str = "ingress"


class PlannedMount(BaseModel):
    """Montaje en forma larga, que es como compose normaliza los volúmenes y binds."""

    type: str = Field("volume", description="'volume' | 'bind' | 'tmpfs' | 'npipe'")
    source: str = Field("", description="Nombre lógico del volumen o ruta del bind")
    target: str = ""
    read_only: bool = False


class PlannedBuild(BaseModel):
    """Lo que va a costar construir este servicio, sin construirlo.

    `bytes_aprox` es una **estimacion**: no aplica `.dockerignore`, asi que
    normalmente **sobreestima**, y por eso lleva `_aprox` en el nombre. Se
    prefiere sobreestimar a ser falsamente preciso: un numero alto hace
    preguntar, uno bajo hace que el `up` tarde 8 minutos sin avisar (SPEC-15 §2.1).
    """

    context: str = Field(..., description="Ruta absoluta del contexto, resuelta contra el archivo")
    bytes_aprox: int = Field(0, description="Bytes del contexto sin aplicar .dockerignore")
    ficheros_aprox: int = Field(0, description="Ficheros contados en el recorrido")
    truncado: bool = Field(False, description="Se alcanzo el tope de ficheros al medir")
    error: str | None = Field(
        None,
        description="Por que no se pudo medir: no existe, sin permisos, no es un directorio",
    )


class ProjectCollision(BaseModel):
    """Otro proyecto del host ya ocupa este nombre de proyecto.

    `mismo_archivo` distingue un reinicio legitimo de dos compose files
    peleandose por el mismo nombre, que no se pueden fusionar (SPEC-15 §3.5).
    """

    nombre: str
    config_files: list[str] = Field(default_factory=list)
    mismo_archivo: bool


class PlannedService(BaseModel):
    """Un servicio del plan.

    Todos los campos que vienen de secciones opcionales son opcionales: la
    salida de `config` omite por completo `build`, `depends_on` y `profiles`
    cuando el servicio no las declara (SPEC-12 §3.2).
    """

    name: str
    image: str | None = None
    build: PlannedBuild | None = Field(
        None, description="Coste de construir, o None si el servicio no declara build"
    )
    container_name: str | None = None
    command: str | None = None
    entrypoint: str | None = None
    restart: str | None = None
    ports: list[PlannedPort] = Field(default_factory=list)
    mounts: list[PlannedMount] = Field(default_factory=list)
    networks: list[str] = Field(
        default_factory=list, description="Claves lógicas; compose las devuelve como mapa"
    )
    depends_on: list[str] = Field(default_factory=list)
    profiles: list[str] = Field(default_factory=list)
    environment_count: int = Field(
        0,
        description=(
            "Cuántas variables declara. Los valores NO se devuelven: pueden traer "
            "contraseñas y no hay motivo para sacarlos del archivo."
        ),
    )


class PlannedNetwork(BaseModel):
    """Red del plan. `external=True` significa que compose no la va a crear."""

    logical_name: str
    name: str = Field(..., description="Nombre real, ya prefijado con el proyecto")
    driver: str = "bridge"
    external: bool = False
    exists: bool = Field(
        False,
        description="El nombre real ya existe en el daemon: no se crearía (SPEC-12 §3.7)",
    )


class PlannedVolume(BaseModel):
    logical_name: str
    name: str = Field(..., description="Nombre real, ya prefijado con el proyecto")
    driver: str = "local"
    external: bool = False
    exists: bool = Field(
        False,
        description="El nombre real ya existe en el daemon: no se crearía (SPEC-12 §3.7)",
    )


class ComposePlan(BaseModel):
    """Configuración resuelta: lo que compose haría, sin haberlo hecho."""

    project_name: str
    source_path: str
    services: list[PlannedService] = Field(default_factory=list)
    networks: list[PlannedNetwork] = Field(default_factory=list)
    volumes: list[PlannedVolume] = Field(default_factory=list)
    warnings: list[str] = Field(
        default_factory=list,
        description="stderr de compose con código 0: el archivo es válido pero tiene avisos",
    )
    proyecto_en_uso: ProjectCollision | None = Field(
        None,
        description="Proyecto existente con este nombre desde otro archivo. Bloquea el despliegue",
    )
    resolved_by: Literal["docker-compose-cli"] = Field(
        default="docker-compose-cli",
        description=(
            "El plan lo resuelve el CLI de compose, no un parser propio. Por eso no "
            "puede discrepar de lo que hará el `up` de SPEC-13."
        ),
    )


# --- SPEC-13: ciclo de vida de un proyecto -------------------------------------

# Acciones cerradas. Un endpoint único las valida contra esta lista en lugar de
# tener cinco handlers: cinco handlers casi idénticos son cinco sitios donde
# olvidar el `finally` que mata el proceso (SPEC-13 §3.2).
COMPOSE_ACTIONS = ("up", "stop", "down", "logs", "pull")

class ComposeCommandRequest(BaseModel):
    """Query del WebSocket. La `action` se valida contra `COMPOSE_ACTIONS`."""

    path: str = Field(
        ..., min_length=1, description="Ruta absoluta de un archivo compose"
    )
    project_name: str = Field(
        ...,
        min_length=1,
        description=(
            "Nombre de proyecto (-p). Obligatorio porque deducirlo del directorio es "
            "incorrecto: compose lee `name:` del archivo (SPEC-15 §3.4)"
        ),
    )
    remove_orphans: bool = Field(
        True,
        description=(
            "`up --remove-orphans`. False en el despliegue desde el plan, donde el "
            "nombre puede chocar con otro proyecto (SPEC-15 §3.3)"
        ),
    )
    service: str | None = Field(
        None, description="Restringe la acción a un servicio. Posicional, no flag."
    )
    follow: bool = Field(
        True, description="Solo para logs: seguir la salida en vez de volcarla y salir"
    )
    volumes: bool = Field(
        False,
        description="Solo para down: añade --volumes. DESTRUCTIVO e irreversible.",
    )


class ComposeCommandStart(BaseModel):
    type: Literal["start"] = "start"
    action: str
    project: str
    path: str
    command: list[str] = Field(
        default_factory=list,
        description="Argumentos exactos, para que el usuario vea qué se ejecuta",
    )


class ComposeOutput(BaseModel):
    type: Literal["output"] = "output"
    stream: Literal["stdout", "stderr"]
    data: str


class ComposeExit(BaseModel):
    type: Literal["exit"] = "exit"
    action: str
    code: int
    duration_ms: int


class ComposeCommandError(BaseModel):
    type: Literal["error"] = "error"
    code: int = Field(..., description="400 | 404 | 409 | 503 | 504")
    message: str


class ComposeCancel(BaseModel):
    type: Literal["cancel"] = "cancel"


# --- SPEC-14: explorador de archivos compose -----------------------------------


class BrowseEntry(BaseModel):
    """Una entrada del directorio: un subdirectorio o un fichero YAML.

    `es_compose` ordena el listado, no lo filtra. Un fichero con nombre poco
    habitual (`stack.yml`) es un compose file perfectamente válido y tiene que
    seguir siendo alcanzable, así que lo que se esconde son los ficheros que no
    son YAML, que compose tampoco aceptaría.
    """

    name: str = Field(..., description="Nombre de la entrada, sin la ruta")
    path: str = Field(..., description="Ruta absoluta de la entrada")
    kind: Literal["dir", "file"] = "file"
    es_compose: bool = Field(False, description="El nombre parece un compose file")
    size: int = 0
    modificado: float = Field(0.0, description="mtime en epoch, para ordenar por fecha")


class BrowseResult(BaseModel):
    """El contenido de un directorio, ya confinado a la raíz.

    Solo lleva nombres, nunca contenido: leer el archivo es cosa de SPEC-12, con su
    límite de tamaño y su validación. Abrir aquí una segunda vía de lectura sería
    superficie que nadie ha pedido.
    """

    path: str = Field(..., description="Ruta absoluta del directorio listado")
    root: str = Field(..., description="Raíz del confinamiento")
    parent: str | None = Field(
        None,
        description="Ruta del padre, o None en la raíz: el botón de subir se deshabilita",
    )
    entries: list[BrowseEntry] = Field(default_factory=list)
    total: int = Field(0, description="Entradas que había, antes de truncar")
    truncado: bool = Field(False, description="True si se ha limitado el número de entradas")
    ocultos: int = Field(
        0, description="Entradas omitidas por salir de la raíz vía enlace simbólico"
    )
