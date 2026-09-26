# SPDX-License-Identifier: AGPL-3.0-or-later
from typing import Annotated

import aiodocker
from fastapi import APIRouter, Depends

from app.core.docker import get_docker
from app.schemas.system import DiskUsage, SystemInfo, SystemOverview
from app.services.system_service import SystemService

DockerDep = Annotated[aiodocker.Docker, Depends(get_docker)]

router = APIRouter(prefix="/system", tags=["system"])


@router.get("/info", response_model=SystemInfo)
async def read_system_info(docker: DockerDep):
    """Versión, sistema, CPU, RAM y driver de almacenamiento del host."""
    return await SystemService.get_system_info(docker=docker)


@router.get("/df", response_model=DiskUsage)
async def read_disk_usage(docker: DockerDep):
    """Consumo de disco por tipo de recurso y espacio recuperable."""
    return await SystemService.get_disk_usage(docker=docker)


@router.get("/overview", response_model=SystemOverview)
async def read_overview(docker: DockerDep):
    """Vista completa para la franja de resumen: info, uso y mayores consumidores."""
    return await SystemService.get_overview(docker=docker)
