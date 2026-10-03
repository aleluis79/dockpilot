# SPDX-License-Identifier: AGPL-3.0-or-later
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


class ImagePrunePreview(BaseModel):
    """Qué se iría con cada nivel de limpieza (SPEC-21).

    Se calcula leyendo `GET /images/json`, no preguntando a un prune: no hay
    forma de preguntarle a Docker qué borraría sin borrarlo. Por eso es una
    **cota superior** y no una promesa, y por eso `in_use_dangling` va aparte:
    una imagen sin etiqueta que usa un contenedor no es podable, y contarla
    entre las que sí lo son haría mentir al diálogo justo en el número que el
    usuario está mirando.
    """

    # Nivel seguro: sin etiqueta y sin contenedores que la usen.
    dangling_count: int = 0
    dangling_bytes: int = Field(0, description="Cota superior: las capas compartidas se cuentan dos veces")
    dangling_ids: list[str] = Field(default_factory=list)
    # Nivel agresivo: con etiqueta, y por tanto volver a descargables.
    tagged_count: int = 0
    tagged_bytes: int = Field(0, description="Cota superior, por el mismo motivo")
    tagged_refs: list[str] = Field(default_factory=list)
    in_use_dangling: int = Field(0, description="Imágenes sin etiqueta en uso: el daemon no las borrará")


class ImagePruneResult(BaseModel):
    """Los mismos tres campos que `VolumePruneResult` y `NetworkPruneResult`, y
    con el mismo nombre, más uno que sólo este endpoint necesita.

    `kept` existe porque **el nivel agresivo es un bucle**, no una llamada: borra
    imagen a imagen con `DELETE /images/{id}`, y cada una puede fallar por su
    cuenta —el caso normal es que alguien haya arrancado un contenedor con esa
    imagen entre el preaviso y el botón—. Un resultado que sólo dijera «3 de 6»
    obligaría al usuario a adivinar cuáles tres; los nombres de las que se
    quedaron son la información que falta para decidir si reintentar.
    """

    deleted: list[str] = Field(default_factory=list)
    bytes_reclaimed: int = Field(0, description="Espacio recuperado en bytes")
    message: str
    kept: list[str] = Field(
        default_factory=list,
        description="Etiquetas que el daemon no dejó borrar, con su motivo",
    )
