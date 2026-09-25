import pytest
from httpx import AsyncClient
from aiodocker.exceptions import DockerError


@pytest.mark.asyncio
async def test_list_containers_general(async_client: AsyncClient):
    """Escenario: Listado general de contenedores."""
    response = await async_client.get("/api/v1/containers")
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    assert len(data) >= 2
    
    first = data[0]
    assert "id" in first
    assert "name" in first
    assert "image" in first
    assert "status" in first
    assert "ports" in first


@pytest.mark.asyncio
async def test_filter_containers_by_status(async_client: AsyncClient):
    """Escenario: Filtrado de contenedores por estado."""
    response = await async_client.get("/api/v1/containers?status=running")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["status"] == "running"
    assert data[0]["id"] == "c123"


@pytest.mark.asyncio
async def test_get_container_detail(async_client: AsyncClient):
    """Inspeccionar detalle de un contenedor."""
    response = await async_client.get("/api/v1/containers/c123")
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == "c123"
    assert data["name"] == "web-app"
    assert "command" in data
    assert "env" in data
    assert "labels" in data


@pytest.mark.asyncio
async def test_stop_container_success(async_client: AsyncClient):
    """Escenario: Detener un contenedor en ejecución exitosamente."""
    response = await async_client.post("/api/v1/containers/c123/stop")
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == "c123"
    assert data["action"] == "stop"
    assert data["success"] is True


@pytest.mark.asyncio
async def test_start_container_success(async_client: AsyncClient):
    """Escenario: Iniciar un contenedor detenido exitosamente."""
    response = await async_client.post("/api/v1/containers/c456/start")
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == "c456"
    assert data["action"] == "start"
    assert data["success"] is True


@pytest.mark.asyncio
async def test_restart_container_success(async_client: AsyncClient):
    """Escenario: Reiniciar un contenedor."""
    response = await async_client.post("/api/v1/containers/c123/restart")
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == "c123"
    assert data["action"] == "restart"
    assert data["success"] is True


@pytest.mark.asyncio
async def test_pause_and_unpause_container(async_client: AsyncClient):
    """Pausar y reactivar contenedor."""
    pause_res = await async_client.post("/api/v1/containers/c123/pause")
    assert pause_res.status_code == 200
    assert pause_res.json()["action"] == "pause"

    unpause_res = await async_client.post("/api/v1/containers/c123/unpause")
    assert unpause_res.status_code == 200
    assert unpause_res.json()["action"] == "unpause"


@pytest.mark.asyncio
async def test_remove_container_stopped_success(async_client: AsyncClient, mock_docker):
    """Escenario: Eliminar un contenedor detenido."""
    response = await async_client.delete("/api/v1/containers/c456")
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == "c456"
    assert data["action"] == "remove"
    assert data["success"] is True


@pytest.mark.asyncio
async def test_remove_running_container_conflict(async_client: AsyncClient):
    """Escenario: Intentar eliminar un contenedor en ejecución sin forzar."""
    response = await async_client.delete("/api/v1/containers/c123?force=false")
    assert response.status_code == 409
    data = response.json()
    assert "detail" in data


@pytest.mark.asyncio
async def test_remove_running_container_forced(async_client: AsyncClient):
    """Eliminar un contenedor en ejecución con force=true."""
    response = await async_client.delete("/api/v1/containers/c123?force=true")
    assert response.status_code == 200
    assert response.json()["success"] is True


@pytest.mark.asyncio
async def test_container_not_found(async_client: AsyncClient):
    """Escenario: Operar sobre un contenedor que no existe."""
    response = await async_client.get("/api/v1/containers/inexistente-000")
    assert response.status_code == 404
    data = response.json()
    assert "detail" in data


@pytest.mark.asyncio
async def test_docker_daemon_unavailable(async_client: AsyncClient, mock_docker):
    """Escenario: Error de comunicación con el daemon Docker."""
    mock_docker.containers.list.side_effect = DockerError(500, {"message": "Docker daemon unavailable"})
    response = await async_client.get("/api/v1/containers")
    assert response.status_code in [500, 503]
