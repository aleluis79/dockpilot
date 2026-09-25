import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_list_local_images(async_client: AsyncClient):
    """GET /api/v1/images/local devuelve las imágenes almacenadas localmente."""
    response = await async_client.get("/api/v1/images/local")
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    assert len(data) >= 2
    assert "nginx:alpine" in data[0]["tags"]
    assert data[0]["size"] > 0


@pytest.mark.asyncio
async def test_search_images_hub(async_client: AsyncClient):
    """GET /api/v1/images/search?term=redis busca en Docker Hub."""
    response = await async_client.get("/api/v1/images/search?term=redis&limit=5")
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    assert len(data) >= 1
    assert data[0]["name"] == "redis"
    assert data[0]["is_official"] is True
    assert data[0]["star_count"] > 0


@pytest.mark.asyncio
async def test_search_images_empty_term(async_client: AsyncClient):
    """GET /api/v1/images/search sin término devuelve 400."""
    response = await async_client.get("/api/v1/images/search?term=")
    assert response.status_code == 400
    assert "detail" in response.json()
