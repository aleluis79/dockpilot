import asyncio
from typing import Any

import aiodocker
from aiodocker.exceptions import DockerError
from fastapi import HTTPException

from app.core.docker import docker_error_message
from app.schemas.system import (
    DiskUsage,
    ResourceUsage,
    SystemInfo,
    SystemOverview,
    TopConsumer,
)

SYSTEM_DF_ENDPOINT = "system/df"

TOP_CONSUMERS_LIMIT = 5


class SystemService:
    """Acceso a los datos globales del daemon.

    `aiodocker.system` solo expone `info()`. El consumo de disco (`/system/df`)
    no tiene método propio, así que se obtiene con `_query_json`, que es la
    misma vía que usa la librería por dentro (SPEC-08 §3.5).

    Cada dato va en dos pasos: un `fetch_*` que devuelve el payload crudo y
    un `get_*` que lo traduce al contrato de la API. Así el error del daemon
    se maneja en un solo sitio y el mapeo se puede probar sin HTTP.
    """

    # ------------------------------------------------------------------ crudos

    @staticmethod
    async def fetch_disk_usage(docker: aiodocker.Docker) -> dict[str, Any]:
        """Payload crudo de `/system/df`, sin normalizar.

        Lo comparten SPEC-08 (tamaño de volúmenes) y SPEC-09 (vista completa).
        """
        try:
            data = await docker._query_json(SYSTEM_DF_ENDPOINT)
        except DockerError as e:
            raise HTTPException(
                status_code=503,
                detail=f"Error al consultar el consumo de disco: {docker_error_message(e)}",
            ) from e
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"Error inesperado al consultar el consumo de disco: {e!s}",
            ) from e
        return data or {}

    @staticmethod
    async def fetch_system_info(docker: aiodocker.Docker) -> dict[str, Any]:
        """Payload crudo de `/info`."""
        try:
            data = await docker.system.info()
        except DockerError as e:
            raise HTTPException(
                status_code=503,
                detail=f"Error al consultar la información del sistema: {docker_error_message(e)}",
            ) from e
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"Error inesperado al consultar la información del sistema: {e!s}",
            ) from e
        return data or {}

    # ----------------------------------------------------------------- tipados

    @staticmethod
    async def get_system_info(docker: aiodocker.Docker) -> SystemInfo:
        """`/info` traducido al contrato de la API.

        El daemon usa nombres propios (`ServerVersion`, `MemTotal`, `Driver`),
        así que se renombran aquí en lugar de exponerlos tal cual.
        """
        return _build_info(await SystemService.fetch_system_info(docker))

    @staticmethod
    async def get_disk_usage(docker: aiodocker.Docker) -> DiskUsage:
        """`/system/df` normalizado a los cuatro bloques de uso.

        Los agregados están en `ImageUsage`/`ContainerUsage`/`VolumeUsage`. Los
        bloques legacy `Images`/`Containers`/`Volumes` llegan vacíos y se
        ignoran a propósito (SPEC-09 §3.2).
        """
        return _build_usage(await SystemService.fetch_disk_usage(docker))

    @staticmethod
    async def get_overview(docker: aiodocker.Docker) -> SystemOverview:
        """Vista completa en una sola respuesta para la interfaz.

        Llama una vez a cada endpoint y reutiliza el resultado, de modo que el
        endpoint no suma latencia ni duplica consultas al daemon.
        """
        raw_info, raw_df = await asyncio.gather(
            SystemService.fetch_system_info(docker),
            SystemService.fetch_disk_usage(docker),
        )
        return SystemOverview(
            info=_build_info(raw_info),
            usage=_build_usage(raw_df),
            top_images=_top_consumers(
                raw_df.get("ImageUsage"), "image", await _image_name_map(docker)
            ),
            top_volumes=_top_consumers(raw_df.get("VolumeUsage"), "volume", {}),
        )


async def _image_name_map(docker: aiodocker.Docker) -> dict[str, str]:
    """Mapa `Id` -> nombre legible de imagen, construido con `/images/json`.

    Los `Items` de `ImageUsage` **no** traen `Names` (comprobado contra el
    daemon), así que sin este mapa la lista de mayores consumidores de imágenes
    saldría vacía. Es una sola llamada y solo la necesita el endpoint de vista
    completa.

    Un `RepoTags` vacio o con `<none>:<none>` ocurre en imagenes sin
    etiqueta; en ese caso se cae al `Id` corto.
    """
    try:
        images = await docker.images.list()
    except Exception:
        return {}

    mapping: dict[str, str] = {}
    for image in images or []:
        info = getattr(image, "_container", None)
        if not isinstance(info, dict):
            info = image if isinstance(image, dict) else None
        if not isinstance(info, dict):
            continue
        image_id = _as_str(info.get("Id"))
        if not image_id:
            continue
        name = _first_repo_tag(info.get("RepoTags"))
        mapping[image_id] = name or _short_id(image_id)
    return mapping


def _first_repo_tag(repo_tags: Any) -> str:
    if not isinstance(repo_tags, list):
        return ""
    for tag in repo_tags:
        text = _as_str(tag)
        # `<none>:<none>` es la etiqueta que el daemon da a las imágenes sin
        # etiqueta: no sirve para identificar nada.
        if text and text != "<none>:<none>":
            return text
    return ""


