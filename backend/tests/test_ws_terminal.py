# SPDX-License-Identifier: AGPL-3.0-or-later
import json

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect


def test_ws_terminal_not_found(test_client: TestClient):
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with test_client.websocket_connect("/ws/containers/inexistente/terminal") as ws:
            ws.receive_text()
    assert exc_info.value.code == 4404


def test_ws_terminal_container_stopped(test_client: TestClient):
    # c456 is in 'exited' status
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with test_client.websocket_connect("/ws/containers/c456/terminal") as ws:
            ws.receive_text()
    assert exc_info.value.code == 4400


def test_ws_terminal_connect_and_stream(test_client: TestClient):
    with test_client.websocket_connect("/ws/containers/c123/terminal?shell=/bin/sh") as websocket:
        # First message should be system connected or stdout prompt
        msg1 = websocket.receive_text()
        data1 = json.loads(msg1)
        assert data1["type"] in ["system", "stdout"]

        # If system notification arrived, next is stdout prompt
        if data1["type"] == "system":
            msg2 = websocket.receive_text()
            data2 = json.loads(msg2)
            assert data2["type"] == "stdout"
            assert "/ #" in data2["data"]

        # Send stdin command
        websocket.send_text(json.dumps({"type": "stdin", "data": "echo hola\r"}))

        # Receive echo output
        msg_out = websocket.receive_text()
        data_out = json.loads(msg_out)
        assert data_out["type"] == "stdout"
        assert "hola dockpilot" in data_out["data"]


def test_ws_terminal_resize_message(test_client: TestClient):
    with test_client.websocket_connect("/ws/containers/c123/terminal") as websocket:
        # Send resize message
        websocket.send_text(json.dumps({"type": "resize", "cols": 120, "rows": 35}))
        # Connection should stay open and functional
        websocket.send_text(json.dumps({"type": "stdin", "data": "echo test\r"}))
        msg = websocket.receive_text()
        assert msg is not None


def test_ws_terminal_clean_exit(test_client: TestClient):
    with test_client.websocket_connect("/ws/containers/c123/terminal") as websocket:
        # Sending exit should trigger EOF/close
        websocket.send_text(json.dumps({"type": "stdin", "data": "exit\r"}))
        # WebSocket might disconnect with 1000
        try:
            while True:
                websocket.receive_text()
        except WebSocketDisconnect as exc:
            assert exc.code in [1000, 1001]


# --- El exec no muere con la conexión ----------------------------------------


@pytest.mark.asyncio
async def test_se_avisa_si_el_exec_sobrevive(mock_docker, caplog):
    """Un exec con TTY sobrevive al cierre, y hay que enterarse.

    El proceso de un exec no está atado a la conexión hijackeada: cerrarla no lo
    mata. Sin TTY el EOF de la entrada estándar hace salir a `/bin/sh`, pero con
    `tty=True` —que es lo que mandan casi todos los clientes de terminal— el
    shell no ve ese EOF y se queda. Docker no expone ninguna API para matarlo,
    así que lo único honesto es detectarlo y decirlo, en vez de fingir que el
    cierre lo limpia.
    """
    import logging

    from app.api.v1.ws import _avisar_si_el_exec_sobrevive

    contenedor = await mock_docker.containers.get("c123")
    exec_instance = await contenedor.exec(cmd=["/bin/bash"])

    with caplog.at_level(logging.WARNING):
        await _avisar_si_el_exec_sobrevive(exec_instance, "web-app", "/bin/bash")

    assert exec_instance.inspect_called == 1
    assert any("sigue vivo" in r.message for r in caplog.records)
    assert any("Docker no tiene API para matarlo" in r.message for r in caplog.records)


@pytest.mark.asyncio
async def test_no_se_avisa_si_el_exec_ya_murio(mock_docker, caplog):
    """Sin TTY el shell sale con el EOF: no hay nada que avisar."""
    import logging

    from app.api.v1.ws import _avisar_si_el_exec_sobrevive

    contenedor = await mock_docker.containers.get("c123")
    exec_instance = await contenedor.exec(cmd=["/bin/sh"], tty=False)
    assert exec_instance.running is False

    with caplog.at_level(logging.WARNING):
        await _avisar_si_el_exec_sobrevive(exec_instance, "web-app", "/bin/sh")

    assert caplog.records == []


@pytest.mark.asyncio
async def test_un_inspect_que_falla_no_afirma_nada(caplog):
    """Si no se puede preguntar, no se puede afirmar: no es motivo para tumbar el cierre."""
    import logging

    from app.api.v1.ws import _avisar_si_el_exec_sobrevive

    class ExecRoto:
        async def inspect(self):
            raise RuntimeError("daemon caído")

    with caplog.at_level(logging.WARNING):
        await _avisar_si_el_exec_sobrevive(ExecRoto(), "web-app", "/bin/sh")

    assert caplog.records == []
