from typing import Annotated

import aiodocker
from fastapi import APIRouter, Depends, Query

from app.core.docker import get_docker
from app.schemas.volume import (
    VolumeDeleteResponse,
    VolumeDetail,
    VolumePruneResult,
    VolumeSummary,
)
from app.services.volume_service import VolumeService

DockerDep = Annotated[aiodocker.Docker, Depends(get_docker)]

router = APIRouter(prefix="/volumes", tags=["volumes"])


@router.get("", response_model=list[VolumeSummary])
async def list_volumes(
    docker: DockerDep,
):
    """Lista los volúmenes del host con su tamaño y número de referencias."""
    return await VolumeService.list_volumes(docker=docker)


@router.get("/prune", response_model=dict)
async def unused_volumes_summary(
    docker: DockerDep,
):
    """Resumen de los volúmenes no usados, para confirmar antes de limpiar."""
    return await VolumeService.count_unused(docker=docker)


@router.post("/prune", response_model=VolumePruneResult)
async def prune_volumes(
    docker: DockerDep,
):
    """Elimina los volúmenes no utilizados (dangling)."""
    return await VolumeService.prune_volumes(docker=docker)


@router.get("/{name}", response_model=VolumeDetail)
async def get_volume(
    docker: DockerDep,
    name: str,
):
    """Inspecciona un volumen por nombre."""
    return await VolumeService.get_volume_detail(docker=docker, name=name)


@router.delete("/{name}", response_model=VolumeDeleteResponse)
async def delete_volume(
    docker: DockerDep,
    name: str,
    force: bool = Query(False, description="Eliminar aunque el volumen esté en uso"),
):
    """Elimina un volumen local, indicando si hubo que forzarlo."""
    return await VolumeService.delete_volume(docker=docker, name=name, force=force)
