# SPDX-License-Identifier: AGPL-3.0-or-later
from typing import Annotated

import aiodocker
from fastapi import APIRouter, Depends

from app.core.docker import get_docker
from app.schemas.compose import (
    BrowseResult,
    ComposeOverview,
    ComposePlan,
    ComposePlanRequest,
    ComposeProjectDetail,
)
from app.services.compose_service import ComposeProjectService, browse, build_plan

DockerDep = Annotated[aiodocker.Docker, Depends(get_docker)]

router = APIRouter(prefix="/compose", tags=["compose"])


@router.get("/projects", response_model=ComposeOverview)
async def list_compose_projects(docker: DockerDep):
    """Inventario de proyectos compose, con los huérfanos y los sin etiquetar.

    Lectura pura: no invoca el CLI de compose ni muta nada. El proyecto se deduce
    de las etiquetas `com.docker.compose.*` que compose pone en contenedores,
    redes y volúmenes.
    """
    return await ComposeProjectService.list_projects(docker=docker)


@router.get("/projects/{name}", response_model=ComposeProjectDetail)
async def get_compose_project(name: str, docker: DockerDep):
    """Detalle de un proyecto: servicios con sus réplicas, redes y volúmenes."""
    return await ComposeProjectService.get_project(docker=docker, name=name)


@router.post("/plan", response_model=ComposePlan)
async def plan_compose(payload: ComposePlanRequest, docker: DockerDep):
    """Previsualiza un archivo compose: qué crearía, sin crear nada.

    `POST` y no `GET` por dos razones: lleva un cuerpo, y la ruta es un
    parámetro de entrada que no pertenece en una query ni en un log de acceso.

    El plan lo resuelve `docker compose config`, no un parser propio, y por eso
    no puede discrepar de lo que hará el `up` de SPEC-13. Si se envía `content`,
    se valida ese texto en un temporal que se borra al terminar, y el archivo
    del disco no se toca.
    """
    return await build_plan(docker=docker, payload=payload)


@router.get("/browse", response_model=BrowseResult)
async def browse_compose_files(path: str | None = None):
    """Explora un directorio para elegir un compose file sin copiar la ruta a mano.

    Confinado a `COMPOSE_BROWSE_ROOT`, por defecto el home del usuario, y la
    comprobación se hace sobre la ruta ya resuelta: si no, bastaría un enlace
    simbólico dentro del home para leer cualquier directorio de la máquina
    (SPEC-14 §3.2).

    `path` es opcional: sin el se lista la raiz, porque el cliente no puede
    deducirla —`~` apunta al home del usuario del backend, no al del navegador— y
    la respuesta le dice cual es.

    Es `GET` y no `POST` porque no muta nada, y no lleva `docker` como dependencia
    porque no habla con el daemon: es una lectura del sistema de archivos.

    Devuelve nombres, tipos y tamaños, nunca contenido. Abrir el archivo lo hace
    `POST /compose/plan`, con su límite de tamaño y su validación.
    """
    return await browse(path=path)
