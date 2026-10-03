# SPDX-License-Identifier: AGPL-3.0-or-later
import asyncio
import re
import shlex
import struct
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any

import aiodocker
import aiohttp
from aiodocker.exceptions import DockerError
from fastapi import HTTPException

from app.core.docker import docker_error_message, docker_error_status
from app.schemas.container import (
    ContainerActionResponse,
    ContainerDetail,
    ContainerPrunePreview,
    ContainerPruneResult,
    ContainerSummary,
    CreateContainerRequest,
    CreateContainerResponse,
    HealthDetail,
    HealthProbe,
    HealthSummary,
    PortMapping,
    RenameContainerResponse,
)
from app.schemas.log import LogEntry, LogSnapshotResponse
from app.services.compose_service import compose_project_of
from app.services.image_service import normalize_image_ref
from app.services.metrics_store import get_store


def _get_container_dict(c: Any) -> dict:
    """Extrae el diccionario subyacente tanto de DockerContainer como de un dict ordinario."""
    if hasattr(c, "_container") and isinstance(c._container, dict):
        return c._container
    if isinstance(c, dict):
        return c
    return {}


# Timestamp RFC-3339 tal como lo emite Docker: `2026-09-25T20:24:39.154430789Z`
# o con offset explícito. Anclado a principio y con la forma completa, para que
# una palabra suelta que lleve una `T` y un guion no se confunda con una fecha.
_TIMESTAMP_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)

# Marca de stderr: el prefijo que pone la propia aplicación, o una palabra de
# error ABRIDA por un separador (`ERROR:`, `FATAL -`). Se exige el separador a
# propósito: una frase que empiece por "Error" no es necesariamente un error.
_STDERR_RE = re.compile(r"^\[?stderr\]?\b|^(?:error|fatal|panic|exception)\b\s*[:\-]")


def _parse_port_mappings(ports_raw: list) -> list[PortMapping]:
    result = []
    for p in ports_raw or []:
        if isinstance(p, dict):
            result.append(
                PortMapping(
                    ip=p.get("IP", "0.0.0.0"),
                    private_port=p.get("PrivatePort", 0),
                    public_port=p.get("PublicPort"),
                    type=p.get("Type", "tcp"),
                )
            )
    return result


def _parse_created_timestamp(created_val: Any) -> int:
    """`Created` llega como epoch en `list` y como fecha ISO en `inspect`.

    La ISO llega en UTC con `Z` (`2026-09-20T15:48:34.746262744Z`). Hay que
    cambiarle la `Z` por un offset explícito ANTES de `fromisoformat`: si se
    quita a lo bruto, el resultado es un datetime *naive*, y `.timestamp()` lo
    interpreta como hora local, con lo que la fecha sale desviada exactamente lo
    que el offset del host. Los subsegundos también cuentan: no hay que
    truncarlos para no perder la precisión.
    """
    if isinstance(created_val, (int, float)):
        return int(created_val)
    if isinstance(created_val, str) and created_val:
        try:
            return int(datetime.fromisoformat(created_val.replace("Z", "+00:00")).timestamp())
        except ValueError:
            return 0
    return 0


def parse_docker_log_line(
    raw_line: str, default_stream: str = "stdout", timestamps: bool = True
) -> LogEntry:
    """Parsea una línea cruda de log de Docker separando timestamp y stream.

    Para el **snapshot** y el WebSocket, que siguen por `container.log()` de
    aiodocker y llegan sin el byte de stream. El camino de `stream_logs` usa
    `_entrada_de_log` con el stream real del frame y no pasa por aquí.
    """
    return _entrada_de_log(raw_line, default_stream, timestamps)


def _entrada_de_log(linea: str, stream: str, timestamps: bool) -> LogEntry:
    """Separa el timestamp inicial del mensaje, con el stream ya conocido.

    `timestamps` importa: es el flag que se le pasó a `container.log()`, así que
    el parser sabe si puede haber un timestamp delante. Sin esa pista, el sniff
    anterior se comía el primer token de cualquier línea normal que contuviera
    una `T` y un signo: `"T-shirt S-M: 42 items"` salía como timestamp `T-shirt:`
    y mensaje `S-M: 42 items`.
    """
    limpia = linea.rstrip("\r\n")
    if timestamps:
        partes = limpia.split(" ", 1)
        if len(partes) == 2 and _TIMESTAMP_RE.match(partes[0]):
            return LogEntry(timestamp=partes[0], stream=stream, message=partes[1])

    # Sin timestamp fiable, el stream viene del frame y no hay que adivinarlo.
    if stream != "stdout":
        return LogEntry(timestamp=None, stream=stream, message=limpia)

    return LogEntry(
        timestamp=None,
        stream="stderr" if _es_stderr(limpia) else "stdout",
        message=limpia,
    )


