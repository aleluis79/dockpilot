# SPDX-License-Identifier: AGPL-3.0-or-later
import inspect
import re
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any

import aiodocker
from aiodocker.exceptions import DockerError
from fastapi import HTTPException

from app.core.docker import docker_error_message, docker_error_status
from app.schemas.image import (
    ImageDeleteResponse,
    ImageDetail,
    ImageHistoryEntry,
    ImagePullMessage,
    ImageSearchResult,
    LocalImageSummary,
)

# Referencia de imagen: [host[:puerto]/]repo[/repo...] [:tag] [@sha256:digest].
# - El primer componente admite puerto porque `localhost:5000/app:tag` es legítimo
#   y, sin él, el `:5000` se interpretaría como tag.
# - Cada segmento debe empezar por alfanumérico o `_`, lo que además rechaza
#   path traversal (`..`).
IMAGE_REF_PATTERN = re.compile(
    r"^[a-zA-Z0-9][a-zA-Z0-9._-]*(?::\d+)?"
    r"(?:/[a-zA-Z0-9_][a-zA-Z0-9._-]*)*"
    r"(?::[a-zA-Z0-9._-]+)?"
    r"(?:@sha256:[a-f0-9]{64})?$"
)
MAX_IMAGE_REF_LENGTH = 255
NONE_TAG = "<none>:<none>"
NONE_DIGEST = "<none>@<none>"

_LAYER_STATE_EVENTS = {
    "pulling fs layer": "pending",
    "downloading": "downloading",
    "extracting": "extracting",
    "download complete": "done",
    "pull complete": "done",
}


def validate_image_ref(ref: str) -> None:
    """Valida una referencia de imagen en el borde. Lanza ValueError si no es válida."""
    candidate = (ref or "").strip()
    if not candidate:
        raise ValueError("La referencia de imagen no puede estar vacía")
    if len(candidate) > MAX_IMAGE_REF_LENGTH:
        raise ValueError(
            f"La referencia de imagen supera los {MAX_IMAGE_REF_LENGTH} caracteres"
        )
    if not IMAGE_REF_PATTERN.match(candidate):
        raise ValueError(
            f"Referencia de imagen inválida: '{candidate}'. "
            "Formato esperado: repo[:tag] o repo@sha256:<64 hex>"
        )


def normalize_image_ref(ref: str) -> str:
    """Valida la referencia y le añade ':latest' si no lleva tag ni digest.

    Iguala el comportamiento al de `docker pull`, que assumes latest cuando la
    referencia no lleva tag embebido.
    """
    candidate = (ref or "").strip()
    validate_image_ref(candidate)
    if "@sha256:" in candidate:
        return candidate
    if ":" in candidate.split("/")[-1]:
        return candidate
    return f"{candidate}:latest"


def _short_id(image_id: str) -> str:
    return image_id[:19] if len(image_id) > 19 else image_id


def pull_error_code(error: object) -> int:
    """Código HTTP con el que describir un fallo de descarga.

    El fallo típico de un pull (repo inexistente, registro privado) llega con
    HTTP 200 y un chunk `{"error": ...}` dentro del stream, que aiodocker levanta
    como `DockerStreamError`: esa clase fija `status=0` porque, para la petición
    HTTP, no hubo fallo ninguno. Tal cual, el frontend recibía
    `{"type": "error", "code": 0}`, y un 0 en un campo con forma de código HTTP
    es indistinguible del éxito.

    El código real vive en `error_detail["code"]`. Si no está, se deduce del
    texto, y si tampoco se puede, 502: el registro es un servicio externo y la
    petición sí llegó, así que el fallo no es del panel.
    """
    status = getattr(error, "status", 0)
    if isinstance(status, int) and not isinstance(status, bool) and 400 <= status < 600:
        # El daemon respondió con un código HTTP de verdad (404, 409, 500...).
        return status
    if status == 900:
        # El 900 de aiodocker significa "no pude hablar con el daemon": eso es
        # un 503 de toda la vida, no un fallo del registro.
        return 503

    detalle = getattr(error, "error_detail", None)
    if isinstance(detalle, dict):
        codigo = detalle.get("code")
        if isinstance(codigo, int) and not isinstance(codigo, bool) and 400 <= codigo < 600:
            return codigo

    texto = docker_error_message(error).lower()
    if "denied" in texto or "unauthorized" in texto or "authentication" in texto:
        return 403
    if "not found" in texto or "does not exist" in texto or "manifest unknown" in texto:
        return 404
    if "too many requests" in texto or "toomanyrequests" in texto or "rate limit" in texto:
        return 429
    if "no space left" in texto or "disk" in texto:
        return 507
    return 502


def _get_image_dict(img: Any) -> dict:
    if hasattr(img, "_image") and isinstance(img._image, dict):
        return img._image
    if isinstance(img, dict):
        return img
    return {}


def _parse_epoch(value: Any) -> int:
    """Docker usa epoch en `list` y una fecha ISO en `inspect`."""
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str) and value:
        try:
            return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())
        except ValueError:
            return 0
    return 0


