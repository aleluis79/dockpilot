import aiodocker

from app.core.config import settings

_docker_client: aiodocker.Docker | None = None


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
