"""Primitivo compartido de consumo de disco (SPEC-08 §3.6, reutilizado por SPEC-09)."""

from unittest.mock import AsyncMock

import pytest
from aiodocker.exceptions import DockerError
from fastapi import HTTPException

from app.services.system_service import SystemService


@pytest.mark.asyncio
async def test_fetch_disk_usage_shape(mock_docker):
    """Devuelve el payload crudo de /system/df con los bloques esperados."""
    data = await SystemService.fetch_disk_usage(mock_docker)

    for key in (
        "LayersSize",
        "Images",
        "Containers",
        "Volumes",
        "ImageUsage",
        "ContainerUsage",
        "VolumeUsage",
        "BuildCacheUsage",
    ):
        assert key in data, f"falta el bloque {key} de /system/df"

    assert data["LayersSize"] == 5106255209
    assert data["VolumeUsage"]["TotalCount"] == 4


@pytest.mark.asyncio
async def test_fetch_disk_usage_keeps_usage_data_nested(mock_docker):
    """El tamaño de cada volumen llega anidado bajo UsageData, no en el nivel superior."""
    data = await SystemService.fetch_disk_usage(mock_docker)

    items = data["VolumeUsage"]["Items"]
    assert items, "debe haber al menos un volumen con UsageData"
    for item in items:
        assert "UsageData" in item
        assert "Size" in item["UsageData"]
        assert "RefCount" in item["UsageData"]


@pytest.mark.asyncio
async def test_fetch_disk_usage_daemon_unavailable(mock_docker):
    """Un fallo del daemon se traduce a 503 con un mensaje legible."""

    async def boom(*args, **kwargs):
        raise DockerError(500, {"message": "boom"})

    mock_docker._query_json = AsyncMock(side_effect=boom)

    with pytest.raises(HTTPException) as exc:
        await SystemService.fetch_disk_usage(mock_docker)

    assert exc.value.status_code == 503
    # El mensaje del daemon llega como dict: debe convertirse en texto legible
    assert "boom" in exc.value.detail
    assert isinstance(exc.value.detail, str)


@pytest.mark.asyncio
async def test_fetch_disk_usage_empty_response(mock_docker):
    """Una respuesta vacía se tolera y devuelve un dict vacío."""
    mock_docker._query_json = AsyncMock(return_value=None)
    assert await SystemService.fetch_disk_usage(mock_docker) == {}
