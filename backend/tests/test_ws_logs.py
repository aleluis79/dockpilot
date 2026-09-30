# SPDX-License-Identifier: AGPL-3.0-or-later
import asyncio
import json

import pytest
from httpx import AsyncClient
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect


class FakeWebSocket:
    """Socket mínimo para poder observar al handler sin abrir un puerto.

    `TestClient` no sirve aquí: su `websocket_connect` entrega los mensajes por
    orden, y lo que hay que comprobar es que el handler *suelta* el stream
    cuando el cliente se va, no qué pinta por el socket.
    """

    def __init__(self) -> None:
        self.aceptada = False
        self.abierta = True
        self.enviados: list[str] = []
        self._entrantes: asyncio.Queue = asyncio.Queue()

    async def accept(self) -> None:
        self.aceptada = True

    async def receive(self) -> dict:
        return await self._entrantes.get()

    async def receive_text(self) -> str:
        return (await self._entrantes.get())["text"]

    async def send_json(self, data) -> None:
        self.enviados.append(json.dumps(data, default=str))

    async def send_text(self, data: str) -> None:
        self.enviados.append(data)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.abierta = False

    def encolar_desconexion(self) -> None:
        self._entrantes.put_nowait({"type": "websocket.disconnect", "code": 1005})


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


# --- Cierre del stream ---------------------------------------------------------


@pytest.mark.asyncio
async def test_cerrar_la_vista_libera_el_stream(mock_docker):
    """Abrir y cerrar la vista de logs no puede dejar el stream colgando.

    El handler pasaba por `async for` sin `receive()`: con un contenedor callado
    se quedaba bloqueado en la lectura de aiodocker indefinidamente, con el
    `ClientResponse` cogido. Este test abre la vista, la cierra y comprueba que
    el generador se cerró y que no quedó ninguna tarea del handler viva.
    """
    from app.api.v1.ws import container_logs_ws

    cerrado = asyncio.Event()
    logs_emitidos = asyncio.Event()

    class StreamColgado:
        """Como un contenedor parado: emite tres líneas y luego no termina."""

        def __init__(self) -> None:
            self.cerrado = False

        def __aiter__(self):
            return self

        async def __anext__(self):
            logs_emitidos.set()
            await asyncio.Event().wait()  # nunca entrega nada más
            raise StopAsyncIteration

        async def aclose(self) -> None:
            self.cerrado = True
            cerrado.set()

    stream = StreamColgado()
    contenedor = await mock_docker.containers.get("c123")
    contenedor.log = lambda **_kw: stream

    socket = FakeWebSocket()
    tarea = asyncio.create_task(
        container_logs_ws(mock_docker, socket, "c123", tail=10, timestamps=True, follow=True)
    )
    await asyncio.wait_for(logs_emitidos.wait(), timeout=2)

    # El cliente se va: es el `receive()` del vigía lo que lo debe notar.
    socket.encolar_desconexion()
    await asyncio.wait_for(cerrado.wait(), timeout=2)
    await asyncio.wait_for(tarea, timeout=2)

    assert stream.cerrado is True
    assert socket.abierta is False


@pytest.mark.asyncio
async def test_logs_seguidos_llegan_completos(mock_docker):
    """El refactor de tareas no pierde ni reordena ninguna línea."""
    from app.api.v1.ws import container_logs_ws

    socket = FakeWebSocket()
    await container_logs_ws(mock_docker, socket, "c123", tail=10, timestamps=True, follow=True)

    mensajes = [json.loads(m) for m in socket.enviados]
    assert mensajes[0]["stream"] == "system"
    assert "Server initializing" in mensajes[1]["message"]
    assert "Listening on" in mensajes[2]["message"]
