# SPDX-License-Identifier: AGPL-3.0-or-later
import asyncio
import inspect
import json
import shlex
import time
from contextlib import aclosing
from pathlib import Path
from typing import Annotated

import aiodocker
from aiodocker.exceptions import DockerError
from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect

from app.core.docker import docker_error_message, get_docker
from app.schemas.compose import (
    ComposeCommandError,
    ComposeCommandStart,
    ComposeExit,
    ComposeOutput,
)
from app.schemas.image import ImagePullMessage
from app.services import compose_cli
from app.services.container_service import parse_docker_log_line
from app.services.image_service import ImageService, normalize_image_ref
from app.services.stats_service import StatsService

DockerDep = Annotated[aiodocker.Docker, Depends(get_docker)]

router = APIRouter(prefix="/ws", tags=["websockets"])


@router.websocket("/containers/{container_id}/logs")
async def container_logs_ws(
    docker: DockerDep,
    websocket: WebSocket,
    container_id: str,
    tail: int = Query(100),
    timestamps: bool = Query(True),
    follow: bool = Query(True),
):
    """Canal WebSocket para streaming de logs de contenedores en tiempo real."""
    await websocket.accept()

    try:
        container = await docker.containers.get(container_id)
        info = await container.show()
        c_name = info.get("Name", f"/{container_id}").lstrip("/")
    except DockerError as e:
        if e.status == 404:
            await websocket.close(code=4404, reason="Contenedor no encontrado")
            return
        await websocket.close(code=1011, reason=str(e))
        return
    except Exception as e:
        await websocket.close(code=1011, reason=str(e))
        return

    # Mensaje inicial del sistema
    try:
        await websocket.send_json(
            {
                "timestamp": None,
                "stream": "system",
                "message": f"--- Conectado al stream de logs de [{c_name}] ---",
            }
        )
    except Exception:
        return

    try:
        res = container.log(
            stdout=True, stderr=True, follow=follow, tail=tail, timestamps=timestamps
        )
        stream = await res if inspect.iscoroutine(res) else res
        async for line in stream:
            entry = parse_docker_log_line(line)
            await websocket.send_json(entry.model_dump())
    except WebSocketDisconnect:
        # Desconexión limpia del cliente web
        pass
    except Exception as e:
        try:
            await websocket.send_json(
                {
                    "timestamp": None,
                    "stream": "system",
                    "message": f"--- Stream finalizado: {e!s} ---",
                }
            )
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


@router.websocket("/containers/{container_id}/stats")
async def container_stats_ws(
    docker: DockerDep,
    websocket: WebSocket,
    container_id: str,
):
    """Canal WebSocket para streaming continuo de métricas (CPU, RAM, Red, Disco)."""
    await websocket.accept()

    try:
        container = await docker.containers.get(container_id)
        info = await container.show()
        c_name = info.get("Name", f"/{container_id}").lstrip("/")
    except DockerError as e:
        if e.status == 404:
            await websocket.close(code=4404, reason="Contenedor no encontrado")
            return
        await websocket.close(code=1011, reason=str(e))
        return
    except Exception as e:
        await websocket.close(code=1011, reason=str(e))
        return

    try:
        # aclosing garantiza el cierre del generador de Docker y la liberación del socket
        # underlying en cuanto el cliente se desconecta.
        stats_stream = StatsService.stream_stats(container, container_id, c_name)
        async with aclosing(stats_stream):
            async for stats in stats_stream:
                await websocket.send_json(stats.model_dump())
    except WebSocketDisconnect:
        # Desconexión limpia del cliente web
        pass
    except Exception as e:
        try:
            await websocket.send_json(
                {"error": f"Stream de estadísticas finalizado: {e!s}"}
            )
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


