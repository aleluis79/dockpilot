from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field


class PortMapping(BaseModel):
    ip: Optional[str] = "0.0.0.0"
    private_port: int
    public_port: Optional[int] = None
    type: str = "tcp"


class ContainerSummary(BaseModel):
    id: str
    name: str
    image: str
    status: str  # "running", "exited", "paused", "restarting", "created", etc.
    state: str   # Raw Docker state string
    created: int # Epoch timestamp (seconds)
    ports: List[PortMapping] = Field(default_factory=list)


class ContainerDetail(ContainerSummary):
    command: Optional[str] = None
    env: List[str] = Field(default_factory=list)
    labels: Dict[str, str] = Field(default_factory=dict)
    mounts: List[Dict[str, Any]] = Field(default_factory=list)
    networks: List[str] = Field(default_factory=list)


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
    name: Optional[str] = Field(None, description="Nombre deseado para el contenedor")
    ports: List[PortBindingConfig] = Field(default_factory=list)
    env: Dict[str, str] = Field(default_factory=dict, description="Variables de entorno clave-valor")
    volumes: List[VolumeBindingConfig] = Field(default_factory=list)
    command: Optional[str] = Field(None, description="Comando opcional para sobrescribir CMD")
    restart_policy: str = Field("no", description="Política: no, always, unless-stopped, on-failure")
    start_now: bool = Field(True, description="Arrancar el contenedor inmediatamente tras crearlo")


class CreateContainerResponse(BaseModel):
    id: str
    name: str
    image: str
    status: str
    started: bool
    message: str