def _build_info(raw: dict[str, Any]) -> SystemInfo:
    """Mapea `/info`. Cada campo pasa por `_as_int` porque el daemon devuelve
    `0` en lugar de `null` cuando no puede medir algo."""
    return SystemInfo(
        server_version=_as_str(raw.get("ServerVersion")),
        os_name=_as_str(raw.get("OperatingSystem")),
        os_type=_as_str(raw.get("OSType")) or "linux",
        architecture=_as_str(raw.get("Architecture")),
        kernel_version=_as_str(raw.get("KernelVersion")),
        hostname=_as_str(raw.get("Name")),
        ncpu=_as_int(raw.get("NCPU")),
        memory_total=_as_int(raw.get("MemTotal")),
        storage_driver=_as_str(raw.get("Driver")),
        docker_root_dir=_as_str(raw.get("DockerRootDir")),
        containers_total=_as_int(raw.get("Containers")),
        containers_running=_as_int(raw.get("ContainersRunning")),
        containers_stopped=_as_int(raw.get("ContainersStopped")),
        containers_paused=_as_int(raw.get("ContainersPaused")),
        images_total=_as_int(raw.get("Images")),
    )


def _build_usage(raw: dict[str, Any]) -> DiskUsage:
    """Mapea `/system/df` a los cuatro bloques de uso.

    `layers_size` se mantiene aparte a propósito: son capas compartidas entre
    imágenes, y sumarlas al total de imágenes lo contaría dos veces.
    """
    return DiskUsage(
        layers_size=_as_int(raw.get("LayersSize")),
        images=_resource_usage(raw.get("ImageUsage")),
        containers=_resource_usage(raw.get("ContainerUsage")),
        volumes=_resource_usage(raw.get("VolumeUsage")),
        build_cache_size=_as_int(raw.get("BuildCacheUsage")),
    )


def _resource_usage(block: Any) -> ResourceUsage:
    """Traduce un bloque `<X>Usage` a `ResourceUsage`.

    Tolera `None` y tipos inesperados: un daemon que omita un bloque produce
    ceros en lugar de un error.
    """
    if not isinstance(block, dict):
        return ResourceUsage()
    return ResourceUsage(
        total_count=_as_int(block.get("TotalCount")),
        active_count=_as_int(block.get("ActiveCount")),
        total_size=_as_int(block.get("TotalSize")),
        reclaimable=_as_int(block.get("Reclaimable")),
    )


def _top_consumers(
    block: Any, kind: str, name_map: dict[str, str] | None = None
) -> list[TopConsumer]:
    """Mayores consumidores de un bloque, de mayor a menor.

    Se leen los `Items`, no los bloques legacy: los volúmenes llevan su nombre
    en `Name` y las imágenes en `Names`.
    """
    if not isinstance(block, dict):
        return []
    items = block.get("Items")
    if not isinstance(items, list):
        return []

    consumers: list[TopConsumer] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        name = _consumer_name(item, kind, name_map or {})
        if not name:
            continue
        consumers.append(
            TopConsumer(
                kind=kind,
                name=name,
                size=_item_size(item, kind),
                detail=_consumer_detail(item),
            )
        )

    consumers.sort(key=lambda c: c.size, reverse=True)
    return consumers[:TOP_CONSUMERS_LIMIT]


def _item_size(item: dict, kind: str) -> int:
    """Tamano de un item de `Items`.

    Imagenes y contenedores traen `Size` a nivel de item, pero los volumenes lo
    anidan en `UsageData.Size`: leido en el sitio equivocado devuelve 0.
    """
    if kind == "volume":
        usage_data = item.get("UsageData")
        if isinstance(usage_data, dict):
            return _as_int(usage_data.get("Size"))
        return 0
    return _as_int(item.get("Size"))


def _consumer_name(item: dict, kind: str, name_map: dict[str, str]) -> str:
    """Nombre de un consumidor, con cadena de respaldo.

    Para volúmenes el daemon ya da `Name`. Para imágenes no hay nombre, así que
    se resuelve por `Id` contra el mapa de `/images/json` y, si tampoco está,
    se usa el Id corto: un identificador feo es mejor que esconder un
    consumidor grande de disco.
    """
    if kind == "volume":
        return _as_str(item.get("Name"))

    names = item.get("Names")
    if isinstance(names, list) and names:
        first = _as_str(names[0])
        if first:
            return first.lstrip("/")
    plain = _as_str(item.get("Name"))
    if plain:
        return plain

    image_id = _as_str(item.get("Id"))
    if not image_id:
        return ""
    return name_map.get(image_id) or _short_id(image_id)


def _short_id(image_id: str) -> str:
    """Id abreviado conservando el prefijo `sha256:`.

    Se mantiene el prefijo a proposito: sin el, un id suelto no se distingue de
    un nombre de imagen, y el detalle debe ser inequivoco.
    """
    return image_id[:19] if len(image_id) > 19 else image_id


def _consumer_detail(item: dict) -> str:
    """Texto auxiliar: para imágenes, cuántos contenedores las usan."""
    containers = item.get("Containers")
    if isinstance(containers, int) and not isinstance(containers, bool):
        if containers > 0:
            plural = "s" if containers != 1 else ""
            return f"Usada por {containers} contenedor{plural}"
        if containers < 0:
            return "Contenedores desconocidos"
    return "Sin usar"


def _as_int(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return 0
    return 0


def _as_str(value: Any) -> str:
    return value if isinstance(value, str) else ""
