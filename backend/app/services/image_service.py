from typing import Any

import aiodocker
from aiodocker.exceptions import DockerError
from fastapi import HTTPException

from app.schemas.image import ImageSearchResult, LocalImageSummary


def _get_image_dict(img: Any) -> dict:
    if hasattr(img, "_image") and isinstance(img._image, dict):
        return img._image
    if isinstance(img, dict):
        return img
    return {}


class ImageService:
    @staticmethod
    async def list_local_images(docker: aiodocker.Docker) -> list[LocalImageSummary]:
        try:
            raw_images = await docker.images.list()
            result = []
            for img in raw_images:
                info = _get_image_dict(img)
                tags = info.get("RepoTags") or []
                # Filtrar tags válidos
                clean_tags = [t for t in tags if t and t != "<none>:<none>"]
                if clean_tags:
                    result.append(
                        LocalImageSummary(
                            id=info.get("Id", "")[:19],
                            tags=clean_tags,
                            size=info.get("Size", 0),
                            created=info.get("Created", 0),
                        )
                    )
            return result
        except DockerError as e:
            raise HTTPException(status_code=503, detail=f"Error al listar imágenes: {e.message}") from e
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Error inesperado al listar imágenes: {e!s}") from e

    @staticmethod
    async def search_images(
        docker: aiodocker.Docker, term: str, limit: int = 10
    ) -> list[ImageSearchResult]:
        if not term or not term.strip():
            raise HTTPException(status_code=400, detail="El parámetro 'term' de búsqueda no puede estar vacío")

        try:
            results = await docker._query_json(
                "images/search", params={"term": term.strip(), "limit": limit}
            )
            parsed = []
            for item in results or []:
                parsed.append(
                    ImageSearchResult(
                        name=item.get("name", ""),
                        description=item.get("description", ""),
                        is_official=item.get("is_official", False),
                        star_count=item.get("star_count", 0),
                    )
                )
            return parsed
        except HTTPException:
            raise
        except DockerError as e:
            raise HTTPException(status_code=503, detail=f"Error al buscar en Docker Hub: {e.message}") from e
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Error al buscar imágenes: {e!s}") from e
