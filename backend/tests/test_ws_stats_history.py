# SPDX-License-Identifier: AGPL-3.0-or-later
"""El historial por el mismo canal de métricas (SPEC-17 §3.2).

Lo que fija este archivo es el **orden**: historial primero, muestras después.
Un cliente que no puede saber cuál de los dos es cuál acaba con dos series para
el mismo punto, que es el modo de fallo que agent.md ya documenta para los logs.
"""

import json

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.schemas.metrics import MetricSample
from app.services.metrics_store import get_store, reset_store


@pytest.fixture(autouse=True)
def anillo_limpio():
    reset_store()
    yield
    reset_store()


def _llenar_anillo(cid: str = "c123", n: int = 3) -> None:
    store = get_store()
    store.observe(cid)
    store.estado(cid, running=True, name="web-app")
    for i in range(n):
        store.append(
            cid,
            MetricSample(
                t=1000.0 + i * 2,
                cpu_percent=10.0 + i,
                memory_percent=20.0 + i,
                network_rx_bytes=1000 * i,
                network_tx_bytes=2000 * i,
                block_read_bytes=3000 * i,
                block_write_bytes=4000 * i,
            ),
        )


def test_el_historial_llega_antes_de_la_primera_muestra(test_client: TestClient):
    _llenar_anillo()

    with test_client.websocket_connect("/ws/containers/c123/stats") as ws:
        primero = json.loads(ws.receive_text())
        segundo = json.loads(ws.receive_text())

    assert primero["type"] == "history"
    assert len(primero["history"]["samples"]) == 3
    # El segundo mensaje es la muestra en vivo, que no lleva `type`. Esa
    # asimetría es deliberada: lo que no es muestra en vivo lleva `type`.
    assert "type" not in segundo
    assert "cpu_percent" in segundo


def test_el_historial_es_el_del_anillo(test_client: TestClient):
    _llenar_anillo()

    with test_client.websocket_connect("/ws/containers/c123/stats") as ws:
        historial = json.loads(ws.receive_text())["history"]

    ts = [s["t"] for s in historial["samples"]]
    assert ts == [1000.0, 1002.0, 1004.0]
    assert historial["observed"] is True
    assert historial["running"] is True
    assert historial["container_name"] == "web-app"


def test_un_contenedor_sin_historial_recibe_historial_vacío(test_client: TestClient):
    """Se manda igualmente. Un cliente que no recibe nada no puede distinguir "no hay
    historial" de "el servidor no lo ha mandado todavía"."""
    with test_client.websocket_connect("/ws/containers/c123/stats") as ws:
        primero = json.loads(ws.receive_text())

    assert primero["type"] == "history"
    assert primero["history"]["samples"] == []
    assert primero["history"]["truncated"] is False


def test_la_muestra_en_vivo_no_cambia_de_contrato(test_client: TestClient):
    """El mensaje de stats en vivo sigue siendo el `model_dump()` de
    `ContainerStats` de siempre, sin `type` y sin campos nuevos."""
    with test_client.websocket_connect("/ws/containers/c123/stats") as ws:
        json.loads(ws.receive_text())
        muestra = json.loads(ws.receive_text())

    for campo in (
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
        assert campo in muestra, campo


def test_el_id_corto_del_anillo_llega_al_historial(test_client: TestClient):
    _llenar_anillo(cid="c123")

    with test_client.websocket_connect("/ws/containers/c123/stats") as ws:
        historial = json.loads(ws.receive_text())["history"]

    assert historial["container_id"] == "c123"


def test_contenedor_inexistente_cierra_con_4404(test_client: TestClient):
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with test_client.websocket_connect("/ws/containers/no-existe/stats") as ws:
            ws.receive_text()

    assert exc_info.value.code == 4404


def test_desfijar_no_cierra_el_canal(test_client: TestClient):
    """El canal es del modal y el pin es del almacén. Desfijar desde otra pestaña
    no puede dejar la de aquí sin datos."""
    _llenar_anillo()

    with test_client.websocket_connect("/ws/containers/c123/stats") as ws:
        primero = json.loads(ws.receive_text())
        get_store().unobserve("c123")
        segundo = json.loads(ws.receive_text())

    assert primero["type"] == "history"
    assert "cpu_percent" in segundo
