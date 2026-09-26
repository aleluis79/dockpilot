from typing import Any, Literal

from pydantic import BaseModel, Field


class ImageSearchResult(BaseModel):
    name: str
    description: str = ""
    is_official: bool = False
    star_count: int = 0


class LocalImageSummary(BaseModel):
    id: str
    tags: list[str] = Field(default_factory=list)
    size: int = 0
    created: int = 0
    containers: int = Field(
        0, description="Contenedores que usan esta imagen (0 = eliminable sin force)"
    )
    repo_digests: list[str] = Field(default_factory=list)


class ImageHistoryEntry(BaseModel):
    id: str = Field(..., description="ID de la capa")
    created: int = Field(0, description="Epoch de creación de la capa")
    created_by: str = Field("", description="Instrucción Dockerfile que creó la capa")
    size: int = Field(0, description="Tamaño de la capa en bytes")
    comment: str = ""
    tags: list[str] | None = None


class ImageDetail(BaseModel):
    id: str
    tags: list[str] = Field(default_factory=list)
    repo_digests: list[str] = Field(default_factory=list)
    size: int = 0
    created: int = 0
    architecture: str = ""
    os: str = ""
    entrypoint: list[str] | None = None
    cmd: list[str] | None = None
    env: list[str] = Field(default_factory=list)
    exposed_ports: dict[str, Any] = Field(default_factory=dict)
    working_dir: str = ""
    user: str = ""
    labels: dict[str, str] = Field(default_factory=dict)
    layer_count: int = Field(0, description="Número de capas del RootFS")
    history: list[ImageHistoryEntry] = Field(default_factory=list)


class ImagePullMessage(BaseModel):
    """Mensaje del canal de descarga.

    Modelo plano con campos opcionales, en línea con `TerminalServerMessage`.
    Campos válidos por tipo:

    - ``start``: image
    - ``layer``: image, id, status, current, total, progress
    - ``digest``: image, digest
    - ``done``: image, id, tags
    - ``error``: image, code, message
    """

    type: Literal["start", "layer", "digest", "done", "error"]
    image: str
    id: str | None = None
    status: str | None = None
    current: int | None = None
    total: int | None = None
    progress: str | None = None
    digest: str | None = None
    tags: list[str] | None = None
    code: int | None = None
    message: str | None = None


class ImageDeleteResponse(BaseModel):
    id: str
    deleted: bool
    untagged: list[str] = Field(
        default_factory=list, description="Tags que han quedado sin referenciar"
    )
    message: str