def _clean_tags(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    return [t for t in raw if t and t != NONE_TAG]


def _clean_digests(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    return [d for d in raw if d and d != NONE_DIGEST]



class ImageService:
    @staticmethod
    async def list_local_images(docker: aiodocker.Docker) -> list[LocalImageSummary]:
        try:
            raw_images = await docker.images.list()
            result = []
            for img in raw_images:
                info = _get_image_dict(img)
                clean_tags = _clean_tags(info.get("RepoTags"))
                if clean_tags:
                    result.append(
                        LocalImageSummary(
                            id=_short_id(info.get("Id", "")),
                            tags=clean_tags,
                            size=info.get("Size", 0),
                            created=info.get("Created", 0),
                            containers=info.get("Containers", 0) or 0,
                            repo_digests=_clean_digests(info.get("RepoDigests")),
                        )
                    )
            return result
        except DockerError as e:
            raise HTTPException(status_code=503, detail=f"Error al listar imágenes: {docker_error_message(e)}") from e
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
            raise HTTPException(
                status_code=503,
                detail=f"Error al buscar en Docker Hub: {docker_error_message(e)}",
            ) from e
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Error al buscar imágenes: {e!s}") from e

    @staticmethod
    async def get_image_detail(docker: aiodocker.Docker, image_id: str) -> ImageDetail:
        """Inspecciona una imagen por ID o tag y añade su historial de construcción."""
        try:
            info = await docker.images.inspect(image_id)
        except DockerError as e:
            if e.status == 404:
                raise HTTPException(status_code=404, detail=f"Imagen {image_id} no encontrada") from e
            raise HTTPException(
                status_code=docker_error_status(e), detail=docker_error_message(e)
            ) from e
        except Exception as e:
            raise HTTPException(
                status_code=500, detail=f"Error al inspeccionar la imagen: {e!s}"
            ) from e

        # El historial es informativo: si falla, no debe impedir inspeccionar.
        history: list[ImageHistoryEntry] = []
        try:
            raw_history = await docker.images.history(image_id)
            for entry in raw_history or []:
                history.append(
                    ImageHistoryEntry(
                        id=entry.get("Id", ""),
                        created=_parse_epoch(entry.get("Created")),
                        created_by=entry.get("CreatedBy", "") or "",
                        size=entry.get("Size", 0) or 0,
                        comment=entry.get("Comment", "") or "",
                        tags=_clean_tags(entry.get("Tags")) or None,
                    )
                )
        except Exception:
            history = []

        config = info.get("Config") or {}
        root_fs = info.get("RootFS") or {}

        return ImageDetail(
            id=_short_id(info.get("Id", "")),
            tags=_clean_tags(info.get("RepoTags")),
            repo_digests=_clean_digests(info.get("RepoDigests")),
            size=info.get("Size", 0) or 0,
            created=_parse_epoch(info.get("Created")),
            architecture=info.get("Architecture", "") or "",
            os=info.get("Os", "") or "",
            entrypoint=config.get("Entrypoint"),
            cmd=config.get("Cmd"),
            env=config.get("Env") or [],
            exposed_ports=config.get("ExposedPorts") or {},
            working_dir=config.get("WorkingDir", "") or "",
            user=config.get("User", "") or "",
            labels=config.get("Labels") or {},
            layer_count=len(root_fs.get("Layers") or []),
            history=history,
        )

    @staticmethod
    async def delete_image(
        docker: aiodocker.Docker, image_id: str, force: bool = False
    ) -> ImageDeleteResponse:
        """Elimina una imagen. Devuelve los tags que quedan sin referenciar."""
        try:
            raw = await docker.images.delete(image_id, force=force)
        except DockerError as e:
            if e.status == 404:
                raise HTTPException(status_code=404, detail=f"Imagen {image_id} no encontrada") from e
            if e.status == 409:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"No se pudo eliminar la imagen {image_id}: está en uso. "
                        "Vuelve a intentarlo forzando la eliminación."
                    ),
                ) from e
            raise HTTPException(
                status_code=docker_error_status(e), detail=docker_error_message(e)
            ) from e
        except Exception as e:
            raise HTTPException(
                status_code=500, detail=f"Error al eliminar la imagen: {e!s}"
            ) from e

        untagged: list[str] = []
        for entry in raw or []:
            if isinstance(entry, dict):
                untagged.extend(_clean_tags(entry.get("Untagged")))

        suffix = " (forzada)" if force else ""
        return ImageDeleteResponse(
            id=image_id,
            deleted=True,
            untagged=untagged,
            message=f"Imagen {image_id} eliminada correctamente{suffix}",
        )

    @staticmethod
    async def stream_pull(
        images: Any, image_ref: str
    ) -> AsyncIterator[ImagePullMessage]:
        """Itera la descarga de una imagen y normaliza los eventos del daemon.

        Los eventos del daemon se reenvían tal cual (el backend solo adapta), y
        los errores llegan como `DockerError` **durante la iteración`: así se
        comporta aiodocker 0.27.0, pese a que su docstring mencione
        `DockerStreamError`.
        """
        res = images.pull(image_ref, stream=True)
        stream = await res if inspect.iscoroutine(res) else res

        async for event in stream:
            status = str(event.get("status") or "")
            lowered = status.lower()

            if lowered.startswith("digest:"):
                yield ImagePullMessage(
                    type="digest", image=image_ref, digest=status.split(":", 1)[1].strip()
                )
                continue

            if lowered.startswith("status:"):
                continue

            if not status or lowered not in _LAYER_STATE_EVENTS:
                # "Pulling from library/x" y cualquier evento sin capa asociada
                if lowered.startswith("pulling from"):
                    yield ImagePullMessage(
                        type="layer", image=image_ref, status=status, id=event.get("id")
                    )
                continue

            progress_detail = event.get("progressDetail") or {}
            yield ImagePullMessage(
                type="layer",
                image=image_ref,
                id=event.get("id"),
                status=status,
                current=progress_detail.get("current"),
                total=progress_detail.get("total"),
                progress=event.get("progress"),
            )
