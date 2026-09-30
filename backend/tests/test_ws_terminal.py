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