def _es_stderr(message: str) -> bool:
    """Último recurso para decidir el stream de una línea.

    Con el stream ya leído del frame multiplexado (§ `_stream_demultiplexado`)
    esto **no hace falta**: cada línea llega con su stream. Se conserva para los
    dos caminos que no pasan por el demultiplexador —el snapshot REST y el WebSocket,
    que siguen usando `container.log()` de aiodocker— y para que un `LogEntry`
    construido a mano no quede sin stream.

    Se prefiere la falsa negativa a la falsa positiva: se marca como stderr
    cuando la línea lleva marca explícita (`[stderr]`, `ERROR:`, `FATAL:`...), y
    una frase normal que empiece por "Error" se queda en stdout. Antes se
    buscaban las palabras "error" o "fatal" en los primeros 25 caracteres, lo
    que arrastraba a stderr líneas como "Error handled gracefully by middleware"
    y las sacaba del filtro de stdout del visor.
    """
    return bool(_STDERR_RE.match(message.lower()))


# --- Demultiplexado del stream de logs -----------------------------------------
#
# Docker multiplexa stdout y stderr en un solo stream: cada frame lleva una
# cabecera de 8 bytes, `>BxxxL`, donde el primer byte ES el stream y los cuatro
# últimos su longitud. aiodocker **descarta ese byte**
# (`MultiplexedResult.fetch`: `_, length = struct.unpack(">BxxxL", header)`), así
# que con `container.log()` no hay forma de saber de qué stream salió una línea
# y la única señal disponible es el texto, que es una heurística y falla.
#
# Leer el stream a mano es la única forma de hacerlo bien, y el proyecto ya usa
# primitivas internas de aiodocker en otros sitios (`_query_json` para redes y
# para `/system/df`), así que no es una excepción nueva. El formato está
# documentado en la API de Docker y es estable.

_STREAM_HEADER_BYTES = 8

# Byte 1 = stdout, byte 2 = stderr. El 0 (stdin) no llega en logs.
_NOMBRES_STREAM = {1: "stdout", 2: "stderr"}


async def _stream_demultiplexado(
    docker: aiodocker.Docker,
    container: Any,
    *,
    tail: int,
    timestamps: bool,
    follow: bool,
) -> AsyncIterator[tuple[int | None, str]]:
    """Emite `(stream, línea)` leyendo la cabecera de cada frame.

    Con `tty=True` Docker **no** multiplexa: sale todo por stdout y sin cabecera,
    que es el caso `raw` de aiodocker y el único en el que `stream` no aporta
    nada. Se detecta igual, por el `Config.Tty` del contenedor.

    Un frame puede traer varias líneas o una línea a medias entre frames, así que
    se acumula un buffer y se corta por `\n`. El buffer **no** se reparte por
    stream: si una línea se parte entre un frame de stdout y otro de stderr, es la
    misma línea y el corte por stream la trocearía en dos.
    """
    try:
        info = await container.show()
    except Exception:
        info = {}
    es_tty = bool(_as_dict_get(info, "Config").get("Tty"))

    cm = docker._query(
        f"containers/{getattr(container, '_id', container.id)}/logs",
        method="GET",
        params={
            "stdout": True,
            "stderr": True,
            "follow": follow,
            "tail": tail,
            "timestamps": timestamps,
        },
        # Logs y stats son de larga duración: sin `total` ni `sock_read` el
        # stream no se corta nunca solo. `None` es exactamente eso.
        timeout=None,
    )

    async with cm as response:
        buffer = ""
        # El stream de la línea en curso, para no trocearla al cambiar de frame.
        stream_actual: int | None = 1
        async for stream, payload in _frames(response.content, es_tty):
            stream_actual = stream_actual if stream is None else stream
            buffer += payload.decode("utf-8", errors="replace")
            *lineas, buffer = buffer.split("\n")
            for linea in lineas:
                yield stream_actual, linea
        if buffer:
            yield stream_actual, buffer


async def _frames(
    contenido: Any, es_tty: bool
) -> AsyncIterator[tuple[int | None, bytes]]:
    """Trocear el stream en frames, devolviendo el byte de stream de cada uno.

    Con TTY no hay cabecera y todo es stdout, así que el byte sale como `None` y
    quien llama lo interpreta.
    """
    if es_tty:
        async for chunk in contenido.iter_any():
            yield None, chunk
        return

    try:
        while True:
            cabecera = await contenido.readexactly(_STREAM_HEADER_BYTES)
            stream, longitud = struct.unpack(">BxxxL", cabecera)
            if not longitud:
                # Frame vacío (stdout o stderr cerrado): el protocolo lo permite
                # y no debe cortarse el stream por ello.
                continue
            yield stream, await contenido.readexactly(longitud)
    except (asyncio.IncompleteReadError, aiohttp.ClientConnectionError, aiohttp.ServerDisconnectedError):
        # El contenedor se paró o se cerró la conexión: fin del stream, no un
        # error. Es el mismo criterio que usa `MultiplexedResult.fetch`.
        return


def _as_dict_get(datos: Any, clave: str) -> dict[str, Any]:
    valor = datos.get(clave) if isinstance(datos, dict) else None
    return valor if isinstance(valor, dict) else {}


def _as_str(valor: Any) -> str:
    return valor if isinstance(valor, str) else ""


