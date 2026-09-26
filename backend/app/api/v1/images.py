from typing import Annotated

import aiodocker
from fastapi import APIRouter, Depends, Query

from app.core.docker import get_docker
from app.schemas.image import (
    ImageDeleteResponse,
    ImageDetail,
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
