from typing import List, Optional
from fastapi import APIRouter, Depends, Query
import aiodocker

from app.core.docker import get_docker
from app.schemas.container import (
    ContainerSummary,
    ContainerDetail,
    ContainerActionResponse,
    CreateContainerRequest,
    CreateContainerResponse,
)
from app.services.container_service import ContainerService

router = APIRouter(prefix="/containers", tags=["containers"])


@router.post("", response_model=CreateContainerResponse, status_code=201)
async def create_container(
    payload: CreateContainerRequest,
    docker: aiodocker.Docker = Depends(get_docker),
):
    """Crea y opcionalmente arranca un nuevo contenedor Docker."""
    return await ContainerService.create_container(docker=docker, payload=payload)


@router.get("", response_model=List[ContainerSummary])
async def list_containers(
    all: bool = Query(True, description="Mostrar todos los contenedores (incluyendo detenidos)"),
    status: Optional[str] = Query(None, description="Filtrar por estado: running, exited, etc."),
    docker: aiodocker.Docker = Depends(get_docker),
):
    """Lista todos los contenedores con soporte para filtrado."""
    return await ContainerService.list_containers(docker=docker, all=all, status=status)


@router.get("/{container_id}", response_model=ContainerDetail)
async def get_container(
    container_id: str,
    docker: aiodocker.Docker = Depends(get_docker),
):
    """Obtiene los detalles e inspección completa de un contenedor."""
    return await ContainerService.get_container(docker=docker, container_id=container_id)


@router.get("/{container_id}/logs")
async def get_container_logs(
    container_id: str,
    tail: int = Query(100, description="Número de líneas recientes"),
    timestamps: bool = Query(True, description="Incluir marcas de tiempo"),
    docker: aiodocker.Docker = Depends(get_docker),
):
    """Obtiene una instantánea reciente de los logs del contenedor."""
    return await ContainerService.get_logs_snapshot(
        docker=docker, container_id=container_id, tail=tail, timestamps=timestamps
    )


@router.post("/{container_id}/start", response_model=ContainerActionResponse)
async def start_container(
    container_id: str,
    docker: aiodocker.Docker = Depends(get_docker),
):
    """Inicia un contenedor detenido."""
    return await ContainerService.start_container(docker=docker, container_id=container_id)


@router.post("/{container_id}/stop", response_model=ContainerActionResponse)
async def stop_container(
    container_id: str,
    timeout: int = Query(10, description="Tiempo de espera en segundos antes de forzar la detención"),
    docker: aiodocker.Docker = Depends(get_docker),
):
    """Detiene un contenedor en ejecución."""
    return await ContainerService.stop_container(docker=docker, container_id=container_id, timeout=timeout)


@router.post("/{container_id}/restart", response_model=ContainerActionResponse)
async def restart_container(
    container_id: str,
    timeout: int = Query(10, description="Tiempo de espera en segundos antes de reiniciar"),
    docker: aiodocker.Docker = Depends(get_docker),
):
    """Reinicia un contenedor."""
    return await ContainerService.restart_container(docker=docker, container_id=container_id, timeout=timeout)


@router.post("/{container_id}/pause", response_model=ContainerActionResponse)
async def pause_container(
    container_id: str,
    docker: aiodocker.Docker = Depends(get_docker),
):
    """Pausa todos los procesos de un contenedor."""
    return await ContainerService.pause_container(docker=docker, container_id=container_id)


@router.post("/{container_id}/unpause", response_model=ContainerActionResponse)
async def unpause_container(
    container_id: str,
    docker: aiodocker.Docker = Depends(get_docker),
):
    """Reanuda los procesos de un contenedor pausado."""
    return await ContainerService.unpause_container(docker=docker, container_id=container_id)


@router.delete("/{container_id}", response_model=ContainerActionResponse)
async def remove_container(
    container_id: str,
    force: bool = Query(False, description="Forzar la eliminación incluso si está en ejecución"),
    v: bool = Query(False, description="Eliminar los volúmenes anónimos asociados al contenedor"),
    docker: aiodocker.Docker = Depends(get_docker),
):
    """Elimina un contenedor."""
    return await ContainerService.remove_container(
        docker=docker, container_id=container_id, force=force, v=v
    )