def _as_int(valor: Any) -> int:
    """Entero o cero. El daemon manda `null` en varios campos cuando no puede
    medir, y un `None` en un campo `int` revienta la respuesta."""
    if isinstance(valor, bool):
        return 0
    if isinstance(valor, int):
        return valor
    if isinstance(valor, float):
        return int(valor)
    if isinstance(valor, str):
        try:
            return int(valor)
        except ValueError:
            return 0
    return 0


# --- Salud (SPEC-18) ------------------------------------------------------------

# Los cuatro estados que distingue el daemon. Un estado que no sea uno de estos
# se trata como "none": el schema es un `Literal` y una versión nueva del daemon
# no puede meter un valor por la puerta de atrás y acabar pintado como sano.
_ESTADOS_SALUD = frozenset({"healthy", "unhealthy", "starting", "none"})

# Tope de la salida de una sonda. El daemon YA recorta a 4096 bytes por su cuenta
# (medido: una sonda que imprime 3 MB llega con 4099), así que esto es defensa en
# profundidad y no la barrera principal. Si mañana el daemon deja de recortar, el
# detalle sigue sin recibir megabytes por el socket.
MAX_SALIDA_SONDA = 4096


def _estado_salud(valor: Any) -> str:
    estado = _as_str(valor) if isinstance(valor, str) else ""
    return estado if estado in _ESTADOS_SALUD else "none"


def _health_de_listado(info: dict[str, Any]) -> HealthSummary:
    """Salud desde `containers/json`.

    Ahí `"none"` es un **valor**: es el único sitio donde se distingue "no
    healthcheck" de "sonda en curso". La clave no existe en Docker < 20.10, y su
    ausencia también quiere decir "none" (SPEC-18 §2.2).
    """
    health = info.get("Health")
    if not isinstance(health, dict):
        return HealthSummary()
    return HealthSummary(
        status=_estado_salud(health.get("Status")),
        failing_streak=_as_int(health.get("FailingStreak")),
    )


def _health_de_inspect(info: dict[str, Any]) -> HealthDetail:
    """Salud desde `containers/{id}/json`, que además trae el porqué.

    Aquí la ausencia es `None` y **no** `"none"`: sin healthcheck, `State.Health`
    directamente no existe. Confundir los dos casos haría que un contenedor sin
    sonda pareciera evaluado.

    `Log` sí existe en este endpoint (las últimas 5 sondas con su salida) y es lo
    que convierte "está unhealthy" en algo accionable.
    """
    state = info.get("State") if isinstance(info.get("State"), dict) else {}
    health = state.get("Health")

    test_bruto = _as_dict_get(info, "Config").get("Healthcheck")
    test = test_bruto.get("Test") if isinstance(test_bruto, dict) else None

    if not isinstance(health, dict):
        return HealthDetail(test=[str(t) for t in test] if isinstance(test, list) else [])

    log = health.get("Log")
    return HealthDetail(
        status=_estado_salud(health.get("Status")),
        failing_streak=_as_int(health.get("FailingStreak")),
        log=[
            HealthProbe(
                started_at=_as_str(sonda.get("Start")),
                finished_at=_as_str(sonda.get("End")),
                exit_code=_as_int(sonda.get("ExitCode")),
                output=_recortar(_as_str(sonda.get("Output")), MAX_SALIDA_SONDA),
            )
            for sonda in (log if isinstance(log, list) else [])
            if isinstance(sonda, dict)
        ],
        test=[str(t) for t in test] if isinstance(test, list) else [],
    )


def _recortar(texto: str, limite: int) -> str:
    """Recorta diciendo cuántos bytes quitó, para no fingir que es todo."""
    if len(texto) <= limite:
        return texto
    return f"{texto[:limite]}\n… ({len(texto) - limite} bytes más, recortados)"


# --- Renombrado (SPEC-19) ------------------------------------------------------
#
# El validador de REDES del proyecto (`network_service.NAME_PATTERN`) usa `*` y
# por tanto acepta un nombre de UN solo carácter. Docker los rechaza: exige
# `[a-zA-Z0-9][a-zA-Z0-9_.-]+`, con al menos dos. Mismo comienzo, aridad
# distinta, así que este es un validador propio y **no** una reutilización.

NOMBRE_CONTENEDOR_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]+$")

# 63 es lo que usa el propio daemon para redes, y es el tope de una etiqueta
# DNS. Los contenedores no tienen tope en el daemon —comprobado: acepta 300
# caracteres—, pero un nombre así no puede ser un nombre de host, así que rompe
# la resolución en cuanto el contenedor toca una red personalizada (SPEC-19 §2.3).
MAX_NOMBRE_CONTENEDOR = 63


def _validar_nombre_contenedor(nombre: str) -> None:
    if not nombre:
        raise HTTPException(status_code=400, detail="El nombre no puede estar vacío")

    if len(nombre) < 2:
        raise HTTPException(
            status_code=400,
            detail=(
                "El nombre necesita al menos dos caracteres; el daemon no acepta "
                "un nombre de uno solo."
            ),
        )

    if len(nombre) > MAX_NOMBRE_CONTENEDOR:
        raise HTTPException(
            status_code=400,
            detail=(
                f"El nombre no puede superar {MAX_NOMBRE_CONTENEDOR} caracteres. Es "
                "el tope de un nombre de host, y un nombre más largo no podría "
                "resolver en una red personalizada."
            ),
        )

    if not NOMBRE_CONTENEDOR_RE.match(nombre):
        raise HTTPException(
            status_code=400,
            detail=_detalle_de_nombre_invalido(nombre),
        )