@router.websocket("/images/pull")
async def image_pull_ws(
    websocket: WebSocket,
    docker: DockerDep,
    image: str = Query(..., description="Referencia de imagen a descargar"),
):
    """Canal WebSocket para descargar una imagen emitiendo el progreso por capa."""
    await websocket.accept()

    # Se valida antes de contactar con el daemon: una referencia malformada
    # receives un error y no lanza ninguna descarga.
    try:
        image_ref = normalize_image_ref(image)
    except ValueError as e:
        await websocket.send_json(
            ImagePullMessage(type="error", image=image, code=400, message=str(e)).model_dump()
        )
        await websocket.close(code=1000)
        return

    await websocket.send_json(ImagePullMessage(type="start", image=image_ref).model_dump())

    try:
        # aclosing garantiza que el stream de aiodocker se cierre al terminar
        # o al desconectarse el cliente, liberando la respuesta HTTP.
        pull_stream = ImageService.stream_pull(docker.images, image_ref)
        async with aclosing(pull_stream):
            async for message in pull_stream:
                await websocket.send_json(message.model_dump())

        tags = [image_ref]
        await websocket.send_json(
            ImagePullMessage(
                type="done", image=image_ref, id=image_ref, tags=tags
            ).model_dump()
        )
    except WebSocketDisconnect:
        # El cliente canceló la descarga cerrando el socket
        pass
    except DockerError as e:
        # Los errores del registro llegan como DockerError durante la iteración,
        # no como DockerStreamError (aiodocker 0.27.0).
        try:
            await websocket.send_json(
                ImagePullMessage(
                    type="error",
                    image=image_ref,
                    code=e.status,
                    message=docker_error_message(e),
                ).model_dump()
            )
        except Exception:
            pass
    except Exception as e:
        try:
            await websocket.send_json(
                ImagePullMessage(
                    type="error", image=image_ref, code=500, message=str(e)
                ).model_dump()
            )
        except Exception:
            pass
    finally:
        try:
            await websocket.close(code=1000)
        except Exception:
            pass


