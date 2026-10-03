# SPDX-License-Identifier: AGPL-3.0-or-later
import pytest
from httpx import AsyncClient
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.schemas.stats import ContainerStats
from app.services.stats_service import calculate_stats


def _raw_stats(**overrides) -> dict:
    """Payload crudo de Docker con valores deterministas para las aserciones."""
    payload = {
        "read": "2026-09-26T10:00:00.000000000Z",
        "cpu_stats": {
            "cpu_usage": {"total_usage": 2000, "percpu_usage": [1000, 1000]},
            "system_cpu_usage": 20000,
            "online_cpus": 2,
        },
        "precpu_stats": {
            "cpu_usage": {"total_usage": 1000, "percpu_usage": [500, 500]},
            "system_cpu_usage": 10000,
            "online_cpus": 2,
        },
        "memory_stats": {"usage": 1000, "limit": 10000, "stats": {"inactive_file": 500}},
        "networks": {"eth0": {"rx_bytes": 300, "tx_bytes": 700}},
        "blkio_stats": {
            "io_service_bytes_recursive": [
                {"op": "Read", "value": 111},
                {"op": "Write", "value": 222},
                {"op": "Sync", "value": 999},
            ]
        },
        "pids_stats": {"current": 5},
    }
    payload.update(overrides)
    return payload


def test_calculate_stats_helper_accurate():
    """Escenario: Cálculo de métricas de CPU, memoria, red y disco desde el payload crudo."""
    result = calculate_stats(_raw_stats(), container_id="c123", container_name="web-app")

    assert isinstance(result, ContainerStats)
    assert result.container_id == "c123"
    assert result.container_name == "web-app"

    # dCPU=1000, dSystem=10000, online_cpus=2 -> 20.0%
    assert result.cpu_percent == pytest.approx(20.0)

    # usage=1000 - inactive_file=500 -> 500 bytes de 10000 -> 5.0%
    assert result.memory_limit == 10000
    assert result.memory_usage == 500
    assert result.memory_percent == pytest.approx(5.0)

    assert result.network_rx_bytes == 300
    assert result.network_tx_bytes == 700
    assert result.block_read_bytes == 111
    assert result.block_write_bytes == 222
    assert result.pids_current == 5
    assert result.timestamp


def test_calculate_stats_helper_cpu_zero_deltas():
    """Sin deltas de CPU o de sistema el porcentaje debe caer a 0.0 en lugar de dividir por cero."""
    raw = _raw_stats()
    raw["cpu_stats"]["cpu_usage"]["total_usage"] = 1000
    raw["precpu_stats"]["cpu_usage"]["total_usage"] = 1000
    result = calculate_stats(raw, container_id="c123", container_name="web-app")
    assert result.cpu_percent == 0.0

    raw = _raw_stats()
    raw["cpu_stats"]["system_cpu_usage"] = 10000
    result = calculate_stats(raw, container_id="c123", container_name="web-app")
    assert result.cpu_percent == 0.0


def test_calculate_stats_helper_cgroups_v1_cache_fallback():
    """En cgroups v1 la caché se expone como 'cache' y no como 'inactive_file'."""
    raw = _raw_stats()
    raw["memory_stats"] = {"usage": 1000, "limit": 10000, "stats": {"cache": 400}}
    result = calculate_stats(raw, container_id="c123", container_name="web-app")
    assert result.memory_usage == 600
    assert result.memory_percent == pytest.approx(6.0)


def test_calculate_stats_helper_sums_multiple_networks():
    """Las métricas de red se suman a través de todos los adaptadores."""
    raw = _raw_stats()
    raw["networks"] = {
        "eth0": {"rx_bytes": 300, "tx_bytes": 700},
        "eth1": {"rx_bytes": 20, "tx_bytes": 30},
    }
    result = calculate_stats(raw, container_id="c123", container_name="web-app")
    assert result.network_rx_bytes == 320
    assert result.network_tx_bytes == 730


def test_calculate_stats_helper_without_memory_limit():
    """Sin límite de memoria el porcentaje debe ser 0.0 y no producir división por cero."""
    raw = _raw_stats()
    raw["memory_stats"] = {"usage": 1000, "limit": 0, "stats": {"inactive_file": 500}}
    result = calculate_stats(raw, container_id="c123", container_name="web-app")
    assert result.memory_limit == 0
    assert result.memory_percent == 0.0


