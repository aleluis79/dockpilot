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
async def test_rest_logs_snapshot(async_client: AsyncClient, mock_docker):
    """GET /api/v1/containers/{id}/logs obtiene snapshot de logs.

    El snapshot va por el mismo camino desmultiplexado que el stream en vivo,
    así que el doble tiene que servir frames de cable y no líneas sueltas.
    """
    mock_docker.logs_por_contenedor["containers/c123/logs"] = (
        mock_docker.multiplexed_logs(
            [
                (1, "2026-09-25T12:00:01.000000000Z Server initializing...\n"),
                (2, "ERROR: algo fallo\n"),
                (1, "2026-09-25T12:00:03.000000000Z [warn] High connection volume\n"),
            ]
        )
    )
    response = await async_client.get("/api/v1/containers/c123/logs?tail=10")
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == "c123"
    assert "total_lines" in data
    assert "lines" in data
    assert len(data["lines"]) == 3
    assert data["lines"][0]["stream"] in ["stdout", "stderr"]
    assert "Server initializing" in data["lines"][0]["message"]
    # El stream viene del byte de cabecera: la segunda línea es stderr aunque
    # no lleve marca, y eso el snapshot y el stream en vivo cuentan igual.
    assert [linea["stream"] for linea in data["lines"]] == ["stdout", "stderr", "stdout"]


@pytest.mark.asyncio
async def test_rest_logs_not_found(async_client: AsyncClient):
    """GET /api/v1/containers/{id}/logs devuelve 404 para contenedor inexistente."""
    response = await async_client.get("/api/v1/containers/inexistente-999/logs")
    assert response.status_code == 404


def test_ws_logs_stream_success(test_client: TestClient, mock_docker):
    """Escenario: Conexión WebSocket y streaming de logs.

    El doble sirve los logs en el formato multiplexado de Docker, que es lo que
    lee el servicio: sin cabecera `>BxxxL` no se puede saber de qué stream salió
    cada línea.
    """
    mock_docker.logs_por_contenedor["containers/c123/logs"] = (
        mock_docker.multiplexed_logs(
            [
                (1, "2026-09-25T12:00:01.000000000Z Server initializing...\n"),
                (1, "2026-09-25T12:00:02.000000000Z [info] Listening on 0.0.0.0:80\n"),
            ]
        )
    )
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

    class ContenidoColgado:
        """Como un contenedor parado: entrega los frames y luego no termina."""

        def __init__(self, datos: bytes) -> None:
            self._datos = datos
            self._pos = 0
            self.cerrado = False

        async def readexactly(self, n: int) -> bytes:
            if self._pos + n <= len(self._datos):
                trozo = self._datos[self._pos : self._pos + n]
                self._pos += n
                return trozo
            cerrado.set()
            await asyncio.Event().wait()  # nunca entrega nada más
            raise AssertionError("no debería llegar aquí")

        async def iter_any(self):
            raise AssertionError("con TTY=False se leen cabeceras, no trozos")

    class Respuesta:
        def __init__(self, datos: bytes) -> None:
            self.content = ContenidoColgado(datos)

    class Contexto:
        async def __aenter__(self) -> Respuesta:
            return Respuesta(
                mock_docker.multiplexed_logs([(1, "primera\n"), (1, "segunda\n")])
            )

        async def __aexit__(self, *_exc) -> bool:
            cerrado.set()
            return False

    mock_docker._query = lambda *_a, **_k: Contexto()

    socket = FakeWebSocket()
    tarea = asyncio.create_task(
        container_logs_ws(mock_docker, socket, "c123", tail=10, timestamps=True, follow=True)
    )
    await asyncio.wait_for(
        asyncio.sleep(0.05), timeout=1
    )  # deja que el handler se monte y lea

    # El cliente se va: es el `receive()` del vigía lo que lo debe notar.
    socket.encolar_desconexion()
    await asyncio.wait_for(cerrado.wait(), timeout=2)
    await asyncio.wait_for(tarea, timeout=2)

    assert socket.abierta is False


@pytest.mark.asyncio
async def test_logs_seguidos_llegan_completos(mock_docker):
    """El refactor de tareas no pierde ni reordena ninguna línea."""
    from app.api.v1.ws import container_logs_ws

    mock_docker.logs_por_contenedor["containers/c123/logs"] = (
        mock_docker.multiplexed_logs(
            [
                (1, "2026-09-25T12:00:01.000000000Z Server initializing...\n"),
                (1, "2026-09-25T12:00:02.000000000Z [info] Listening on 0.0.0.0:80\n"),
            ]
        )
    )

    socket = FakeWebSocket()
    await container_logs_ws(mock_docker, socket, "c123", tail=10, timestamps=True, follow=True)

    mensajes = [json.loads(m) for m in socket.enviados]
    assert mensajes[0]["stream"] == "system"
    assert "Server initializing" in mensajes[1]["message"]
    assert "Listening on" in mensajes[2]["message"]


# --- El stream viene del byte de cabecera, no del texto -------------------------


@pytest.mark.asyncio
async def test_el_stream_de_cada_linea_viene_del_frame_de_docker(mock_docker):
    """stdout y stderr se leen del byte de cabecera, no se adivinan.

    aiodocker tira ese byte al desmultiplexar, así que la vía que usa el visor
    tenía que adivinar por el texto y arrastraba a stderr cualquier línea de
    stdout que empezara por "Error". Con el byte no hay duda: la tercera línea de
    este test empieza por "Error" y es stdout de verdad.
    """
    from app.services.container_service import ContainerService

    mock_docker.logs_por_contenedor["containers/c123/logs"] = (
        mock_docker.multiplexed_logs(
            [
                (1, "2026-09-25T12:00:01.000000000Z normal\n"),
                (2, "ERROR: algo fallo\n"),
                (1, "2026-09-25T12:00:03.000000000Z Error handled gracefully\n"),
                (2, "aviso sin marca y sin mayusculas\n"),
            ]
        )
    )

    entradas = [
        e async for e in ContainerService.stream_logs(mock_docker, "c123", follow=True)
    ]

    assert [(e.stream, e.message) for e in entradas] == [
        ("stdout", "normal"),
        ("stderr", "ERROR: algo fallo"),
        # La trampa del heurístico: empieza por "Error" y es stdout de verdad.
        ("stdout", "Error handled gracefully"),
        # Y al revés: sin mayúscula ni dos puntos, y es stderr de verdad.
        ("stderr", "aviso sin marca y sin mayusculas"),
    ]
    assert entradas[0].timestamp == "2026-09-25T12:00:01.000000000Z"


@pytest.mark.asyncio
async def test_una_linea_partida_entre_frames_no_se_trocea(mock_docker):
    """Un frame puede traer una línea a medias; el buffer la reengancha."""
    import struct

    trozo = "primera parte y "
    resto = "segunda parte\n"
    crudo = struct.pack(">BxxxL", 1, len(trozo.encode())) + trozo.encode()
    crudo += struct.pack(">BxxxL", 2, len(resto.encode())) + resto.encode()
    mock_docker.logs_por_contenedor["containers/c123/logs"] = crudo

    from app.services.container_service import ContainerService

    entradas = [
        e async for e in ContainerService.stream_logs(mock_docker, "c123", follow=True)
    ]

    assert [e.message for e in entradas] == ["primera parte y segunda parte"]