# Cómo se llama cada carácter prohibido. Sin esto el mensaje sería la lista de
# permitidos y el usuario tendría que buscar cuál de ellos es el suyo.
_CARACTERES_PROHIBIDOS = {
    " ": "espacios",
    "/": "barras",
    ":": "dos puntos",
    "\\": "barras invertidas",
    "@": "arrobas",
    "#": "almohadillas",
    "$": "signos de dólar",
    "%": "signos de porcentaje",
}


def _detalle_de_nombre_invalido(nombre: str) -> str:
    permitidos = "letras, dígitos, punto, guion y guion bajo, empezando por letra o dígito"
    primer = next((c for c in nombre if not re.match(r"[a-zA-Z0-9_.-]", c)), None)
    if primer is None:
        # Todos los caracteres valen, así que lo que falla es el comienzo.
        return (
            "El nombre solo puede llevar letras, dígitos, punto, guion y guion bajo, "
            "y debe empezar por letra o dígito."
        )
    return (
        f"El nombre no puede contener {_CARACTERES_PROHIBIDOS.get(primer, repr(primer))}. "
        f"Solo se permiten {permitidos}."
    )


def _nombre_del_conflicto(error: DockerError) -> str:
    """Saca el nombre ocupado del mensaje del daemon.

    El texto es `Conflict. The container name "/mi-nginx" is already in use by
    container "a4d16..."`. La UI enseña el nombre; el id no se enseña nunca.
    """
    texto = docker_error_message(error)
    coincide = re.search(r'name\s*"([^"]+)"', texto)
    return coincide.group(1).lstrip("/") if coincide else ""


def _nombre_actual(info: dict[str, Any]) -> str:
    """El nombre del contenedor según su `inspect`, sin la barra inicial.

    Viene de `show()` y no del objeto `DockerContainer` porque
    `containers.get(id)` deja `_container` con sólo el id: los `Names` sólo están
    si el objeto salió de un `list()`. Pedir el nombre al objeto sería devolver
    cadena vacía justo en el camino del rename, que es el único que lo necesita.
    """
    return str(info.get("Name") or "").lstrip("/")


async def _tamanos_de_contenedores(docker: aiodocker.Docker) -> tuple[dict[str, int], bool]:
    """El `SizeRw` de cada contenedor, indexado por **nombre**, desde `/system/df`.

    Se indexa por nombre y no por id porque el preaviso trabaja con nombres, que
    es lo que el usuario reconoce, y porque `/system/df` trae `Names` pero un id
    corto que no siempre coincide con el `Id` completo.

    El segundo valor de la tupla es si la forma se reconoce. `Containers` ausente
    no es «cero tamaño»: es una forma que no se sabe leer, y leerla como vacía
    daría un 0 que el panel presentaría como un hecho.
    """
    try:
        df = await docker._query_json("system/df")
    except Exception:
        return {}, False

    if not isinstance(df, dict) or "Containers" not in df:
        return {}, False

    tamanos: dict[str, int] = {}
    for entrada in df.get("Containers") or []:
        if not isinstance(entrada, dict):
            continue
        nombres = entrada.get("Names") or []
        nombre = str(nombres[0]).lstrip("/") if nombres else str(entrada.get("Id") or "")[:12]
        if not nombre:
            continue
        tamanos[nombre] = int(entrada.get("SizeRw") or 0)
    return tamanos, True


