# SPDX-License-Identifier: AGPL-3.0-or-later
from typing import Any

from pydantic import BaseModel, Field


class VolumeSummary(BaseModel):
    name: str = Field(..., description="Nombre del volumen; 64 hex indica uno anónimo")
    driver: str = "local"
    mountpoint: str = Field("", description="Ruta en el host de los datos")
    scope: str = "local"
    created_at: str = Field("", description="Fecha de creación en ISO 8601")
    size: int = Field(0, description="Tamaño en bytes; 0 si el daemon no lo informa")
    ref_count: int = Field(0, description="Contenedores que usan el volumen; 0 = eliminable")
    is_anonymous: bool = Field(
        False, description="True si el nombre es un hash de 64 hex"
    )
    labels: dict[str, str] = Field(default_factory=dict)
    compose_project: str | None = Field(
        None,
        description="Proyecto Docker Compose al que pertenece, si la etiqueta existe (SPEC-11)",
    )


class VolumeDetail(VolumeSummary):
    options: dict[str, Any] = Field(default_factory=dict)
    containers: list[str] = Field(
        default_factory=list, description="Nombres de los contenedores que lo usan"
    )


class VolumePruneResult(BaseModel):
    deleted: list[str] = Field(default_factory=list)
    bytes_reclaimed: int = Field(0, description="Espacio recuperado en bytes")
    message: str


class VolumeDeleteResponse(BaseModel):
    name: str
    deleted: bool
    message: str
