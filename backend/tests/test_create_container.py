# SPDX-License-Identifier: AGPL-3.0-or-later
import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_create_container_minimal(async_client: AsyncClient):
    """Escenario: Creación básica de contenedor con auto-arranque."""
    payload = {
        "image": "nginx:alpine",
        "name": "my-web-app",
        "start_now": True,
    }
    response = await async_client.post("/api/v1/containers", json=payload)
    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "my-web-app"
    assert data["image"] == "nginx:alpine"
    assert data["started"] is True
    assert data["status"] == "running"
    assert "id" in data


@pytest.mark.asyncio
async def test_create_container_with_ports_and_env(async_client: AsyncClient):
    """Escenario: Creación con mapeo de puertos y variables de entorno."""
    payload = {
        "image": "postgres:16-alpine",
        "name": "my-postgres",
        "ports": [
            {"host_port": 5432, "container_port": 5432, "protocol": "tcp"}
        ],
        "env": {
            "POSTGRES_PASSWORD": "secretpassword",
            "POSTGRES_USER": "admin",
        },
        "volumes": [
            {"host_path": "/tmp/pgdata", "container_path": "/var/lib/postgresql/data", "mode": "rw"}
        ],
        "start_now": True,
    }
    response = await async_client.post("/api/v1/containers", json=payload)
    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "my-postgres"
    assert data["started"] is True


@pytest.mark.asyncio
async def test_create_container_without_start(async_client: AsyncClient):
    """Creación sin arranque automático."""
    payload = {
        "image": "redis:alpine",
        "name": "my-redis-cache",
        "start_now": False,
    }
    response = await async_client.post("/api/v1/containers", json=payload)
    assert response.status_code == 201
    data = response.json()
    assert data["started"] is False
    assert data["status"] == "created"


@pytest.mark.asyncio
async def test_create_container_name_conflict(async_client: AsyncClient):
    """Escenario: Conflicto por nombre de contenedor duplicado."""
    payload = {
        "image": "nginx:alpine",
        "name": "web-app",  # Ya existe en conftest.py ("c123": "/web-app")
        "start_now": True,
    }
    response = await async_client.post("/api/v1/containers", json=payload)
    assert response.status_code == 409
    assert "detail" in response.json()
