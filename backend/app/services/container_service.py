# SPDX-License-Identifier: AGPL-3.0-or-later
import inspect
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any

import aiodocker
from aiodocker.exceptions import DockerError
from fastapi import HTTPException

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


def _get_container_dict(c: Any) -> dict:
    """Extrae el diccionario subyacente tanto de DockerContainer como de un dict ordinario."""
    if hasattr(c, "_container") and isinstance(c._container, dict):
        return c._container
    if isinstance(c, dict):
        return c
    return {}


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
    if isinstance(created_val, (int, float)):
        return int(created_val)
    if isinstance(created_val, str):
        try:
            clean_str = created_val.split(".")[0].rstrip("Z")
            return int(datetime.fromisoformat(clean_str).timestamp())
        except Exception:
            return 0
    return 0


def parse_docker_log_line(raw_line: str, default_stream: str = "stdout") -> LogEntry:
    """Parsea una línea cruda de log de Docker separando timestamp y stream."""
    clean = raw_line.rstrip("\r\n")
    parts = clean.split(" ", 1)
    timestamp: str | None = None
    message = clean

    # Detectar si la primera parte es un ISO-8601 timestamp (ej. 2026-09-25T20:24:39.154430789Z)
    if len(parts) == 2 and ("T" in parts[0] and (parts[0].endswith("Z") or "+" in parts[0] or "-" in parts[0])):
        timestamp = parts[0]
        message = parts[1]

    stream = default_stream
    msg_lower = message.lower()
    if msg_lower.startswith("[stderr]") or "error" in msg_lower[:25] or "fatal" in msg_lower[:25]:
        stream = "stderr"

    return LogEntry(timestamp=timestamp, stream=stream, message=message)


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
                status_code=503 if e.status >= 500 else e.status,
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
            raise HTTPException(status_code=e.status, detail=e.message) from e
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

            entries = [parse_docker_log_line(line) for line in raw_lines]
            return LogSnapshotResponse(
                id=container_id,
                total_lines=len(entries),
                lines=entries,
            )
        except DockerError as e:
            if e.status == 404:
                raise HTTPException(status_code=404, detail=f"Contenedor {container_id} no encontrado") from e
            raise HTTPException(status_code=e.status, detail=e.message) from e
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
                yield parse_docker_log_line(raw_line)
        except DockerError as e:
            if e.status == 404:
                raise HTTPException(status_code=404, detail=f"Contenedor {container_id} no encontrado") from e
            raise HTTPException(status_code=e.status, detail=e.message) from e

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
            raise HTTPException(status_code=e.status, detail=e.message) from e

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
            raise HTTPException(status_code=e.status, detail=e.message) from e

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
            raise HTTPException(status_code=e.status, detail=e.message) from e

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
            raise HTTPException(status_code=e.status, detail=e.message) from e

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
            raise HTTPException(status_code=e.status, detail=e.message) from e

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
            raise HTTPException(status_code=e.status, detail=e.message) from e

    @staticmethod
    async def create_container(
        docker: aiodocker.Docker, payload: CreateContainerRequest
    ) -> CreateContainerResponse:
        try:
            # 1. Verificar si la imagen existe localmente; si no, intentar descargarla
            try:
                await docker.images.inspect(payload.image)
            except DockerError as e:
                if e.status == 404:
                    try:
                        await docker.images.pull(payload.image)
                    except DockerError as pull_err:
                        raise HTTPException(
                            status_code=404,
                            detail=f"No se pudo descargar la imagen '{payload.image}': {pull_err.message}",
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
                "Image": payload.image,
                "Env": env_list,
                "ExposedPorts": exposed_ports,
                "HostConfig": {
                    "PortBindings": port_bindings,
                    "Binds": binds,
                    "RestartPolicy": {"Name": payload.restart_policy},
                },
            }
            if payload.command:
                config["Cmd"] = payload.command.split()

            # 6. Crear contenedor
            container = await docker.containers.create(config=config, name=payload.name)

            # 7. Iniciar si se solicitó
            started = False
            status = "created"
            if payload.start_now:
                await container.start()
                started = True
                status = "running"

            cid = str(getattr(container, "id", None) or (await container.show()).get("Id", "unknown"))
            assigned_name = payload.name or cid[:12]

            return CreateContainerResponse(
                id=cid[:12] if len(cid) > 12 else cid,
                name=assigned_name,
                image=payload.image,
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
            raise HTTPException(status_code=e.status, detail=e.message) from e
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Error inesperado al crear contenedor: {e!s}") from e

