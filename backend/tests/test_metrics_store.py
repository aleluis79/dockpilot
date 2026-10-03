# SPDX-License-Identifier: AGPL-3.0-or-later
"""El anillo de métricas como estructura (SPEC-17 §4.8).

Aquí no hay ni daemon ni FastAPI: es el almacén y sus topes. El reloj es
inyectable porque un test que espera `METRICS_TTL_S` para comprobar una
expulsión es un test de 30 minutos, y uno que espera 2 s por muestra es un test
lento que además se vuelve intermitente.
"""

import pytest

from app.core.config import settings
from app.schemas.metrics import MetricSample
from app.services.metrics_store import MetricsStore


class Reloj:
    """Reloj manual. No usa `monotonic` porque el anillo comparte reloj con las
    marcas `t` de las muestras, que vienen del reloj de pared."""

    def __init__(self, ahora: float = 1_000_000.0):
        self.ahora = ahora

    def __call__(self) -> float:
        return self.ahora

    def avanzar(self, segundos: float) -> None:
        self.ahora += segundos


def _muestra(t: float, **kwargs) -> MetricSample:
    base = {
        "cpu_percent": 10.0,
        "memory_percent": 20.0,
        "network_rx_bytes": 1_000,
        "network_tx_bytes": 2_000,
        "block_read_bytes": 3_000,
        "block_write_bytes": 4_000,
    }
    base.update(kwargs)
    return MetricSample(t=t, **base)


@pytest.fixture
def reloj() -> Reloj:
    return Reloj()


@pytest.fixture
def store(reloj) -> MetricsStore:
    return MetricsStore(now=reloj, max_samples=5, max_tracked=3, ttl_s=60)


# --- Tope de muestras -------------------------------------------------------


def test_anillo_vacio_no_dice_que_está_truncado(store):
    h = store.get("c1")

    assert h.samples == []
    assert h.truncated is False
    assert h.container_id == "c1"


def test_añade_hasta_el_tope(store):
    for i in range(4):
        store.append("c1", _muestra(1000.0 + i))

    h = store.get("c1")
    assert len(h.samples) == 4
    assert h.truncated is False


def test_añade_hasta_el_tope_lo_trunca_y_lo_dice(store):
    """Un truncado que no se dice es un dato que miente: 5 muestras de los
    últimos segundos parecerían el histórico entero que promete la ventana."""
    for i in range(9):
        store.append("c1", _muestra(1000.0 + i))

    h = store.get("c1")
    assert len(h.samples) == store.max_samples
    assert h.truncated is True


def test_descarta_por_el_frente(store):
    for i in range(7):
        store.append("c1", _muestra(1000.0 + i))

    ts = [s.t for s in store.get("c1").samples]
    assert ts == [1002.0, 1003.0, 1004.0, 1005.0, 1006.0]
    assert ts[0] > 1000.0


# --- Tope de anillos y expulsión -------------------------------------------


def test_expulsa_el_mas_viejo_no_observado(reloj):
    store = MetricsStore(now=reloj, max_samples=100, max_tracked=2, ttl_s=600)

    store.append("c1", _muestra(1000.0))
    reloj.avanzar(10)
    store.append("c2", _muestra(1010.0))
    reloj.avanzar(10)
    store.append("c3", _muestra(1020.0))

    assert store.get("c1").samples == []
    assert len(store.get("c2").samples) == 1
    assert len(store.get("c3").samples) == 1


def test_no_expulsa_un_observado_para_hacer_site_a_otro_no_observado(reloj):
    store = MetricsStore(now=reloj, max_samples=100, max_tracked=2, ttl_s=600)

    store.observe("c1")
    store.append("c1", _muestra(1000.0))
    reloj.avanzar(10)
    store.append("c2", _muestra(1010.0))
    reloj.avanzar(10)
    store.append("c3", _muestra(1020.0))

    # c1 es el más viejo y está observado, así que sale c2, que no lo está.
    assert len(store.get("c1").samples) == 1
    assert store.get("c2").samples == []
    assert len(store.get("c3").samples) == 1


def test_rechaza_observar_cuando_todo_el_tope_está_observado(reloj):
    store = MetricsStore(now=reloj, max_samples=100, max_tracked=2, ttl_s=600)

    assert store.observe("c1") is True
    assert store.observe("c2") is True

    # No queda ninguno sin observar al que expulsar: se rechaza en vez de
    # expulsar un observado, porque eso apagaría un histórico que alguien pidió.
    assert store.observe("c3") is False
    assert store.is_observed("c1") is True
    assert store.is_observed("c2") is True


