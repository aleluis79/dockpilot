# SPDX-License-Identifier: AGPL-3.0-or-later
from pydantic import BaseModel, Field


class SystemInfo(BaseModel):
    server_version: str = Field(
        "", description="Versión del Docker Engine, p. ej. 29.8.1"
    )
    os_name: str = Field("", description="Sistema operativo del host")
    os_type: str = "linux"
    architecture: str = ""
    kernel_version: str = ""
    hostname: str = ""
    ncpu: int = Field(0, description="Núcleos lógicos")
    memory_total: int = Field(0, description="Memoria RAM total en bytes")
    storage_driver: str = Field("", description="Driver de almacenamiento, p. ej. overlayfs")
    docker_root_dir: str = Field("", description="Ruta de la raíz de Docker en el host")
    containers_total: int = 0
    containers_running: int = 0
    containers_stopped: int = 0
    containers_paused: int = 0
    images_total: int = 0


class ResourceUsage(BaseModel):
    """Uso y recuperabilidad de un tipo de recurso."""

    total_count: int = 0
    active_count: int = 0
    total_size: int = Field(0, description="Tamaño total en bytes")
    reclaimable: int = Field(
        0, description="Bytes que el daemon considera recuperables"
    )


class DiskUsage(BaseModel):
    layers_size: int = Field(
        0, description="Tamaño de las capas de imagen compartidas"
    )
    images: ResourceUsage
    containers: ResourceUsage
    volumes: ResourceUsage
    build_cache_size: int = 0


class TopConsumer(BaseModel):
    """Mayor consumidor de espacio, para señalar dónde mirar."""

    kind: str = Field(..., description="'image' | 'container' | 'volume'")
    name: str
    size: int = 0
    detail: str = ""


class SystemOverview(BaseModel):
    """Payload único para la franja de resumen y su panel de detalle."""

    info: SystemInfo
    usage: DiskUsage
    top_images: list[TopConsumer] = Field(default_factory=list)
    top_volumes: list[TopConsumer] = Field(default_factory=list)
