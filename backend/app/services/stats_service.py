# SPDX-License-Identifier: AGPL-3.0-or-later
import inspect
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any

import aiodocker
from aiodocker.exceptions import DockerError
from fastapi import HTTPException

from app.schemas.stats import ContainerStats


def _as_int(value: Any) -> int:
    """Convierte un valor arbitrario de las estadísticas de Docker a int de forma segura."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _as_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _short_id(container_id: str) -> str:
    return container_id[:12] if len(container_id) > 12 else container_id


def calculate_cpu_percent(raw: dict) -> float:
    """Calcula el porcentaje de CPU de una muestra de /containers/{id}/stats.

    docker_delta  = cpu_stats.cpu_usage.total_usage - precpu_stats.cpu_usage.total_usage
    system_delta  = cpu_stats.system_cpu_usage - precpu_stats.system_cpu_usage
    online_cpus   = cpu_stats.online_cpus or len(cpu_stats.cpu_usage.percpu_usage) or 1
    cpu_percent   = (docker_delta / system_delta) * online_cpus * 100.0
    """
    cpu_stats = raw.get("cpu_stats") or {}
    precpu_stats = raw.get("precpu_stats") or {}

    cpu_usage = cpu_stats.get("cpu_usage") or {}
    precpu_usage = precpu_stats.get("cpu_usage") or {}

    cpu_delta = _as_int(cpu_usage.get("total_usage")) - _as_int(precpu_usage.get("total_usage"))
    system_delta = _as_int(cpu_stats.get("system_cpu_usage")) - _as_int(
        precpu_stats.get("system_cpu_usage")
    )

    if system_delta <= 0 or cpu_delta <= 0:
        return 0.0

    percpu = cpu_usage.get("percpu_usage") or []
    online_cpus = _as_int(cpu_stats.get("online_cpus")) or len(percpu) or 1

    return (cpu_delta / system_delta) * online_cpus * 100.0


def calculate_memory(raw: dict) -> tuple[int, int, float]:
    """Calcula (memory_limit, memory_usage, memory_percent) descontando caché y buffers.

    inactive_cache = memory_stats.stats.inactive_file  (cgroups v2)
                   or memory_stats.stats.cache          (cgroups v1)
    memory_usage   = max(0, memory_stats.usage - inactive_cache)
    """
    memory_stats = raw.get("memory_stats") or {}
    sub_stats = memory_stats.get("stats") or {}

    memory_limit = _as_int(memory_stats.get("limit"))
    inactive_cache = _as_int(sub_stats.get("inactive_file")) or _as_int(sub_stats.get("cache"))
    memory_usage = max(0, _as_int(memory_stats.get("usage")) - inactive_cache)

    memory_percent = (memory_usage / memory_limit) * 100.0 if memory_limit > 0 else 0.0

    return memory_limit, memory_usage, memory_percent


def calculate_network(raw: dict) -> tuple[int, int]:
    """Suma los bytes de Rx y Tx a través de todos los adaptadores de red del contenedor."""
    networks = raw.get("networks") or {}

    rx_bytes = 0
    tx_bytes = 0
    for net in networks.values():
        if not isinstance(net, dict):
            continue
        rx_bytes += _as_int(net.get("rx_bytes"))
        tx_bytes += _as_int(net.get("tx_bytes"))

    return rx_bytes, tx_bytes


def calculate_block_io(raw: dict) -> tuple[int, int]:
    """Suma las operaciones de I/O de bloque agrupadas por op (Read y Write)."""
    blkio_stats = raw.get("blkio_stats") or {}
    entries = blkio_stats.get("io_service_bytes_recursive") or []

    read_bytes = 0
    write_bytes = 0
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        op = str(entry.get("op") or "").lower()
        value = _as_int(entry.get("value"))
        if op == "read":
            read_bytes += value
        elif op == "write":
            write_bytes += value

    return read_bytes, write_bytes


def empty_stats(container_id: str, container_name: str) -> ContainerStats:
    """Construye un reporte de estadísticas en reposo con todas las métricas a cero."""
    return ContainerStats(
        container_id=container_id,
        container_name=container_name,
        cpu_percent=0.0,
        memory_usage=0,
        memory_limit=0,
        memory_percent=0.0,
        network_rx_bytes=0,
        network_tx_bytes=0,
        block_read_bytes=0,
        block_write_bytes=0,
        pids_current=0,
        timestamp=datetime.now(UTC).isoformat(),
    )


def calculate_stats(raw: dict, container_id: str, container_name: str) -> ContainerStats:
    """Normaliza el diccionario crudo de /containers/{id}/stats al schema ContainerStats."""
    raw = raw or {}

    cpu_percent = calculate_cpu_percent(raw)
    memory_limit, memory_usage, memory_percent = calculate_memory(raw)
    network_rx_bytes, network_tx_bytes = calculate_network(raw)
    block_read_bytes, block_write_bytes = calculate_block_io(raw)

    pids_stats = raw.get("pids_stats") or {}
    pids_current: int | None = _as_int(pids_stats.get("current")) if pids_stats else None

    return ContainerStats(
        container_id=container_id,
        container_name=container_name,
        cpu_percent=cpu_percent,
        memory_usage=memory_usage,
        memory_limit=memory_limit,
        memory_percent=memory_percent,
        network_rx_bytes=network_rx_bytes,
        network_tx_bytes=network_tx_bytes,
        block_read_bytes=block_read_bytes,
        block_write_bytes=block_write_bytes,
        pids_current=pids_current,
        timestamp=raw.get("read") or datetime.now(UTC).isoformat(),
    )


class StatsService:
    @staticmethod
    async def get_stats(docker: aiodocker.Docker, container_id: str) -> ContainerStats:
        """Devuelve la instantánea más reciente de métricas de un contenedor."""
        cid = _short_id(container_id)
        name = cid
        try:
            container = await docker.containers.get(container_id)
            info = await container.show()
            name = str(info.get("Name") or f"/{container_id}").lstrip("/")

            state_info = info.get("State") or {}
            is_running = state_info.get("Running", False) if isinstance(state_info, dict) else False
            if not is_running:
                return empty_stats(cid, name)

            res = container.stats(stream=False)
            raw_samples = await res if inspect.iscoroutine(res) else res
            if not raw_samples:
                return empty_stats(cid, name)

            latest = raw_samples[-1] if isinstance(raw_samples, list) else raw_samples
            return calculate_stats(latest, container_id=cid, container_name=name)
        except DockerError as e:
            if e.status == 404:
                raise HTTPException(
                    status_code=404, detail=f"Contenedor {container_id} no encontrado"
                ) from e
            # 409: el daemon rechaza la consulta de stats porque el contenedor no está en ejecución
            if e.status == 409:
                return empty_stats(cid, name)
            raise HTTPException(status_code=e.status, detail=e.message) from e
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(
                status_code=500, detail=f"Error al obtener estadísticas: {e!s}"
            ) from e

    @staticmethod
    async def stream_stats(
        container: Any, container_id: str, container_name: str
    ) -> AsyncIterator[ContainerStats]:
        """Itera el stream continuo de métricas emitido por Docker para un contenedor."""
        cid = _short_id(container_id)
        res = container.stats(stream=True)
        stream = await res if inspect.iscoroutine(res) else res
        async for raw in stream:
            yield calculate_stats(raw, container_id=cid, container_name=container_name)