def test_observar_dos_veces_el_mismo_no_cuenta_dos(reloj):
    store = MetricsStore(now=reloj, max_samples=100, max_tracked=1, ttl_s=600)

    assert store.observe("c1") is True
    assert store.observe("c1") is True


# --- Expulsión por antigüedad ----------------------------------------------


def test_expulsa_por_antiguedad(store, reloj):
    store.append("c1", _muestra(1000.0))

    reloj.avanzar(store.ttl_s - 1)
    store.evict_expired()
    assert len(store.get("c1").samples) == 1

    reloj.avanzar(2)
    store.evict_expired()
    assert store.get("c1").samples == []


def test_expulsar_el_anillo_lo_desmarca(store, reloj):
    """Un pin sin anillo sería un muestreador midiendo un contenedor del que no
    se guarda nada, y el coste de esas llamadas sí existe."""
    store.observe("c1")
    store.append("c1", _muestra(1000.0))

    reloj.avanzar(store.ttl_s + 1)
    store.evict_expired()

    assert store.is_observed("c1") is False
    assert store.observed_ids() == []


def test_un_anillo_observado_no_expira_por_no_recibir_muestras(reloj):
    """Observar es una actividad, y por eso un contenedor PARADO —que no deja
    muestras— conserva su anillo mientras el TTL no venza.

    Lo que este test NO dice es que el pin sobreviva al TTL: se lo lleva el anillo
    (§4.3, y `test_expulsar_el_anillo_lo_desmarca`). Lo que fija es que un anillo
    observado no se va por no tener nada que escribir, sino por antigüedad.
    """
    store = MetricsStore(now=reloj, max_samples=100, max_tracked=4, ttl_s=60)
    store.observe("c1")

    reloj.avanzar(30)
    store.evict_expired()
    assert store.is_observed("c1") is True

    reloj.avanzar(31)
    store.evict_expired()
    assert store.is_observed("c1") is False


# --- Leer no crea -----------------------------------------------------------


def test_Leer_no_crea_un_anillo(store):
    h = store.get("c-nunca-visto")

    assert h.samples == []
    assert store.tracked_ids() == []


def test_el_nombre_viene_del_estado_y_no_del_id(store):
    store.estado("c1", running=True, name="web-app")

    assert store.get("c1").container_name == "web-app"


# --- Estado y honestidad del "sampling" ------------------------------------


def test_running_lo_dice_el_estado_no_las_muestras(store):
    store.append("c1", _muestra(1000.0, cpu_percent=99.0))

    assert store.get("c1").running is False

    store.estado("c1", running=True, name="web")
    assert store.get("c1").running is True
    # Y sigue sin ser verdad que se está midiendo ahora mismo.
    assert store.get("c1").sampling is False


def test_sampling_es_cierto_despues_de_muestrear(store, reloj):
    store.observe("c1")
    store.estado("c1", running=True, name="web")
    store.append("c1", _muestra(1000.0))

    assert store.get("c1").sampling is True

    # Pasado el umbral deja de ser cierto, y se dice con `sampling: false` en
    # vez de seguir fingiendo que hay alguien midiendo.
    reloj.avanzar(3 * settings.METRICS_SAMPLE_INTERVAL_S + 1)
    assert store.get("c1").sampling is False


def test_un_contenedor_parado_no_está_siendo_muestreado(store):
    store.observe("c1")
    store.estado("c1", running=True, name="web")
    store.append("c1", _muestra(1000.0))
    store.estado("c1", running=False, name="web")

    h = store.get("c1")
    assert h.running is False
    assert h.sampling is False
    # Y su serie sigue ahí: pararse no borra el pasado.
    assert len(h.samples) == 1


# --- Metadatos de ventana ---------------------------------------------------


def test_la_historia_declara_el_periodo_y_la_ventana(store):
    h = store.get("c1")

    assert h.interval_s == settings.METRICS_SAMPLE_INTERVAL_S
    assert h.window_s == store.max_samples * store.interval_s


def test_el_anillo_es_independiente_por_contenedor(store):
    store.append("c1", _muestra(1000.0))
    store.append("c2", _muestra(1000.0))
    store.append("c1", _muestra(1002.0))

    assert len(store.get("c1").samples) == 2
    assert len(store.get("c2").samples) == 1
