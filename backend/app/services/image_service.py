# SPDX-License-Identifier: AGPL-3.0-or-later
import inspect
import re
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any, NamedTuple

import aiodocker
from aiodocker.exceptions import DockerError
from fastapi import HTTPException

from app.core.docker import docker_error_message, docker_error_status
from app.schemas.image import (
    ImageDeleteResponse,
    ImageDetail,
    ImageHistoryEntry,
    ImagePrunePreview,
    ImagePruneResult,
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



class _ImagenPortable(NamedTuple):
    """Una imagen que el panel considera podable, con su id completo.

    El `ref` es lo que se enseña (la etiqueta, o el id corto si no tiene) y el
    `id` completo es lo que se le pasa al daemon. Son dos cosas distintas y
    confundirlas era el modo de fallo del detalle de imagen.
    """

    id: str
    ref: str
    size: int


class _Clasificacion(NamedTuple):
    dangling: list[_ImagenPortable]
    dangling_bytes: int
    tagged: list[_ImagenPortable]
    tagged_bytes: int
    in_use_dangling: int


def _clasificar_imagenes(raw_images: Any) -> _Clasificacion:
    """Reparte las imágenes en lo que se puede borrar y lo que no.

    **El preaviso y la acción usan esta misma función**, a propósito: si cada uno
    tuviera su propia copia, el botón podría prometer una cosa y borrar otra, que
    es el modo de fallo que y que SPEC-21 iba a evitar.

    La regla de la que sale todo:

    - Con contenedores que la usen, **no se borra nunca**, y da igual tenga
      etiqueta. Sin etiqueta además parece basura, así que se cuenta aparte para
      poder decirlo en vez de dejar que el usuario lo descubra en el diálogo.
    - Sin contenedores, es podable: con etiqueta va al nivel agresivo y sin
      etiqueta al que llama el daemon.
    """
    dangling: list[_ImagenPortable] = []
    tagged: list[_ImagenPortable] = []
    in_use_dangling = 0

    for img in raw_images or []:
        info = _get_image_dict(img)
        tags = _clean_tags(info.get("RepoTags"))
        en_uso = int(info.get("Containers") or 0) > 0
        size = int(info.get("Size") or 0)
        id_completo = str(info.get("Id") or "")
        ref = tags[0] if tags else _short_id(id_completo)
        if not ref:
            continue

        if en_uso:
            if not tags:
                in_use_dangling += 1
            continue

        if tags:
            tagged.append(_ImagenPortable(id_completo, ref, size))
        else:
            dangling.append(_ImagenPortable(id_completo, ref, size))

    return _Clasificacion(
        dangling=dangling,
        dangling_bytes=sum(e.size for e in dangling),
        tagged=tagged,
        tagged_bytes=sum(e.size for e in tagged),
        in_use_dangling=in_use_dangling,
    )


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
    async def preview_prune(docker: aiodocker.Docker) -> ImagePrunePreview:
        """Qué se borraría con cada nivel, sin borrar nada (SPEC-21).

        No hay forma de preguntarle a Docker qué borraría un prune sin borrarlo,
        así que esto **lee**. De ahí salen las dos limitaciones que hay que decir
        en voz alta en vez de disimular:

        - Los bytes son una **cota superior**: se suman los `Size` y dos imágenes
          pueden compartir capas. `SharedSize` sale como `-1` en el daemon 29.8.2,
          así que ni siquiera se puede descontar lo compartido.
        - Una imagen sin etiqueta **en uso** no es podable. Va en su propio
          contador, porque contarla entre las que sí lo son haría que el diálogo
          prometiese un borrado que el daemon no va a hacer.

        Si la lectura falla se responde `503` y no una lista vacía: "no sé qué
        hay" y "no hay nada" son cosas distintas, y la segunda dejaría un botón
        que no tiene nada que limpiar.
        """
        try:
            raw_images = await docker.images.list()
        except DockerError as e:
            raise HTTPException(
                status_code=503,
                detail=f"No se pudo leer las imágenes para el preaviso: {docker_error_message(e)}",
            ) from e
        except Exception as e:
            raise HTTPException(
                status_code=500, detail=f"Error inesperado al previsualizar la limpieza: {e!s}"
            ) from e

        clasificacion = _clasificar_imagenes(raw_images)
        return ImagePrunePreview(
            dangling_count=len(clasificacion.dangling),
            dangling_bytes=clasificacion.dangling_bytes,
            dangling_ids=[e.ref for e in clasificacion.dangling],
            tagged_count=len(clasificacion.tagged),
            tagged_bytes=clasificacion.tagged_bytes,
            tagged_refs=[e.ref for e in clasificacion.tagged],
            in_use_dangling=clasificacion.in_use_dangling,
        )

    @staticmethod
    async def prune_images(docker: aiodocker.Docker, all_unused: bool = False) -> ImagePruneResult:
        """Limpia imágenes, en el nivel que pida el botón.

        **Los dos niveles son caminos distintos, y no por gusto.** El seguro es
        una llamada al prune del daemon; el agresivo **no puede serlo**: el filtro
        `all` ya no existe en `POST /images/prune` y el daemon responde
        `400 invalid filter 'all'` (medido contra el 29.8.2, API 1.56, que sólo
        acepta `dangling`, `label` y `until`). Así que el agresivo borra imagen a
        imagen con `DELETE /images/{id}` sobre **la misma clasificación que el
        preaviso**, para que no pueda pasar lo que el diálogo no dijo.

        El nivel seguro no manda ningún filtro porque el default del daemon ya es
        «sólo las imágenes sin etiqueta», que es exactamente lo que promete el
        botón: lo que tiene etiqueta se queda.
        """
        if all_unused:
            return await _borrar_una_a_una(docker)

        try:
            raw = await docker.images.prune()
        except DockerError as e:
            raise HTTPException(
                status_code=503, detail=f"Error al limpiar las imágenes: {docker_error_message(e)}"
            ) from e
        except Exception as e:
            raise HTTPException(
                status_code=500, detail=f"Error inesperado al limpiar las imágenes: {e!s}"
            ) from e

        raw = raw or {}
        borradas = _refs_borradas(raw.get("ImagesDeleted") or [])
        reclaimed = int(raw.get("SpaceReclaimed") or 0)

        if not borradas:
            # El prune sólo sabe qué borró, no qué había: quien sabe el inventario
            # es el preaviso, que es otro endpoint.
            message = "El daemon no ha eliminado ninguna imagen"
        else:
            plural = "s" if len(borradas) != 1 else ""
            message = (
                f"{len(borradas)} imagen{plural} sin etiqueta eliminada{plural}: "
                f"{', '.join(borradas)}"
            )
        return ImagePruneResult(deleted=borradas, bytes_reclaimed=reclaimed, message=message)

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


def _refs_borradas(entradas: Any) -> list[str]:
    """Los tags y los ids que el daemon dice que se han ido.

    Cada entrada trae `Deleted` (el id que desaparece) y `Untagged` (la etiqueta
    que queda sin referencia). Se informan **ambos**: lo que el usuario reconoce
    es el tag, y lo que se va es el id.
    """
    refs: list[str] = []
    for entrada in entradas or []:
        if not isinstance(entrada, dict):
            continue
        id_borrada = _short_id(str(entrada.get("Deleted") or ""))
        sin_etiqueta = _clean_tags([entrada.get("Untagged")])
        if sin_etiqueta:
            refs.append(sin_etiqueta[0])
        if id_borrada and id_borrada not in refs:
            refs.append(id_borrada)
    return refs


async def _borrar_una_a_una(docker: aiodocker.Docker) -> ImagePruneResult:
    """El nivel agresivo: borra cada imagen con etiqueta que no usa nadie.

    No se pide al prune porque `all` ya no es un filtro válido de
    `POST /images/prune`. Y no se delega en `/system/prune` del daemon porque su
    recuento previo no se puede desglosar, que es justo lo que esta spec entero
    intenta que no pase.

    Dos diferencias con el prune de verdad, y las dos se dicen en el mensaje:

    - **Los bytes son una estimación** (la suma de los `Size`), no lo que el
      daemon dice que recuperó: un borrado uno a uno no lleva ese dato, y las
      capas compartidas hacen que la suma sobreestime.
    - **Puede fallar a medias**, y no se oculta: lo que el daemon se niegue a
      quitar vuelve en `kept`, con su motivo.
    """
    try:
        raw_images = await docker.images.list()
    except DockerError as e:
        raise HTTPException(
            status_code=503,
            detail=f"No se pudo leer las imágenes para limpiarlas: {docker_error_message(e)}",
        ) from e

    clasificacion = _clasificar_imagenes(raw_images)
    borradas: list[str] = []
    conservadas: list[str] = []
    fallos_de_daemon = 0
    reclaimed = 0

    for imagen in clasificacion.tagged:
        if not imagen.id:
            conservadas.append(f"{imagen.ref} (el daemon no devolvió su id)")
            continue
        try:
            resultado = await docker.images.delete(imagen.id, force=False, noprune=False)
        except DockerError as e:
            # 409 es el caso normal: alguien ha arrancado un contenedor con esta
            # imagen entre el preaviso y el botón. No es un fallo del panel, es
            # que la imagen ya no está libre.
            if docker_error_status(e) == 503:
                fallos_de_daemon += 1
            motivo = docker_error_message(e) or f"el daemon respondió {docker_error_status(e)}"
            conservadas.append(f"{imagen.ref} ({motivo})")
            continue
        except Exception as e:
            fallos_de_daemon += 1
            conservadas.append(f"{imagen.ref} ({e})")
            continue

        borradas.append(imagen.ref)
        reclaimed += imagen.size
        # El `delete` devuelve la misma forma que el prune: lo que dejó de
        # existir y lo que quedó sin etiqueta.
        borradas.extend(r for r in _refs_borradas(resultado) if r not in borradas)

    # Si **todas** las peticiones fallaron y ninguna fue un rechazo del daemon,
    # esto no es un resultado parcial: es que no se pudo hablar con él. Informar
    # «0 eliminadas, 6 no se pudieron» escondería una caída del daemon detrás de
    # un texto que parece un resumen del trabajo.
    if not borradas and fallos_de_daemon and fallos_de_daemon == len(conservadas):
        raise HTTPException(
            status_code=503,
            detail=(
                f"El daemon no respondió al borrar las imágenes: "
                f"{conservadas[0].split('(')[-1].rstrip(')')}."
            ),
        )

    plural = "s" if len(borradas) != 1 else ""
    message = f"{len(borradas)} imagen{plural} eliminada{plural}"
    if conservadas:
        message += (
            f"; {len(conservadas)} no se pudieron eliminar y siguen ahí. "
            "Los bytes son una estimación: las capas compartidas se pueden quedar."
        )
    else:
        message += ". Los bytes son una estimación: las capas compartidas pueden quedarse."
    return ImagePruneResult(
        deleted=borradas,
        bytes_reclaimed=reclaimed,
        message=message,
        kept=conservadas,
    )
