# SPDX-License-Identifier: AGPL-3.0-or-later
import inspect
import re
import shlex
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any

import aiodocker
from aiodocker.exceptions import DockerError
from fastapi import HTTPException

from app.core.docker import docker_error_message, docker_error_status
from app.schemas.container import (
    ContainerActionResponse,
    ContainerDetail,
    ContainerSummary,
    CreateContainerRequest,
    CreateContainerResponse,
    PortMapping,
)
from app.schemas.log import LogEntry, LogSnapshotResponse
from app.services.compose_service import compose_project_of
from app.services.image_service import normalize_image_ref


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

    `timestamps` importa: es el flag que se le pasó a `container.log()`, así que
    el parser sabe si puede haber un timestamp delante. Sin esa pista, el sniff
    anterior se comía el primer token de cualquier línea normal que contuviera
    una `T` y un signo: `"T-shirt S-M: 42 items"` salía como timestamp `T-shirt:`
    y mensaje `S-M: 42 items`.
    """
    clean = raw_line.rstrip("\r\n")
    message = clean
    timestamp: str | None = None

    if timestamps:
        parts = clean.split(" ", 1)
        if len(parts) == 2 and _TIMESTAMP_RE.match(parts[0]):
            timestamp = parts[0]
            message = parts[1]

    stream = default_stream
    if _es_stderr(message):
        stream = "stderr"

    return LogEntry(timestamp=timestamp, stream=stream, message=message)


def _es_stderr(message: str) -> bool:
    """Distingue stderr de stdout por la marca de Docker o por el prefijo.

    El frame multiplexado de Docker **sí** lleva el stream en el byte de
    cabecera, pero aiodocker lo descarta (`MultiplexedResult` lee el `>BxxxL` y
    tira el byte). Así que desde aquí no hay forma de saberlo con certeza y esto
    es, sí o sí, una heurística sobre el texto.

    Se prefiere la falsa negativa a la falsa positiva: se marca como stderr
    cuando la línea lleva marca explícita (`[stderr]`, `ERROR:`, `FATAL:`...), y
    una frase normal que empiece por "Error" se queda en stdout. Antes se
    buscaban las palabras "error" o "fatal" en los primeros 25 caracteres, lo
    que arrastraba a stderr líneas como "Error handled gracefully by middleware"
    y las sacaba del filtro de stdout del visor.
    """
    return bool(_STDERR_RE.match(message.lower()))


class ContainerService:
    @staticmethod
    async def list_containers(
        docker: aiodocker.Docker,
        all: bool = True,
        status: str | None = None,
    ) -> list[ContainerSummary]:
        try:
            filters = {}
            if status:
                filters["status"] = [status]

            raw_containers = await docker.containers.list(all=all, filters=filters)
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
            res = container.log(
                stdout=True, stderr=True, follow=False, tail=tail, timestamps=timestamps
            )
            raw_lines = await res if inspect.iscoroutine(res) else res

            entries = [parse_docker_log_line(line, timestamps=timestamps) for line in raw_lines]
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
            res = container.log(
                stdout=True, stderr=True, follow=follow, tail=tail, timestamps=timestamps
            )
            stream = await res if inspect.iscoroutine(res) else res
            async for raw_line in stream:
                yield parse_docker_log_line(raw_line, timestamps=timestamps)
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

