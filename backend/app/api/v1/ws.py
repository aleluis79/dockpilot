# SPDX-License-Identifier: AGPL-3.0-or-later
import asyncio
import inspect
import json
import shlex
from contextlib import aclosing
from typing import Annotated

import aiodocker
from aiodocker.exceptions import DockerError
from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect

from app.core.docker import docker_error_message, get_docker
from app.schemas.image import ImagePullMessage
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

