from typing import List
from fastapi import APIRouter, Depends, Query
import aiodocker

from app.core.docker import get_docker
from app.schemas.image import ImageSearchResult, LocalImageSummary
from app.services.image_service import ImageService

router = APIRouter(prefix="/images", tags=["images"])


@router.get("/local", response_model=List[LocalImageSummary])
async def list_local_images(
    docker: aiodocker.Docker = Depends(get_docker),
):
    """Lista las imágenes almacenadas localmente en el host."""
    return await ImageService.list_local_images(docker=docker)


@router.get("/search", response_model=List[ImageSearchResult])
async def search_images(
    term: str = Query(..., description="Término a buscar en Docker Hub"),
    limit: int = Query(10, description="Límite máximo de resultados"),
    docker: aiodocker.Docker = Depends(get_docker),
):
    """Busca imágenes públicas en Docker Hub a través del motor Docker."""
    return await ImageService.search_images(docker=docker, term=term, limit=limit)
