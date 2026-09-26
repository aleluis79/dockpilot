# SPDX-License-Identifier: AGPL-3.0-or-later
from typing import Any

from pydantic import BaseModel, Field


class NetworkSubnet(BaseModel):
    subnet: str = Field("", description="CIDR de la subred, p. ej. 172.18.0.0/16")
    gateway: str = Field("", description="Puerta de enlace de la subred")


class NetworkSummary(BaseModel):
    id: str = ""
    name: str
    driver: str = "bridge"
    scope: str = "local"
    internal: bool = Field(False, description="Sin salida a internet")
    attachable: bool = False
    enable_ipv6: bool = False
    created: str = Field("", description="Fecha de creación en ISO 8601")
    subnets: list[NetworkSubnet] = Field(default_factory=list)
    container_count: int = Field(0, description="Contenedores conectados; 0 = eliminable")
    is_builtin: bool = Field(
        False,
        description="Red predefinida de Docker (none, host, bridge); no se puede borrar",
    )


class NetworkDetail(NetworkSummary):
    options: dict[str, Any] = Field(default_factory=dict)
    labels: dict[str, str] = Field(default_factory=dict)
    containers: list[str] = Field(default_factory=list, description="Nombres de los contenedores conectados")


class CreateNetworkRequest(BaseModel):
    name: str = Field(
        ...,
        min_length=1,
        max_length=63,
        description="Nombre de la red",
    )
    driver: str = Field("bridge", description="Solo se admite 'bridge' en esta versión")
    subnet: str | None = Field(None, description="CIDR de la subred")
    gateway: str | None = Field(None, description="Se ignora si no se indica subred")
    internal: bool = Field(False, description="Crear la red sin salida a internet")
    labels: dict[str, str] = Field(default_factory=dict)


class NetworkDeleteResponse(BaseModel):
    name: str
    deleted: bool
    message: str


class NetworkPruneResult(BaseModel):
    deleted: list[str] = Field(default_factory=list)
    message: str = ""
