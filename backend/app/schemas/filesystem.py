# SPDX-License-Identifier: AGPL-3.0-or-later
"""Contratos de los ficheros de un contenedor (SPEC-20).

Lo que se ve desde aquí es el filesystem **del contenedor**, incluidos sus
montajes. Los `..` y los symlinks se resuelven dentro de su namespace y no hay
traversal: el límite real es el mismo que tiene `docker exec`, que el panel ya
expone (SPEC-05). Escribir o leer a través de un `-v` sale al host, y eso no es
un fallo de esta API sino la frontera de Docker.
"""

from enum import StrEnum

from pydantic import BaseModel, Field


class FileKind(StrEnum):
    FILE = "file"
    DIR = "dir"
    SYMLINK = "symlink"
    # sockets, fifos y dispositivos: se listan para que el usuario vea que están
    # ahí, pero no se pueden ni abrir ni subir.
    OTHER = "other"


class ContainerEntry(BaseModel):
    name: str
    kind: FileKind
    size: int = 0
    symlink_target: str | None = None


class ListDirectoryResult(BaseModel):
    container_id: str
    path: str
    parent: str | None = Field(
        None, description="Directorio padre, o None si ya se está en la raíz"
    )
    entries: list[ContainerEntry] = Field(default_factory=list)
    # El truncado se comunica en la respuesta en lugar de ocurrir en silencio: un
    # listado que parece completo y no lo es es la misma traición que el plan de
    # compose sin `profiles` (SPEC-14 §3.4).
    truncated: bool = False


class DownloadFileRequest(BaseModel):
    path: str = Field(..., description="Ruta dentro del contenedor. Nunca del host.")


class UploadFileRequest(BaseModel):
    path: str = Field(..., description="Directorio destino DENTRO del contenedor")
    overwrite: bool = True
