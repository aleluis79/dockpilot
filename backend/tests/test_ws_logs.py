import json
import pytest
from httpx import AsyncClient
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect


@pytest.mark.asyncio
async def test_rest_logs_snapshot(async_client: AsyncClient):
    """GET /api/v1/containers/{id}/logs obtiene snapshot de logs."""
    response = await async_client.get("/api/v1/containers/c123/logs?tail=10")
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == "c123"
    assert "total_lines" in data
    assert "lines" in data
    assert len(data["lines"]) == 3
    assert data["lines"][0]["stream"] in ["stdout", "stderr"]
    assert "Server initializing" in data["lines"][0]["message"]


@pytest.mark.asyncio
async def test_rest_logs_not_found(async_client: AsyncClient):
    """GET /api/v1/containers/{id}/logs devuelve 404 para contenedor inexistente."""
    response = await async_client.get("/api/v1/containers/inexistente-999/logs")
    assert response.status_code == 404


def test_ws_logs_stream_success(test_client: TestClient):
    """Escenario: Conexión WebSocket y streaming de logs."""
    with test_client.websocket_connect("/ws/containers/c123/logs?tail=10") as ws:
        # Primer mensaje debe ser mensaje del sistema indicando conexión
        first_msg = ws.receive_json()
        assert first_msg["stream"] == "system"
        assert "Conectado" in first_msg["message"]

        # Siguientes mensajes son las líneas de log transmitidas
        log_line_1 = ws.receive_json()
        assert log_line_1["stream"] in ["stdout", "stderr"]
        assert "Server initializing" in log_line_1["message"]

        log_line_2 = ws.receive_json()
        assert "Listening on" in log_line_2["message"]


def test_ws_logs_not_found(test_client: TestClient):
    """Escenario: Conexión a contenedor inexistente devuelve código de cierre 4404."""
    with pytest.raises(WebSocketDisconnect) as exc:
        with test_client.websocket_connect("/ws/containers/fantasma-000/logs") as ws:
            ws.receive_json()
    assert exc.value.code == 4404