class ContainerService:
    @staticmethod
    async def preview_prune(docker: aiodocker.Docker) -> ContainerPrunePreview:
        """Qué contenedores parados hay y lo que ocupan (SPEC-21).

        **Dos fuentes y no una**, que es lo que hace este método menos obvious de
        lo escrito:

        - **Quién está parado** sale de `GET /containers/json`.
        - **Cuánto ocupa** sólo está en `GET /system/df` → `Containers[]` →
          `SizeRw`. En `/containers/json` la clave **no existe** (medido en el
          daemon 29.8.2: `None`), así que un preaviso que la leyera de ahí
          daría 0 para todo y parecería que los contenedores no ocupan nada.

        Y si el `df` no responde, o si su forma no es la que se conoce, se
        responde `503`. Un `0` aquí sería una afirmación sobre el disco del host
        que el panel no puede sostener: es el mismo `usage_known` de SPEC-08.
        """
        try:
            contenedores = await docker.containers.list(all=True)
        except DockerError as e:
            raise HTTPException(
                status_code=503,
                detail=f"No se pudo leer los contenedores para el preaviso: {docker_error_message(e)}",
            ) from e

        parados: list[str] = []
        for c in contenedores:
            info = _get_container_dict(c)
            if str(info.get("State") or "") == "running":
                continue
            nombres = info.get("Names") or []
            parados.append(str(nombres[0]).lstrip("/") if nombres else str(info.get("Id") or "")[:12])

        tamano_por_id, conocido = await _tamanos_de_contenedores(docker)
        if not conocido:
            raise HTTPException(
                status_code=503,
                detail=(
                    "El daemon no informó del tamaño de los contenedores, así que no se "
                    "puede decir cuánto se recuperaría. La limpieza está disponible, pero "
                    "su cifra no."
                ),
            )

        bytes_total = sum(tamano_por_id.get(n, 0) for n in parados)
        return ContainerPrunePreview(
            stopped_count=len(parados),
            stopped_bytes=bytes_total,
            stopped_names=parados,
        )

    @staticmethod
    async def prune_containers(docker: aiodocker.Docker) -> ContainerPruneResult:
        """Pide al daemon que elimine los contenedores parados (SPEC-21).

        Se lleva la **capa de escritura** de cada uno, que es justo lo que un
        contenedor parado puede tener dentro. Por eso el `deleted` lleva nombres:
        un id no lo reconoce nadie.

        No hay `force` y no se echa de menos: el prune del daemon no borra nada
        que esté en marcha, y esa es la garantía que hace esto aceptable. La que
        no da es que lo que está parado sea prescindible, y por eso el diálogo
        enseña los nombres antes de preguntar.
        """
        try:
            raw = await docker.containers.prune()
        except DockerError as e:
            raise HTTPException(
                status_code=503, detail=f"Error al limpiar los contenedores: {docker_error_message(e)}"
            ) from e
        except Exception as e:
            raise HTTPException(
                status_code=500, detail=f"Error inesperado al limpiar los contenedores: {e!s}"
            ) from e

        borrados = [str(v)[:12] for v in (raw or {}).get("ContainersDeleted") or []]
        reclaimed = int((raw or {}).get("SpaceReclaimed") or 0)
        if not borrados:
            message = "No hay contenedores parados: nada que limpiar"
        else:
            plural = "s" if len(borrados) != 1 else ""
            message = (
                f"{len(borrados)} contenedor{plural} parado{plural} eliminado{plural}: "
                f"{', '.join(borrados)}"
            )
        return ContainerPruneResult(deleted=borrados, bytes_reclaimed=reclaimed, message=message)

    @staticmethod
    async def buscar_para_series(
        docker: aiodocker.Docker, container_id: str
    ) -> tuple[str, str, bool] | None:
        """Localiza un contenedor y devuelve `(id_corto, nombre, en_marcha)`.

        **Un** `list(all=True)` y de ahí salen las tres cosas. No es una
        comodidad: existe para que pedir el historial cueste una llamada, y no
        una por dato. Se acepta el nombre además del id porque el panel lo tiene
        de las dos formas y `get()` por nombre es un 404 si no existe.

        Devuelve `None` si no hay ningún contenedor con ese id o nombre, y de
        eso se encarga la ruta a responder un 404 legible.
        """
        contenedores = await docker.containers.list(all=True)
        for c in contenedores:
            info = _get_container_dict(c)
            cid = str(info.get("Id") or getattr(c, "id", "") or "")
            nombres = {str(n).lstrip("/") for n in (info.get("Names") or [])}
            if container_id not in {cid, cid[:12]} and container_id not in nombres:
                continue
            corto = cid[:12] if len(cid) > 12 else cid
            nombre = next(iter(nombres), "") or corto
            return corto, nombre, str(info.get("State") or "") == "running"
        return None

    @staticmethod
    async def list_containers(
        docker: aiodocker.Docker,
        all: bool = True,
        status: str | None = None,
        health: list[str] | None = None,
    ) -> list[ContainerSummary]:
        try:
            filters = {}
            if status:
                filters["status"] = [status]
            # El filtro de salud lo pone el daemon, no la vista: `filters.health`
            # existe en la API y quien filtra son las peticiones (SPEC-18 §3.2).
            # Se acepta una lista porque "Con problemas" son dos estados:
            # `unhealthy` (ya falló) y `starting` (dentro del start_period, aún
            # no se sabe). Docker los une con OR dentro del mismo filtro.
            if health:
                filters["health"] = list(health)

            raw_containers = await docker.containers.list(all=all, filters=filters)
            store = get_store()
            summaries = []
            for c in raw_containers:
                info = _get_container_dict(c)
                cid = str(info.get("Id") or getattr(c, "id", "unknown"))
                names = info.get("Names") or []
                name = names[0].lstrip("/") if names else cid[:12]
                state = info.get("State", "unknown")
                status_str = info.get("Status", state)

                summaries.append(
                    ContainerSummary(
                        id=cid[:12] if len(cid) > 12 else cid,
                        name=name,
                        image=info.get("Image", "unknown"),
                        status=state,
                        state=status_str,
                        created=_parse_created_timestamp(info.get("Created")),
                        ports=_parse_port_mappings(info.get("Ports", [])),
                        # Proyecto compose al que pertenece, si la etiqueta existe
                        # (SPEC-11). `None` en un contenedor normal.
                        compose_project=compose_project_of(info.get("Labels")),
                        # El listado ya trae `Health` con status y contador, así
                        # que esto no cuesta ni una llamada: no hay un `show()`
                        # por contenedor (SPEC-18 §3.1).
                        health=_health_de_listado(info),
                        # Y `observed` tampoco: es una consulta al diccionario
                        # en memoria del almacén de métricas (SPEC-17 §4.9).
                        observed=store.is_observed(cid[:12] if len(cid) > 12 else cid),
                    )
                )
            return summaries
        except DockerError as e:
            raise HTTPException(
                status_code=docker_error_status(e),
                detail=f"Error al conectar con Docker daemon: {e.message}",
            ) from e
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=503, detail=f"No se pudo conectar con Docker: {e!s}") from e

    @staticmethod
    async def get_container(docker: aiodocker.Docker, container_id: str) -> ContainerDetail:
        try:
            container = await docker.containers.get(container_id)
            info = await container.show()

            config = info.get("Config", {})
            state_info = info.get("State", {})
            network_settings = info.get("NetworkSettings", {})
            host_config = info.get("HostConfig", {})

            ports = []
            port_bindings = host_config.get("PortBindings") or {}
            for container_port, bindings in port_bindings.items():
                priv_port, proto = container_port.split("/") if "/" in container_port else (container_port, "tcp")
                if bindings:
                    for b in bindings:
                        ports.append(
                            PortMapping(
                                ip=b.get("HostIp", "0.0.0.0"),
                                private_port=int(priv_port),
                                public_port=int(b.get("HostPort", 0)) if b.get("HostPort") else None,
                                type=proto,
                            )
                        )
                else:
                    ports.append(
                        PortMapping(
                            ip="0.0.0.0",
                            private_port=int(priv_port),
                            public_port=None,
                            type=proto,
                        )
                    )

            networks = list((network_settings.get("Networks") or {}).keys())
            name = info.get("Name", f"/{container_id}").lstrip("/")
            cid = str(info.get("Id") or container_id)

            return ContainerDetail(
                id=cid[:12] if len(cid) > 12 else cid,
                name=name,
                image=config.get("Image", "unknown"),
                status=state_info.get("Status", "unknown"),
                state=state_info.get("Status", "unknown"),
                created=_parse_created_timestamp(info.get("Created")),
                ports=ports,
                command=" ".join(config.get("Cmd", [])) if config.get("Cmd") else None,
                env=config.get("Env", []),
                labels=config.get("Labels") or {},
                mounts=info.get("Mounts", []),
                networks=networks,
                # El detalle **reemplaza** el `health` heredado por el del
                # inspect, que es el único con `Log`. Si se usara el del
                # listado, el historial saldría siempre vacío (SPEC-18 §2.1).
                health=_health_de_inspect(info),
            )
        except DockerError as e:
            if e.status == 404:
                raise HTTPException(status_code=404, detail=f"Contenedor {container_id} no encontrado") from e
            raise HTTPException(status_code=docker_error_status(e), detail=docker_error_message(e)) from e
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Error al inspeccionar contenedor: {e!s}") from e

    @staticmethod
    async def get_logs_snapshot(
        docker: aiodocker.Docker,
        container_id: str,
        tail: int = 100,
        timestamps: bool = True,
    ) -> LogSnapshotResponse:
        try:
            container = await docker.containers.get(container_id)
            # Mismo camino desmultiplexado que el stream en vivo, para que el
            # snapshot inicial y lo que llega después no se contradigan: si el
            # snapshot clasificara por el texto y el stream por el byte de
            # cabecera, una línea cambiaría de stream a mitad de la vista.
            entries = [
                _entrada_de_log(linea, _NOMBRES_STREAM.get(stream, "stdout"), timestamps)
                async for stream, linea in _stream_demultiplexado(
                    docker, container, tail=tail, timestamps=timestamps, follow=False
                )
            ]
            return LogSnapshotResponse(
                id=container_id,
                total_lines=len(entries),
                lines=entries,
            )
        except DockerError as e:
            if e.status == 404:
                raise HTTPException(status_code=404, detail=f"Contenedor {container_id} no encontrado") from e
            raise HTTPException(status_code=docker_error_status(e), detail=docker_error_message(e)) from e
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Error al obtener logs: {e!s}") from e

    @staticmethod
    async def stream_logs(
        docker: aiodocker.Docker,
        container_id: str,
        tail: int = 100,
        timestamps: bool = True,
        follow: bool = True,
    ) -> AsyncIterator[LogEntry]:
        try:
            container = await docker.containers.get(container_id)
            # Camino con el stream real: cada línea llega con su stream del byte
            # de cabecera de Docker, sin adivinar por el texto.
            async for stream, linea in _stream_demultiplexado(
                docker,
                container,
                tail=tail,
                timestamps=timestamps,
                follow=follow,
            ):
                yield _entrada_de_log(linea, _NOMBRES_STREAM.get(stream, "stdout"), timestamps)
        except DockerError as e:
            if e.status == 404:
                raise HTTPException(status_code=404, detail=f"Contenedor {container_id} no encontrado") from e
            raise HTTPException(status_code=docker_error_status(e), detail=docker_error_message(e)) from e

    @staticmethod
    async def start_container(docker: aiodocker.Docker, container_id: str) -> ContainerActionResponse:
        try:
            container = await docker.containers.get(container_id)
            await container.start()
            return ContainerActionResponse(
                id=container_id,
                action="start",
                success=True,
                message=f"Contenedor {container_id} iniciado correctamente",
            )
        except DockerError as e:
            if e.status == 404:
                raise HTTPException(status_code=404, detail=f"Contenedor {container_id} no encontrado") from e
            if e.status in [409, 304]:
                return ContainerActionResponse(
                    id=container_id, action="start", success=True, message="El contenedor ya estaba iniciado"
                )
            raise HTTPException(status_code=docker_error_status(e), detail=docker_error_message(e)) from e

    @staticmethod
    async def stop_container(
        docker: aiodocker.Docker, container_id: str, timeout: int = 10
    ) -> ContainerActionResponse:
        try:
            container = await docker.containers.get(container_id)
            await container.stop(t=timeout)
            return ContainerActionResponse(
                id=container_id,
                action="stop",
                success=True,
                message=f"Contenedor {container_id} detenido correctamente",
            )
        except DockerError as e:
            if e.status == 404:
                raise HTTPException(status_code=404, detail=f"Contenedor {container_id} no encontrado") from e
            if e.status == 304:
                return ContainerActionResponse(
                    id=container_id, action="stop", success=True, message="El contenedor ya estaba detenido"
                )
            raise HTTPException(status_code=docker_error_status(e), detail=docker_error_message(e)) from e

    @staticmethod
    async def restart_container(
        docker: aiodocker.Docker, container_id: str, timeout: int = 10
    ) -> ContainerActionResponse:
        try:
            container = await docker.containers.get(container_id)
            await container.restart(t=timeout)
            return ContainerActionResponse(
                id=container_id,
                action="restart",
                success=True,
                message=f"Contenedor {container_id} reiniciado correctamente",
            )
        except DockerError as e:
            if e.status == 404:
                raise HTTPException(status_code=404, detail=f"Contenedor {container_id} no encontrado") from e
            raise HTTPException(status_code=docker_error_status(e), detail=docker_error_message(e)) from e

    @staticmethod
    async def pause_container(docker: aiodocker.Docker, container_id: str) -> ContainerActionResponse:
        try:
            container = await docker.containers.get(container_id)
            await container.pause()
            return ContainerActionResponse(
                id=container_id,
                action="pause",
                success=True,
                message=f"Contenedor {container_id} pausado correctamente",
            )
        except DockerError as e:
            if e.status == 404:
                raise HTTPException(status_code=404, detail=f"Contenedor {container_id} no encontrado") from e
            raise HTTPException(status_code=docker_error_status(e), detail=docker_error_message(e)) from e

    @staticmethod
    async def unpause_container(docker: aiodocker.Docker, container_id: str) -> ContainerActionResponse:
        try:
            container = await docker.containers.get(container_id)
            await container.unpause()
            return ContainerActionResponse(
                id=container_id,
                action="unpause",
                success=True,
                message=f"Contenedor {container_id} reactivado correctamente",
            )
        except DockerError as e:
            if e.status == 404:
                raise HTTPException(status_code=404, detail=f"Contenedor {container_id} no encontrado") from e
            raise HTTPException(status_code=docker_error_status(e), detail=docker_error_message(e)) from e

    @staticmethod
    async def rename_container(
        docker: aiodocker.Docker, container_id: str, nombre: str
    ) -> RenameContainerResponse:
        """Cambia el nombre de un contenedor.

        Es barato a propósito: **no hay recreate**, así que el identificador, el
        estado y los volúmenes se quedan como están. Sólo cambia `Name`, y el
        panel identifica los contenedores por id, de modo que ninguna WebSocket
        abierta ni ningún enlace se rompen.

        No bloquea contenedores de compose porque no hace falta: compose
        identifica los suyos por **etiquetas**, no por nombre, y sigue
        funcionando tras el renombrado —`up` sigue siendo idempotente y `down` lo
        borra bien, incluso con `container_name:` explícito (SPEC-19 §3.4). Lo
        que no se hace es tocar esas etiquetas: describen el archivo, no este
        cambio.
        """
        limpio = (nombre or "").strip()
        _validar_nombre_contenedor(limpio)

        try:
            container = await docker.containers.get(container_id)
            anterior = _nombre_actual(await container.show())

            if limpio == anterior:
                # El daemon lo rechaza con un 400 críptico ("Renaming a container
                # with the same name as its current name"). Merece un mensaje.
                raise HTTPException(
                    status_code=400, detail=f"El contenedor ya se llama '{anterior}'."
                )

            await container.rename(limpio)
        except HTTPException:
            raise
        except DockerError as e:
            if e.status == 404:
                raise HTTPException(
                    status_code=404, detail=f"Contenedor {container_id} no encontrado"
                ) from e
            if e.status == 409:
                # El mensaje del daemon incluye el id del contenedor que ocupa el
                # nombre, que el usuario nunca ve. Se traduce (SPEC-19 §3.5).
                ocupado = _nombre_del_conflicto(e)
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"Ya existe un contenedor llamado '{ocupado}'."
                        if ocupado
                        else "Ya existe un contenedor con ese nombre."
                    ),
                ) from e
            if e.status == 400:
                raise HTTPException(
                    status_code=400,
                    detail=f"El daemon rechazó el nombre: {docker_error_message(e)}",
                ) from e
            raise HTTPException(
                status_code=docker_error_status(e),
                detail=f"Error al renombrar el contenedor: {docker_error_message(e)}",
            ) from e

        return RenameContainerResponse(
            id=container_id,
            old_name=anterior,
            new_name=limpio,
            message=f"Contenedor renombrado a '{limpio}'",
        )

    @staticmethod
    async def remove_container(
        docker: aiodocker.Docker, container_id: str, force: bool = False, v: bool = False
    ) -> ContainerActionResponse:
        try:
            container = await docker.containers.get(container_id)
            await container.delete(force=force, v=v)
            return ContainerActionResponse(
                id=container_id,
                action="remove",
                success=True,
                message=f"Contenedor {container_id} eliminado correctamente",
            )
        except DockerError as e:
            if e.status == 404:
                raise HTTPException(status_code=404, detail=f"Contenedor {container_id} no encontrado") from e
            if e.status == 409:
                raise HTTPException(
                    status_code=409,
                    detail=f"Conflicto al eliminar contenedor {container_id}: {e.message}",
                ) from e
            raise HTTPException(status_code=docker_error_status(e), detail=docker_error_message(e)) from e

    @staticmethod
    async def create_container(
        docker: aiodocker.Docker, payload: CreateContainerRequest
    ) -> CreateContainerResponse:
        # La referencia se valida antes de tocar el daemon, igual que hace el
        # canal WebSocket de descarga. Antes esta ruta la pasaba tal cual a
        # `images.inspect`, `images.pull` y `containers.create`: la misma
        # operación validada por un lado y sin validar por el otro.
        try:
            image_ref = normalize_image_ref(payload.image)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

        try:
            # 1. Verificar si la imagen existe localmente; si no, intentar descargarla
            try:
                await docker.images.inspect(image_ref)
            except DockerError as e:
                if e.status == 404:
                    try:
                        await docker.images.pull(image_ref)
                    except DockerError as pull_err:
                        raise HTTPException(
                            status_code=404,
                            detail=(
                                f"No se pudo descargar la imagen '{image_ref}': "
                                f"{docker_error_message(pull_err)}"
                            ),
                        ) from pull_err

            # 2. Configuración de puertos
            exposed_ports = {}
            port_bindings = {}
            for p in payload.ports:
                key = f"{p.container_port}/{p.protocol}"
                exposed_ports[key] = {}
                port_bindings[key] = [{"HostPort": str(p.host_port), "HostIp": "0.0.0.0"}]

            # 3. Configuración de volúmenes
            binds = [f"{v.host_path}:{v.container_path}:{v.mode}" for v in payload.volumes]

            # 4. Variables de entorno
            env_list = [f"{k}={v}" for k, v in payload.env.items()]

            # 5. Configuración del contenedor
            config: dict[str, Any] = {
                "Image": image_ref,
                "Env": env_list,
                "ExposedPorts": exposed_ports,
                "HostConfig": {
                    "PortBindings": port_bindings,
                    "Binds": binds,
                    "RestartPolicy": {"Name": payload.restart_policy},
                },
            }
            if payload.command:
                try:
                    config["Cmd"] = shlex.split(payload.command)
                except ValueError as error:
                    # Comillas sin cerrar: es un error de lo que escribió el
                    # usuario, no un fallo del daemon.
                    raise HTTPException(
                        status_code=400,
                        detail=f"El comando no tiene comillas balanceadas: {error}",
                    ) from error

            # 6. Crear contenedor
            container = await docker.containers.create(config=config, name=payload.name)

            # 7. Iniciar si se solicitó
            started = False
            status = "created"
            if payload.start_now:
                try:
                    await container.start()
                except BaseException:
                    # El `start` puede fallar por el puerto ocupado, por la red
                    # que no existe, por el mount que no está... y el contenedor
                    # ya está creado para entonces. Sin esta limpieza el usuario
                    # se llevaba un 500 y un contenedor en estado `created` que no
                    # pidió: después aparecía en la lista, contaba en el
                    # `/system/df` y se lo podia llevar un prune.
                    try:
                        await container.delete(force=True)
                    except Exception:
                        pass
                    raise
                started = True
                status = "running"

            cid = str(getattr(container, "id", None) or (await container.show()).get("Id", "unknown"))
            assigned_name = payload.name or cid[:12]

            return CreateContainerResponse(
                id=cid[:12] if len(cid) > 12 else cid,
                name=assigned_name,
                image=image_ref,
                status=status,
                started=started,
                message=f"Contenedor '{assigned_name}' creado exitosamente",
            )
        except DockerError as e:
            if e.status == 409:
                raise HTTPException(
                    status_code=409,
                    detail=f"Conflicto al crear contenedor: {e.message}",
                ) from e
            raise HTTPException(status_code=docker_error_status(e), detail=docker_error_message(e)) from e
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Error inesperado al crear contenedor: {e!s}") from e

