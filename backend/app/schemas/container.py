# SPDX-License-Identifier: AGPL-3.0-or-later
from typing import Any, Literal

from pydantic import BaseModel, Field


class PortMapping(BaseModel):
    ip: str | None = "0.0.0.0"
    private_port: int
    public_port: int | None = None
    type: str = "tcp"


# Los cuatro estados que distingue el daemon. `none` NO es "sin sickness": es
# "no hay healthcheck declarado", que es la ausencia del dato y no un valor
# más. Un `Literal` en vez de `str` para que un estado desconocido del daemon
# no entre por la puerta de atrás y acabe pintado como si fuera sano (SPEC-18).
HealthStatus = Literal["healthy", "unhealthy", "starting", "none"]


class HealthSummary(BaseModel):
    """Salud del contenedor, o el hecho de que no tenga healthcheck.

    Es un objeto y no un `str` porque "no healthcheck" no es un estado más: es
    la ausencia del dato, y confundida con `"none"` haría que un contenedor sin
    sonda pareciera evaluado y saliendo bien.
    """

    status: HealthStatus = "none"
    failing_streak: int = 0


class HealthProbe(BaseModel):
    """Una sonda ya ejecutada por el daemon."""

    started_at: str = Field("", description="Inicio en ISO-8601")
    finished_at: str = Field("", description="Fin en ISO-8601")
    exit_code: int = 0
    output: str = Field("", description="Salida de la sonda, vacía si no dijo nada")


class HealthDetail(HealthSummary):
    """Salud con el porqué. Solo en el detalle, que es donde hay `inspect`.

    El listado **no** trae `Log`, así que un `HealthSummary` del listado no
    puede llevar historial: por eso `log` vive aquí y no en el resumen.
    """

    log: list[HealthProbe] = Field(default_factory=list)
    test: list[str] = Field(
        default_factory=list,
        description="Config.Healthcheck.Test de la imagen; vacía si no hay healthcheck",
    )


class ContainerSummary(BaseModel):
    id: str
    name: str
    image: str
    status: str  # "running", "exited", "paused", "restarting", "created", etc.
    state: str   # Raw Docker state string
    created: int # Epoch timestamp (seconds)
    ports: list[PortMapping] = Field(default_factory=list)
    compose_project: str | None = Field(
        None,
        description="Proyecto Docker Compose al que pertenece, si la etiqueta existe (SPEC-11)",
    )
    health: HealthSummary = Field(default_factory=HealthSummary)


class ContainerDetail(ContainerSummary):
    command: str | None = None
    env: list[str] = Field(default_factory=list)
    labels: dict[str, str] = Field(default_factory=dict)
    mounts: list[dict[str, Any]] = Field(default_factory=list)
    networks: list[str] = Field(default_factory=list)
    # `health` se hereda de `ContainerSummary` pero **se re-declara** aquí con el
    # tipo más estrecho. No es opcional: Pydantic recorta el valor al tipo
    # declarado en el padre, así que si `ContainerDetail` no lo re-declarase,
    # un `HealthDetail` entero se serializaría como `HealthSummary` y `log` y
    # `test` desaparecerían de la respuesta sin dar ningún error (SPEC-18 §2.1).
    health: HealthDetail = Field(default_factory=HealthDetail)
    # NO hay `network_mode`: `HostConfig.NetworkMode` es sólo la red **principal**
    # y dice `bridge` para un contenedor que además está conectado a una red
    # propia, que es justo el caso en el que el nombre sí es un nombre DNS. El
    # conjunto de redes Attached ya está en `networks`, y de ahí lo deduce el
    # cliente (SPEC-19 §3.3).


class RenameContainerRequest(BaseModel):
    name: str = Field(..., description="Nombre nuevo del contenedor")


class RenameContainerResponse(BaseModel):
    id: str
    old_name: str
    new_name: str
    message: str


class ContainerActionResponse(BaseModel):
    id: str
    action: str
    success: bool
    message: str


class PortBindingConfig(BaseModel):
    host_port: int
    container_port: int
    protocol: str = "tcp"


class VolumeBindingConfig(BaseModel):
    host_path: str
    container_path: str
    mode: str = "rw"


class CreateContainerRequest(BaseModel):
    image: str = Field(..., description="Nombre y tag de la imagen, ej. nginx:alpine")
    name: str | None = Field(None, description="Nombre deseado para el contenedor")
    ports: list[PortBindingConfig] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict, description="Variables de entorno clave-valor")
    volumes: list[VolumeBindingConfig] = Field(default_factory=list)
    command: str | None = Field(None, description="Comando opcional para sobrescribir CMD")
    restart_policy: str = Field("no", description="Política: no, always, unless-stopped, on-failure")
    start_now: bool = Field(True, description="Arrancar el contenedor inmediatamente tras crearlo")


class CreateContainerResponse(BaseModel):
    id: str
    name: str
    image: str
    status: str
    started: bool
    message: str
