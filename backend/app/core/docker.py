# SPDX-License-Identifier: AGPL-3.0-or-later
import aiodocker

from app.core.config import settings

_docker_client: aiodocker.Docker | None = None


def docker_error_message(exc: object) -> str:
    """Extrae el texto de error de un `DockerError` de aiodocker.

    `DockerError.message` está anotado como `str`, pero cuando el daemon
    responde con un cuerpo JSON, aiodocker guarda el diccionario completo
    (`{'message': "..."}`). Pasarlo tal cual a un campo `detail: str` revienta
    la validación de Pydantic, y a un `detail` sin tipar produce un objeto JSON
    que el frontend acaba mostrando como "[object Object]".
    """
    raw = getattr(exc, "message", None)
    if isinstance(raw, dict):
        return str(raw.get("message") or raw.get("error") or raw)
    return str(raw) if raw else str(exc)


def docker_error_status(exc: object) -> int:
    """Traduce el `status` de un `DockerError` a un código HTTP servible.

    aiodocker usa el 900 como "no pude hablar con el daemon"
    (`DockerError(900, "Cannot connect to Docker Engine...")`). Ese 900 no es un
    código HTTP: pasarlo tal cual a `HTTPException` hace que uvicorn	indexe
    `STATUS_LINE[900]` y reviente con `KeyError`, dejando al cliente sin
    respuesta (`curl: (52) Empty reply from server`).

    Tampoco valen los códigos de la serie 1xx/2xx/3xx, porque un
    `HTTPException` con cualquiera de ellos no puede llevar cuerpo de error.
    Todo lo que no encaje se traduce a 503, que es lo que significa de verdad:
    el daemon no está disponible.
    """
    status = getattr(exc, "status", 0)
    if isinstance(status, bool) or not isinstance(status, int):
        return 503
    if 400 <= status < 600:
        return status
    return 503


async def init_docker() -> aiodocker.Docker:
    global _docker_client
    if _docker_client is None:
        _docker_client = aiodocker.Docker(url=settings.DOCKER_SOCKET)
    return _docker_client


async def close_docker() -> None:
    global _docker_client
    if _docker_client is not None:
        await _docker_client.close()
        _docker_client = None


async def get_docker() -> aiodocker.Docker:
    global _docker_client
    if _docker_client is None:
        return await init_docker()
    return _docker_client
