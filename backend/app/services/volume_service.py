from typing import Any

import aiodocker
from aiodocker.exceptions import DockerError
from fastapi import HTTPException

from app.core.docker import docker_error_message
from app.schemas.volume import (
    VolumeDeleteResponse,
    VolumeDetail,
    VolumePruneResult,
    VolumeSummary,
)
from app.services.system_service import SystemService

_HEX_DIGITS = set("0123456789abcdef")
ANONYMOUS_NAME_LENGTH = 64


def is_anonymous_volume(name: str) -> bool:
    """Un volumen anónimo es el que Docker nombra con un hash de 64 hex.

    Detección puramente léxica: no requiere ninguna llamada al daemon.
    """
    return len(name) == ANONYMOUS_NAME_LENGTH and all(c in _HEX_DIGITS for c in name)


def _as_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _clean_labels(raw: Any) -> dict[str, str]:
    if not isinstance(raw, dict):
        return {}
    return {str(k): str(v) for k, v in raw.items()}


def _clean_options(raw: Any) -> dict[str, Any]:
    return raw if isinstance(raw, dict) else {}


async def _usage_index(docker: aiodocker.Docker) -> dict[str, dict]:
    """Índice nombre -> UsageData extraído de /system/df.

    El tamaño y el número de referencias de un volumen **no** vienen en
    `/volumes`, sino en `/system/df` y anidados bajo `UsageData` (SPEC-08 §3.1).
    """
    try:
        df = await SystemService.fetch_disk_usage(docker)
    except HTTPException:
        # Sin datos de uso el inventario sigue siendo válido, solo sin tamaños.
        return {}

    index: dict[str, dict] = {}
    for item in (df.get("VolumeUsage") or {}).get("Items") or []:
        if isinstance(item, dict) and item.get("Name"):
            index[item["Name"]] = item.get("UsageData") or {}
    return index


def _raw_volume_entries(raw: Any) -> list[dict]:
    """Normaliza la respuesta de `volumes.list()`.

    aiodocker devuelve el dict completo `{"Volumes": [...], "Warnings": [...]}`
    en lugar de una lista; iterarlo directamente revienta con
    `'str' object has no attribute 'get'` (SPEC-08 §3.5).
    """
    if isinstance(raw, dict):
        entries = raw.get("Volumes") or []
    elif isinstance(raw, list):
        entries = raw
    else:
        entries = []
    return [entry for entry in entries if isinstance(entry, dict)]


