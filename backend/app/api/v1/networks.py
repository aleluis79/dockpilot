# SPDX-License-Identifier: AGPL-3.0-or-later
from typing import Annotated

import aiodocker
from fastapi import APIRouter, Depends, Query, status

from app.core.docker import get_docker
from app.schemas.network import (
    CreateNetworkRequest,
    NetworkDeleteResponse,
    NetworkDetail,
    NetworkPruneResult,
    NetworkSummary,
)
from app.services.network_service import NetworkService

DockerDep = Annotated[aiodocker.Docker, Depends(get_docker)]

router = APIRouter(prefix="/networks", tags=["networks"])


@router.get("", response_model=list[NetworkSummary])
async def list_networks(docker: DockerDep):
    """Lista las redes del host con su recuento de contenedores."""
    return await NetworkService.list_networks(docker=docker)


@router.post("/prune", response_model=NetworkPruneResult)
async def prune_networks(docker: DockerDep):
    """Elimina las redes sin contenedores. Nunca toca las predefinidas."""
    return await NetworkService.prune_networks(docker=docker)


@router.post(
    "", response_model=NetworkDetail, status_code=status.HTTP_201_CREATED
)
async def create_network(payload: CreateNetworkRequest, docker: DockerDep):
    """Crea una red, con subred y puerta de enlace opcionales."""
    return await NetworkService.create_network(docker=docker, payload=payload)


@router.get("/{name}", response_model=NetworkDetail)
async def get_network(name: str, docker: DockerDep):
    """Detalle de una red: IPAM, opciones, etiquetas y contenedores."""
    return await NetworkService.get_network(docker=docker, name=name)


@router.delete("/{name}", response_model=NetworkDeleteResponse)
async def delete_network(
    name: str,
    docker: DockerDep,
    force: bool = Query(False, description="Desconectar y eliminar aunque esté en uso"),
):
    """Borra una red. Las predefinidas de Docker se rechazan siempre."""
    return await NetworkService.delete_network(docker=docker, name=name, force=force)
