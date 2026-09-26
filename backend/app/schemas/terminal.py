from typing import Literal

from pydantic import BaseModel, Field


class TerminalResizeMessage(BaseModel):
    type: Literal["resize"] = "resize"
    cols: int = Field(..., ge=10, le=500, description="Número de columnas de la terminal")
    rows: int = Field(..., ge=5, le=200, description="Número de filas de la terminal")


class TerminalInputMessage(BaseModel):
    type: Literal["stdin"] = "stdin"
    data: str = Field(..., description="Caracteres o secuencias de escape enviados a la entrada estándar")


class TerminalServerMessage(BaseModel):
    type: Literal["stdout", "system", "error"]
    data: str | None = Field(None, description="Datos emitidos por el stream de terminal")
    message: str | None = Field(None, description="Mensaje de error o notificación del sistema")
