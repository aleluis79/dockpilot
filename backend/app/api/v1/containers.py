# SPDX-License-Identifier: AGPL-3.0-or-later
from typing import Annotated

import aiodocker
from fastapi import APIRouter, Depends, Query

from app.core.docker import get_docker
from app.schemas.container import (
    ContainerActionResponse,
    ContainerDetail,
    ContainerSummary,
    CreateContainerRequest,
    CreateContainerResponse,
)
from app.schemas.stats import ContainerStats
from app.services.container_service import ContainerService
from app.services.stats_service import StatsService

DockerDep = Annotated[aiodocker.Docker, Depends(get_docker)]

router = APIRouter(prefix="/containers", tags=["containers"])


@router.post("", response_model=CreateContainerResponse, status_code=201)
async def create_container(
    docker: DockerDep,
    payload: CreateContainerRequest,
):
    """Crea y opcionalmente arranca un nuevo contenedor Docker."""
    return await ContainerService.create_container(docker=docker, payload=payload)


@router.get("", response_model=list[ContainerSummary])
async def list_containers(
    docker: DockerDep,
    all: bool = Query(True, description="Mostrar todos los contenedores (incluyendo detenidos)"),
    status: str | None = Query(None, description="Filtrar por estado: running, exited, etc."),
):
    """Lista todos los contenedores con soporte para filtrado."""
    return await ContainerService.list_containers(docker=docker, all=all, status=status)


@router.get("/{container_id}", response_model=ContainerDetail)
async def get_container(
    docker: DockerDep,
    container_id: str,
):
    """Obtiene los detalles e inspección completa de un contenedor."""
    return await ContainerService.get_container(docker=docker, container_id=container_id)


@router.get("/{container_id}/logs")
async def get_container_logs(
    docker: DockerDep,
    container_id: str,
    tail: int = Query(100, description="Número de líneas recientes"),
    timestamps: bool = Query(True, description="Incluir marcas de tiempo"),
):
    """Obtiene una instantánea reciente de los logs del contenedor."""
    return await ContainerService.get_logs_snapshot(
        docker=docker, container_id=container_id, tail=tail, timestamps=timestamps
    )


@router.get("/{container_id}/stats", response_model=ContainerStats)
async def get_container_stats(
    docker: DockerDep,
    container_id: str,
):
    """Obtiene una instantánea de las métricas de CPU, memoria, red y disco del contenedor."""
    return await StatsService.get_stats(docker=docker, container_id=container_id)


@router.post("/{container_id}/start", response_model=ContainerActionResponse)
async def start_container(
    docker: DockerDep,
    container_id: str,
):
    """Inicia un contenedor detenido."""
    return await ContainerService.start_container(docker=docker, container_id=container_id)


@router.post("/{container_id}/stop", response_model=ContainerActionResponse)
async def stop_container(
    docker: DockerDep,
    container_id: str,
    timeout: int = Query(10, description="Tiempo de espera en segundos antes de forzar la detención"),
):
    """Detiene un contenedor en ejecución."""
    return await ContainerService.stop_container(docker=docker, container_id=container_id, timeout=timeout)


@router.post("/{container_id}/restart", response_model=ContainerActionResponse)
async def restart_container(
    docker: DockerDep,
    container_id: str,
    timeout: int = Query(10, description="Tiempo de espera en segundos antes de reiniciar"),
):
    """Reinicia un contenedor."""
    return await ContainerService.restart_container(docker=docker, container_id=container_id, timeout=timeout)


@router.post("/{container_id}/pause", response_model=ContainerActionResponse)
async def pause_container(
    docker: DockerDep,
    container_id: str,
):
    """Pausa todos los procesos de un contenedor."""
    return await ContainerService.pause_container(docker=docker, container_id=container_id)


@router.post("/{container_id}/unpause", response_model=ContainerActionResponse)
async def unpause_container(
    docker: DockerDep,
    container_id: str,
):
    """Reanuda los procesos de un contenedor pausado."""
    return await ContainerService.unpause_container(docker=docker, container_id=container_id)


@router.delete("/{container_id}", response_model=ContainerActionResponse)
async def remove_container(
    docker: DockerDep,
    container_id: str,
    force: bool = Query(False, description="Forzar la eliminación incluso si está en ejecución"),
    v: bool = Query(False, description="Eliminar los volúmenes anónimos asociados al contenedor"),
):
    """Elimina un contenedor."""
    return await ContainerService.remove_container(
        docker=docker, container_id=container_id, force=force, v=v
    )