def test_calculate_stats_helper_tolerates_missing_sections():
    """Un payload incompleto no debe lanzar excepciones: las métricas ausentes valen 0."""
    result = calculate_stats({}, container_id="c123", container_name="web-app")
    assert result.cpu_percent == 0.0
    assert result.memory_usage == 0
    assert result.memory_limit == 0
    assert result.memory_percent == 0.0
    assert result.network_rx_bytes == 0
    assert result.network_tx_bytes == 0
    assert result.block_read_bytes == 0
    assert result.block_write_bytes == 0
    assert result.pids_current is None


@pytest.mark.asyncio
async def test_container_stats_rest_success(async_client: AsyncClient):
    """Escenario: Lectura de instantánea de métricas mediante REST."""
    response = await async_client.get("/api/v1/containers/c123/stats")
    assert response.status_code == 200

    data = response.json()
    for field in (
        "container_id",
        "container_name",
        "cpu_percent",
        "memory_usage",
        "memory_limit",
        "memory_percent",
        "network_rx_bytes",
        "network_tx_bytes",
        "block_read_bytes",
        "block_write_bytes",
        "timestamp",
    ):
        assert field in data

    assert data["container_id"] == "c123"
    assert data["container_name"] == "web-app"
    assert data["cpu_percent"] == pytest.approx(20.0)
    assert data["memory_usage"] == 500
    assert data["memory_limit"] == 10000
    assert data["memory_percent"] == pytest.approx(5.0)
    assert data["pids_current"] == 5

    assert data["cpu_percent"] >= 0
    assert data["memory_percent"] >= 0


@pytest.mark.asyncio
async def test_container_stats_rest_not_found(async_client: AsyncClient):
    """Escenario: Solicitud de métricas para un contenedor inexistente."""
    response = await async_client.get("/api/v1/containers/fantasma-99/stats")
    assert response.status_code == 404
    assert "detail" in response.json()


@pytest.mark.asyncio
async def test_container_stats_rest_stopped_returns_zeros(async_client: AsyncClient):
    """Escenario: Métricas de un contenedor detenido devuelven valores a cero."""
    response = await async_client.get("/api/v1/containers/c456/stats")
    assert response.status_code == 200

    data = response.json()
    assert data["container_id"] == "c456"
    assert data["container_name"] == "db-postgres"
    assert data["cpu_percent"] == 0.0
    assert data["memory_usage"] == 0
    assert data["memory_limit"] == 0
    assert data["memory_percent"] == 0.0
    assert data["network_rx_bytes"] == 0
    assert data["network_tx_bytes"] == 0
    assert data["block_read_bytes"] == 0
    assert data["block_write_bytes"] == 0


def test_container_stats_ws_stream(test_client: TestClient):
    """Escenario: Streaming de estadísticas mediante WebSocket.

    Desde SPEC-17 el canal manda primero el historial y después las muestras en
    vivo. La muestra conserva su contrato entero —mismos campos, sin `type`— y
    lo que se comprueba aquí es que sigue siendo la misma.
    """
    with test_client.websocket_connect("/ws/containers/c123/stats") as ws:
        historial = ws.receive_json()
        assert historial["type"] == "history"
        assert historial["history"]["container_id"] == "c123"

        first = ws.receive_json()
        assert "type" not in first
        assert first["container_id"] == "c123"
        assert first["container_name"] == "web-app"
        assert first["cpu_percent"] == pytest.approx(20.0)
        assert first["memory_percent"] == pytest.approx(5.0)
        assert first["network_rx_bytes"] == 300
        assert first["network_tx_bytes"] == 700
        assert first["block_read_bytes"] == 111
        assert first["block_write_bytes"] == 222
        assert first["pids_current"] == 5
        assert first["timestamp"]

        # El canal es continuo: debe emitir más de un paquete de estadísticas
        second = ws.receive_json()
        assert second["container_id"] == "c123"
        assert second["cpu_percent"] == pytest.approx(20.0)


def test_container_stats_ws_not_found(test_client: TestClient):
    """Escenario: WebSocket a contenedor inexistente se cierra con código 4404."""
    with pytest.raises(WebSocketDisconnect) as exc:
        with test_client.websocket_connect("/ws/containers/fantasma-99/stats") as ws:
            ws.receive_json()
    assert exc.value.code == 4404
