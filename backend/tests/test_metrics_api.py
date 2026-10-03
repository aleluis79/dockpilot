# SPDX-License-Identifier: AGPL-3.0-or-later
"""Los tres endpoints de SPEC-17 y el `observed` del listado.

El anillo es de módulo, así que cada test empieza limpio: si no, un `observe`
de un test se leería en el siguiente por el `observed` del listado.
"""

import pytest

from app.services.metrics_store import get_store, reset_store

pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def anillo_limpio():
    reset_store()
    yield
    reset_store()


# --- El listado -------------------------------------------------------------


async def test_el_listado_incluye_observed(async_client, mock_docker):
    r = await async_client.get("/api/v1/containers")

    assert r.status_code == 200
    filas = {c["id"]: c for c in r.json()}
    assert filas["c123"]["observed"] is False


async def test_el_listado_refleja_el_pin(async_client):
    get_store().observe("c123")

    r = await async_client.get("/api/v1/containers")

    filas = {c["id"]: c for c in r.json()}
    assert filas["c123"]["observed"] is True
    assert filas["c456"]["observed"] is False


async def test_el_listado_no_pide_stats_por_contenedor(async_client, mock_docker):
    """`observed` sale de una consulta al diccionario en memoria. Si el listado
    fuera a preguntarle al daemon, sería un N+1 para pintar un punto."""
    get_store().observe("c123")

    await async_client.get("/api/v1/containers")

    mock_docker.containers.list.assert_awaited_once()
    mock_docker.containers.get.assert_not_awaited()


# --- Historial --------------------------------------------------------------


async def test_historial_de_un_contenedor_inexistente(async_client):
    r = await async_client.get("/api/v1/containers/no-existe/metrics")

    assert r.status_code == 404
    assert "no existe" in r.json()["detail"].lower()


async def test_historial_no_crea_anillo(async_client):
    """Mirar no es observar. Un `GET` no puede dejar al contenedor midiéndose:
    sería el coste de una llamada al daemon cada 2 s que nadie pidió."""
    r = await async_client.get("/api/v1/containers/c123/metrics")

    assert r.status_code == 200
    cuerpo = r.json()
    assert cuerpo["samples"] == []
    assert cuerpo["observed"] is False
    assert get_store().tracked_ids() == []


async def test_historial_trae_la_serie_del_anillo(async_client):
    from app.schemas.metrics import MetricSample
    from app.services.metrics_store import get_store as store

    s = store()
    s.observe("c123")
    s.estado("c123", running=True, name="web-app")
    s.append(
        "c123",
        MetricSample(
            t=1000.0,
            cpu_percent=12.5,
            memory_percent=30.0,
            network_rx_bytes=10,
            network_tx_bytes=20,
            block_read_bytes=30,
            block_write_bytes=40,
        ),
    )

    r = await async_client.get("/api/v1/containers/c123/metrics")

    cuerpo = r.json()
    assert len(cuerpo["samples"]) == 1
    assert cuerpo["samples"][0]["cpu_percent"] == 12.5
    assert cuerpo["samples"][0]["t"] == 1000.0
    assert cuerpo["running"] is True
    assert cuerpo["observed"] is True
    assert cuerpo["container_name"] == "web-app"
    assert cuerpo["interval_s"] > 0
    assert cuerpo["window_s"] > 0


async def test_historial_acepta_el_id_corto(async_client):
    """El id corto es lo que guarda el anillo, porque es lo que lleva el modal.
    Sin esto, abrir las métricas de un contenedor parecería no tener historial."""
    from app.schemas.metrics import MetricSample
    from app.services.metrics_store import get_store as store

    s = store()
    s.observe("c123")
    s.append(
        "c123",
        MetricSample(
            t=1.0,
            cpu_percent=1.0,
            memory_percent=1.0,
            network_rx_bytes=0,
            network_tx_bytes=0,
            block_read_bytes=0,
            block_write_bytes=0,
        ),
    )

    r = await async_client.get("/api/v1/containers/c123/metrics")

    assert len(r.json()["samples"]) == 1


async def test_historial_de_un_contenedor_parado_no_inventa_muestras(async_client):
    r = await async_client.get("/api/v1/containers/c456/metrics")

    cuerpo = r.json()
    assert cuerpo["running"] is False
    assert cuerpo["samples"] == []


# --- Observar ---------------------------------------------------------------


async def test_observar(async_client):
    r = await async_client.post("/api/v1/containers/c123/watch")

    assert r.status_code == 200
    assert r.json() == {"container_id": "c123", "observed": True}
    assert get_store().is_observed("c123") is True


async def test_observar_un_contenedor_inexistente(async_client):
    r = await async_client.post("/api/v1/containers/no-existe/watch")

    assert r.status_code == 404


async def test_observar_es_idempotente(async_client):
    await async_client.post("/api/v1/containers/c123/watch")
    r = await async_client.post("/api/v1/containers/c123/watch")

    assert r.status_code == 200
    assert get_store().observed_ids() == ["c123"]


