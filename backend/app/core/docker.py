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