@router.websocket("/containers/{container_id}/terminal")
async def container_terminal_ws(
    docker: DockerDep,
    websocket: WebSocket,
    container_id: str,
    shell: str = Query("/bin/sh"),
    user: str = Query(""),
    cols: int = Query(80),
    rows: int = Query(24),
):
    """Canal WebSocket para sesión de terminal interactiva (exec TTY) en un contenedor."""
    await websocket.accept()

    try:
        container = await docker.containers.get(container_id)
        info = await container.show()
    except DockerError as e:
        if e.status == 404:
            await websocket.close(code=4404, reason="Contenedor no encontrado")
            return
        await websocket.close(code=1011, reason=str(e))
        return
    except Exception as e:
        await websocket.close(code=1011, reason=str(e))
        return

    state = info.get("State", {})
    is_running = state.get("Running", False) if isinstance(state, dict) else False
    if not is_running:
        await websocket.close(code=4400, reason="El contenedor no está en ejecución")
        return

    cmd = [shell]
    if " " in shell:
        cmd = shlex.split(shell)

    try:
        exec_instance = await container.exec(
            cmd=cmd,
            stdout=True,
            stderr=True,
            stdin=True,
            tty=True,
            user=user if user else "",
        )
    except DockerError as e:
        if shell != "/bin/sh":
            try:
                exec_instance = await container.exec(
                    cmd=["/bin/sh"],
                    stdout=True,
                    stderr=True,
                    stdin=True,
                    tty=True,
                    user=user if user else "",
                )
            except Exception:
                await websocket.close(code=4400, reason=f"No se pudo iniciar la shell: {e!s}")
                return
        else:
            await websocket.close(code=4400, reason=f"No se pudo iniciar la shell: {e!s}")
            return
    except Exception as e:
        await websocket.close(code=4400, reason=f"Error al iniciar exec: {e!s}")
        return

    stream = exec_instance.start()
    try:
        await stream._init()
    except Exception as e:
        await websocket.close(code=4400, reason=f"Error al inicializar stream: {e!s}")
        return

    try:
        await exec_instance.resize(w=int(cols), h=int(rows))
    except Exception:
        pass

    c_name = info.get("Name", f"/{container_id}").lstrip("/")
    try:
        await websocket.send_json(
            {
                "type": "system",
                "data": f"--- Conectado a la terminal de [{c_name}] ({shell}) ---\r\n",
            }
        )
    except Exception:
        return

    async def docker_to_ws():
        try:
            while True:
                msg = await stream.read_out()
                if msg is None:
                    break
                data_bytes = (
                    msg.data
                    if isinstance(msg.data, bytes)
                    else str(msg.data).encode("utf-8", errors="replace")
                )
                text = data_bytes.decode("utf-8", errors="replace")
                await websocket.send_json({"type": "stdout", "data": text})
        except Exception:
            pass

    async def ws_to_docker():
        try:
            while True:
                raw_msg = await websocket.receive_text()
                try:
                    payload = json.loads(raw_msg, strict=False)
                except Exception:
                    payload = {"type": "stdin", "data": raw_msg}

                if not isinstance(payload, dict):
                    payload = {"type": "stdin", "data": str(payload)}

                msg_type = payload.get("type", "stdin")
                if msg_type == "stdin":
                    data_str = payload.get("data", "")
                    if data_str:
                        await stream.write_in(data_str.encode("utf-8"))
                elif msg_type == "resize":
                    new_cols = payload.get("cols")
                    new_rows = payload.get("rows")
                    if new_cols and new_rows:
                        try:
                            await exec_instance.resize(w=int(new_cols), h=int(new_rows))
                        except Exception:
                            pass
        except (WebSocketDisconnect, Exception):
            pass

    reader_task = asyncio.create_task(docker_to_ws())
    writer_task = asyncio.create_task(ws_to_docker())

    try:
        _done, pending = await asyncio.wait(
            [reader_task, writer_task],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
    finally:
        try:
            await stream.close()
        except Exception:
            pass
        try:
            await websocket.close(code=1000)
        except Exception:
            pass



# --- SPEC-13: ciclo de vida de un proyecto compose -----------------------------

# Código de salida de una acción cancelada. El proceso recibe SIGKILL, así que no
# tiene un código "real" que reportar: -1 significa "terminado porque alguien lo
# paró", no "falló". La UI ya sabe que el usuario lo canceló, así que no tiene que
# interpretar el número.
CODIGO_CANCELADO = -1


@router.websocket("/compose/{action}")
async def compose_accion_ws(
    websocket: WebSocket,
    action: str,
    docker: DockerDep,
    path: str = Query(..., description="Ruta absoluta del archivo compose"),
    project_name: str | None = Query(None, description="Nombre de proyecto (-p)"),
    service: str | None = Query(None, description="Servicio, como argumento posicional"),
    follow: bool = Query(True, description="Solo para logs: seguir la salida"),
    volumes: bool = Query(False, description="Solo para down: añade --volumes"),
):
    """Canal único para las cinco acciones del ciclo de vida.

    **Un endpoint y no cinco** a propósito: cinco handlers casi idénticos serían
    cinco sitios donde olvidar el `finally` que mata el proceso, y este tiene uno
    solo (SPEC-13 §3.2).

    Las validaciones van en un orden deliberado, porque el orden es la diferencia
    entre un error útil y uno inútil: primero la acción, luego la ruta, y solo
    después se comprueba el `409`. Un `404` de acción desconocida no debería
    costar una llamada al sistema de archivos.
    """
    await websocket.accept()

    # 1. La acción contra la lista cerrada, antes de leer nada.
    if action not in compose_cli.TIMEOUTS_S:
        await _ws_error(websocket, 404, f"Acción no soportada: '{action}'")
        return

    # 2. La ruta, con el mismo criterio que SPEC-12: una relativa se resolvería
    #    contra el directorio del backend, no contra el del usuario.
    if not path.startswith("/"):
        await _ws_error(
            websocket,
            400,
            "La ruta debe ser absoluta. Una ruta relativa se resolvería contra "
            "el directorio del servidor, no contra el tuyo.",
        )
        return
    archivo = Path(path)
    if not archivo.is_file():
        await _ws_error(websocket, 404, f"No existe el archivo: {path}")
        return

    # 3. `down --volumes` es la única acción irreversible. Parar por sorpresa a
    #    los contenedores para después borrarles los volúmenes no es aceptable,
    #    así que se exige una parada explícita.
    if action == "down" and volumes:
        proyecto = project_name or _proyecto_por_defecto(archivo)
        if await _tiene_contenedores(docker, proyecto):
            await _ws_error(
                websocket,
                409,
                (
                    f"El proyecto '{proyecto}' tiene contenedores en marcha. Para "
                    "borrar sus volúmenes hay que pararlos antes: usa «Parar» y "
                    "luego vuelve a bajar el proyecto."
                ),
            )
            return

    # Se comprueba el CLI antes de nada: mandar un `start` con los argumentos
    # exactos de una acción que no va a ejecutarse sería mentir.
    if not compose_cli.hay_cli():
        await _ws_error(
            websocket,
            503,
            "No se encontró el binario 'docker'. DockPilot necesita el CLI de "
            "Docker Compose para operar un proyecto.",
        )
        return

    resultado = compose_cli.ResultadoAccion()
    try:
        generador = compose_cli.ejecutar_accion(
            action,
            archivo,
            resultado=resultado,
            project_name=project_name,
            service=service,
            follow=follow,
            volumes=volumes,
        )
    except ValueError as error:
        # Solo alcanzable si `action` no está en la lista, ya comprobada arriba.
        await _ws_error(websocket, 404, str(error))
        return

    inicio = time.monotonic()
    try:
        await websocket.send_json(
            ComposeCommandStart(
                action=action,
                project=project_name or _proyecto_por_defecto(archivo),
                path=path,
                command=compose_cli.argumentos_accion(
                    action,
                    path,
                    project_name=project_name,
                    service=service,
                    follow=follow,
                    volumes=volumes,
                ),
            ).model_dump()
        )
    except WebSocketDisconnect:
        return

    consumidor = asyncio.create_task(
        _ws_bombear(websocket, generador, action),
        name=f"compose-{action}-{path}",
    )
    vigia = asyncio.create_task(
        _ws_vigilar_cancel(websocket, consumidor),
        name=f"compose-vigia-{path}",
    )

    try:
        # `FIRST_COMPLETED`: o la acción termina sola, o el usuario cancela, o el
        # cliente cierra el socket. Las tres son el final del canal.
        await asyncio.wait({consumidor, vigia}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for tarea in (consumidor, vigia):
            tarea.cancel()
        await asyncio.gather(consumidor, vigia, return_exceptions=True)

    codigo = resultado.codigo
    if resultado.cancelada or codigo is None:
        codigo = CODIGO_CANCELADO

    duracion_ms = int((time.monotonic() - inicio) * 1000)
    try:
        await websocket.send_json(
            ComposeExit(
                action=action, code=codigo, duration_ms=duracion_ms
            ).model_dump()
        )
    except WebSocketDisconnect:
        pass
    # El proceso ya está muerto: si la acción terminó sola, el `finally` del
    # generador lo mató al agotarse; si se canceló, lo mató la cancelación de la
    # tarea consumidora. No hay nada que limpiar aquí y llamar a `_terminar`
    # sobre el generador no tendría sentido: no es un proceso.


async def _ws_bombear(
    websocket: WebSocket, generador: object, action: str
) -> None:
    """Vuelca la salida de la acción al socket, trozo a trozo."""
    try:
        async for trozo in generador:  # type: ignore[attr-defined]
            await websocket.send_json(
                ComposeOutput(stream=trozo.stream, data=trozo.data).model_dump()
            )
    except compose_cli.ComposeCliAusente as error:
        await _ws_error(websocket, 503, str(error))
    except compose_cli.ComposeCliTimeout:
        await _ws_error(
            websocket,
            504,
            f"La acción '{action}' superó su tiempo y se detuvo.",
        )
    except WebSocketDisconnect:
        raise


async def _ws_vigilar_cancel(websocket: WebSocket, consumidor: asyncio.Task) -> None:
    """Espera un `cancel` del cliente y corta al consumidor si llega.

    Cancelar es **cancelar la tarea consumidora**, no llamar a `aclose()`: un
    generador asíncrono que ya está leyendo no se puede cerrar por fuera, y el
    error sería "asynchronous generator is already running". Al cancelar la tarea
    el `GeneratorExit` salta dentro del generador y su `finally` mata el proceso.
    """
    try:
        while True:
            mensaje = await websocket.receive_json()
            if isinstance(mensaje, dict) and mensaje.get("type") == "cancel":
                consumidor.cancel()
                return
    except WebSocketDisconnect:
        # El cliente se fue: también hay que cortar.
        consumidor.cancel()
        raise


async def _ws_error(websocket: WebSocket, code: int, message: str) -> None:
    try:
        await websocket.send_json(ComposeCommandError(code=code, message=message).model_dump())
    except WebSocketDisconnect:
        pass


def _proyecto_por_defecto(archivo: Path) -> str:
    """Nombre de proyecto que compose deduciría del archivo: el directorio.

    Es la misma regla que aplica compose cuando no se le pasa `-p`. El panel
    normalmente **sí** manda `project_name` explícito, tomándolo del inventario
    de SPEC-11, así que esta deducción es solo el camino Manual del preview.
    """
    return archivo.resolve().parent.name.lower()


async def _tiene_contenedores(docker: aiodocker.Docker, proyecto: str) -> bool:
    """Si el proyecto tiene contenedores, sea cual sea su estado.

    Filtra por la etiqueta del proyecto, que es la única fuente fiable: el Engine
    API no sabe de proyectos compose. Ante cualquier error devuelve `False`, para
    que un fallo de lectura no bloquee una acción legítima: es el `409` una
    comodidad, no la única defensa, y la última defensa es la confirmación.
    """
    try:
        contenedores = await docker.containers.list(all=True)
    except DockerError:
        return False
    objetivo = proyecto.lower()
    for contenedor in contenedores:
        info = contenedor if isinstance(contenedor, dict) else getattr(contenedor, "_container", {})
        etiquetas = info.get("Labels") if isinstance(info, dict) else None
        if isinstance(etiquetas, dict) and etiquetas.get("com.docker.compose.project") == objetivo:
            return True
    return False
