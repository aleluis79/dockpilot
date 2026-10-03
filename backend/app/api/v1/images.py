# SPDX-License-Identifier: AGPL-3.0-or-later
from typing import Annotated

import aiodocker
from fastapi import APIRouter, Depends, Query

from app.core.docker import get_docker
from app.schemas.image import (
    ImageDeleteResponse,
    ImageDetail,
    ImagePrunePreview,
    ImagePruneResult,
    ImageSearchResult,
    LocalImageSummary,
)
from app.services.image_service import ImageService

DockerDep = Annotated[aiodocker.Docker, Depends(get_docker)]

router = APIRouter(prefix="/images", tags=["images"])


@router.get("/local", response_model=list[LocalImageSummary])
async def list_local_images(
    docker: DockerDep,
):
    """Lista las imágenes almacenadas localmente en el host."""
    return await ImageService.list_local_images(docker=docker)


# --- Limpieza (SPEC-21) ------------------------------------------------------
#
# `/prune` va ANTES que `/{image_id}` y el orden no es una cuestión de estilo:
# FastAPI empareja por el orden de declaración, así que un `GET /images/prune`
# declarado después se interpretaría como el detalle de una imagen llamada
# `prune` y devolvería un 404 sobre una imagen que no existe. Hay un test que lo
# fija, porque es un fallo que no se ve leyendo el router.
@router.get("/prune", response_model=ImagePrunePreview)
async def preview_image_prune(
    docker: DockerDep,
):
    """Qué se borraría con cada nivel de limpieza. **No borra nada.**

    Los bytes son una cota superior: se suman los `Size` y dos imágenes pueden
    compartir capas, y `SharedSize` viene como `-1` en el daemon 29.8.2, así que
    ni se puede descontar lo compartido.
    """
    return await ImageService.preview_prune(docker=docker)


@router.post("/prune", response_model=ImagePruneResult)
async def prune_images(
    docker: DockerDep,
    all: bool = Query(
        False,
        description=(
            "Si es true, quita también las imágenes que tienen etiqueta y no usa ningún "
            "contenedor. Un POST sin parámetros NUNCA las quita."
        ),
    ),
):
    """Pide al daemon que limpie imágenes.

    `all` es un parámetro de query y no del cuerpo a propósito: es lo que separa
    el botón seguro del peligroso, y un cuerpo opcional haría que un cliente que
    no lo manda limpiara de más. Es el mismo criterio que `?force=` en el borrado.
    """
    return await ImageService.prune_images(docker=docker, all_unused=all)


@router.get("/search", response_model=list[ImageSearchResult])
async def search_images(
    docker: DockerDep,
    term: str = Query(..., description="Término a buscar en Docker Hub"),
    limit: int = Query(10, description="Límite máximo de resultados"),
):
    """Busca imágenes públicas en Docker Hub a través del motor Docker."""
    return await ImageService.search_images(docker=docker, term=term, limit=limit)


@router.get("/{image_id}", response_model=ImageDetail)
async def get_image(
    docker: DockerDep,
    image_id: str,
):
    """Inspecciona una imagen por ID o tag, con su configuración e historial."""
    return await ImageService.get_image_detail(docker=docker, image_id=image_id)


@router.delete("/{image_id}", response_model=ImageDeleteResponse)
async def delete_image(
    docker: DockerDep,
    image_id: str,
    force: bool = Query(False, description="Eliminar aunque la imagen esté en uso"),
):
    """Elimina una imagen local, indicando los tags que quedan sin referenciar."""
    return await ImageService.delete_image(docker=docker, image_id=image_id, force=force)