class VolumeService:
    @staticmethod
    async def list_volumes(docker: aiodocker.Docker) -> list[VolumeSummary]:
        """Lista los volúmenes del host con su tamaño y número de referencias."""
        try:
            raw = await docker.volumes.list()
        except DockerError as e:
            raise HTTPException(
                status_code=503, detail=f"Error al listar volúmenes: {docker_error_message(e)}"
            ) from e
        except Exception as e:
            raise HTTPException(
                status_code=500, detail=f"Error inesperado al listar volúmenes: {e!s}"
            ) from e

        usage = await _usage_index(docker)
        summaries: list[VolumeSummary] = []

        for entry in _raw_volume_entries(raw):
            name = entry.get("Name") or ""
            if not name:
                continue
            usage_data = usage.get(name) or {}
            summaries.append(
                VolumeSummary(
                    name=name,
                    driver=entry.get("Driver") or "local",
                    mountpoint=entry.get("Mountpoint") or "",
                    scope=entry.get("Scope") or "local",
                    created_at=entry.get("CreatedAt") or "",
                    size=_as_int(usage_data.get("Size")),
                    ref_count=_as_int(usage_data.get("RefCount")),
                    is_anonymous=is_anonymous_volume(name),
                    labels=_clean_labels(entry.get("Labels")),
                )
            )
        return summaries

    @staticmethod
    async def get_volume_detail(
        docker: aiodocker.Docker, name: str
    ) -> VolumeDetail:
        """Inspecciona un volumen y lo cruza con el índice de uso."""
        try:
            instance = await docker.volumes.get(name)
            raw = await instance.show()
        except DockerError as e:
            if e.status == 404:
                raise HTTPException(
                    status_code=404, detail=f"Volumen {name} no encontrado"
                ) from e
            raise HTTPException(
                status_code=e.status, detail=docker_error_message(e)
            ) from e
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(
                status_code=500, detail=f"Error al inspeccionar el volumen: {e!s}"
            ) from e

        usage = (await _usage_index(docker)).get(name) or {}
        containers = await _containers_using(docker, name)

        return VolumeDetail(
            name=raw.get("Name") or name,
            driver=raw.get("Driver") or "local",
            mountpoint=raw.get("Mountpoint") or "",
            scope=raw.get("Scope") or "local",
            created_at=raw.get("CreatedAt") or "",
            size=_as_int(usage.get("Size")),
            ref_count=_as_int(usage.get("RefCount")),
            is_anonymous=is_anonymous_volume(raw.get("Name") or name),
            labels=_clean_labels(raw.get("Labels")),
            options=_clean_options(raw.get("Options")),
            containers=containers,
        )

    @staticmethod
    async def delete_volume(
        docker: aiodocker.Docker, name: str, force: bool = False
    ) -> VolumeDeleteResponse:
        """Elimina un volumen.

        `DockerVolumes` no expone `delete`: hay que obtener la instancia con
        `get()` y llamar a `DockerVolume.delete()` (SPEC-08 §3.5).
        """
        try:
            instance = await docker.volumes.get(name)
            await instance.delete(force=force)
        except DockerError as e:
            if e.status == 404:
                raise HTTPException(
                    status_code=404, detail=f"Volumen {name} no encontrado"
                ) from e
            if e.status == 409:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"No se pudo eliminar el volumen {name}: está en uso. "
                        "Vuelve a intentarlo forzando la eliminación."
                    ),
                ) from e
            raise HTTPException(
                status_code=e.status, detail=docker_error_message(e)
            ) from e
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(
                status_code=500, detail=f"Error al eliminar el volumen: {e!s}"
            ) from e

        suffix = " (forzado)" if force else ""
        return VolumeDeleteResponse(
            name=name,
            deleted=True,
            message=f"Volumen {name} eliminado correctamente{suffix}",
        )

    @staticmethod
    async def prune_volumes(docker: aiodocker.Docker) -> VolumePruneResult:
        """Elimina los volúmenes no utilizados.

        El daemon solo borra los `dangling`, de modo que un volumen en uso
        nunca se ve afectado aunque se solicite la limpieza.
        """
        try:
            raw = await docker.volumes.prune()
        except DockerError as e:
            raise HTTPException(
                status_code=503,
                detail=f"Error al limpiar volúmenes: {docker_error_message(e)}",
            ) from e
        except Exception as e:
            raise HTTPException(
                status_code=500, detail=f"Error inesperado al limpiar volúmenes: {e!s}"
            ) from e

        if isinstance(raw, dict):
            deleted = [str(v) for v in (raw.get("VolumesDeleted") or [])]
            reclaimed = _as_int(raw.get("SpaceReclaimed"))
        elif isinstance(raw, list):
            deleted = [str(v) for v in raw]
            reclaimed = 0
        else:
            deleted = []
            reclaimed = 0

        if not deleted:
            message = "No hay volúmenes sin uso: nada que limpiar"
        elif len(deleted) == 1:
            message = f"Se liberó 1 volumen ({deleted[0]})"
        else:
            message = f"Se liberaron {len(deleted)} volúmenes"

        return VolumePruneResult(
            deleted=deleted, bytes_reclaimed=reclaimed, message=message
        )

    @staticmethod
    async def count_unused(docker: aiodocker.Docker) -> dict[str, Any]:
        """Resumen previo a la limpieza, para que el diálogo diga qué va a pasar."""
        volumes = await VolumeService.list_volumes(docker)
        unused = [v for v in volumes if v.ref_count == 0]
        return {
            "count": len(unused),
            "bytes": sum(v.size for v in unused),
            "names": [v.name for v in unused],
        }


async def _containers_using(docker: aiodocker.Docker, volume_name: str) -> list[str]:
    """Nombres de los contenedores que montan el volumen.

    `/volumes/{name}` **no** incluye ningún campo `Containers` (comprobado
    contra el daemon), así que la única fuente es el listado de contenedores,
    donde cada entrada trae sus `Mounts` con `Type: "volume"` y `Name`.

    Se usa `all=True` a propósito: un contenedor detenido sigue usándolo y
    cuenta para el `RefCount` que informa `/system/df`. Es una sola llamada,
    no una por volumen.

    Puede devolver una lista vacía mientras `ref_count > 0` si el daemon
    acaba de perder la referencia; esa discrepancia se muestra en la interfaz
    en lugar de ocultarse.
    """
    try:
        raw_containers = await docker.containers.list(all=True)
    except Exception:
        return []

    names: list[str] = []
    for entry in _raw_container_entries(raw_containers):
        for mount in entry.get("Mounts") or []:
            if not isinstance(mount, dict):
                continue
            if mount.get("Type") != "volume" or mount.get("Name") != volume_name:
                continue
            container_names = entry.get("Names") or []
            label = None
            if isinstance(container_names, list) and container_names:
                first = container_names[0]
                label = str(first).lstrip("/")
            names.append(label or _short_id(entry.get("Id") or ""))
    return names


def _raw_container_entries(raw: Any) -> list[dict]:
    if isinstance(raw, dict):
        raw = raw.get("Containers") or []
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for item in raw:
        info = getattr(item, "_container", None)
        if isinstance(info, dict):
            out.append(info)
        elif isinstance(item, dict):
            out.append(item)
    return out


def _short_id(container_id: str) -> str:
    return container_id[:12] if len(container_id) > 12 else container_id