async def test_dejar_de_observar(async_client):
    await async_client.post("/api/v1/containers/c123/watch")

    r = await async_client.request("DELETE", "/api/v1/containers/c123/watch")

    assert r.status_code == 200
    assert r.json()["observed"] is False
    assert get_store().is_observed("c123") is False


async def test_dejar_de_observar_uno_que_no_lo_estaba(async_client):
    r = await async_client.request("DELETE", "/api/v1/containers/c123/watch")

    assert r.status_code == 200
    assert r.json()["observed"] is False


async def test_dejar_de_observar_un_contenedor_inexistente(async_client):
    r = await async_client.request("DELETE", "/api/v1/containers/no-existe/watch")

    assert r.status_code == 404


async def test_observar_cuando_no_cabe_dice_cual_es_el_limite(async_client, monkeypatch):
    """Sin límite, doce observados son doce llamadas al daemon cada 2 s y el
    límite tiene que estar en el mensaje: si no, es un 409 que no explica nada."""
    from app.core.config import settings

    store = get_store()
    tope = settings.METRICS_MAX_TRACKED
    for i in range(tope):
        assert store.observe(f"c{i}") is True

    r = await async_client.post("/api/v1/containers/c123/watch")

    assert r.status_code == 409
    detalle = r.json()["detail"]
    assert str(tope) in detalle
    assert "observ" in detalle.lower()


async def test_observar_expulsa_al_no_observado_para_entrar(async_client):
    """Con hueco, se expulsa el anillo **no observado** más viejo en vez de
    rechazar: nadie lo pidió y el panel puede seguir acumulando. Lo que no se
    expulsa nunca es un observado, porque ése sí lo pidió alguien."""
    from app.core.config import settings

    store = get_store()
    for i in range(settings.METRICS_MAX_TRACKED - 1):
        assert store.observe(f"c{i}") is True
    # El último hueco lo ocupa un anillo observado y luego desobservado: es el
    # que puede ser expulsado.
    store.observe("soltado")
    store.unobserve("soltado")

    r = await async_client.post("/api/v1/containers/c123/watch")

    assert r.status_code == 200
    assert get_store().is_observed("c123") is True
    assert get_store().tracked_ids().count("soltado") == 0


# --- El listado de observados (SPEC-17 §4.9) ---------------------------------
#
# Existe para que la tabla no recargue la lista entera —que sí es una
# `containers.list()`— para enterarse de que un pin cambió. Y sobre todo para el
# caso que no tiene botón: un reinicio del backend se lleva todos los pines
# porque viven en memoria (§4.3), y la tabla no tiene forma de enterarse si nadie
# pregunta.


async def test_observed_devuelve_los_pines_del_almacen(test_client):
    get_store().observe("c1")
    get_store().observe("c2")

    r = test_client.get("/api/v1/containers/observed")

    assert r.status_code == 200
    # Ordenados, para que la respuesta sea estable y comparable entre tics.
    assert r.json() == ["c1", "c2"]


async def test_observed_devuelve_lista_vacia_si_no_hay_pines(test_client):
    r = test_client.get("/api/v1/containers/observed")

    assert r.status_code == 200
    assert r.json() == []


async def test_el_soltar_el_pin_se_refleja_en_el_listado(test_client):
    get_store().observe("c1")
    assert test_client.get("/api/v1/containers/observed").json() == ["c1"]

    get_store().unobserve("c1")

    assert test_client.get("/api/v1/containers/observed").json() == []


async def test_el_pin_cae_al_expirar_antiguedad(test_client):
    """El caso que esta ruta existe para cazar: el TTL se lleva el anillo y el
    pin con él (§4.3), y la tabla se enteraría por aquí antes que por un refresco."""
    store = get_store()
    store.observe("c1")
    store.ttl_s = 0.0

    store.evict_expired()

    assert test_client.get("/api/v1/containers/observed").json() == []


async def test_observed_no_toca_el_daemon(test_client, mock_docker):
    """Es una consulta al diccionario en memoria. Si algún día toca el daemon,
    la tabla pasa a pagar un `containers.list()` cada vez que responde esto."""
    async def _no_deberia_tocarse(*_a, **_kw):
        raise AssertionError("este endpoint no debe llamar al daemon")

    mock_docker.containers.list = _no_deberia_tocarse

    assert test_client.get("/api/v1/containers/observed").status_code == 200


async def test_observed_no_es_el_detalle_de_un_contenedor(test_client, mock_docker):
    """`/observed` declarado después de `/{container_id}` haría que este GET fuera
    el detalle de un contenedor llamado «observed»."""
    async def listar(*_a, **_kw):
        return []

    mock_docker.containers.list = listar

    r = test_client.get("/api/v1/containers/observed")

    assert r.status_code == 200
    # Un detalle trae `status`, `image` y `created`. Esto es una lista de ids.
    assert isinstance(r.json(), list)
    assert r.json() == []
