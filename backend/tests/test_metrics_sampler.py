# SPDX-License-Identifier: AGPL-3.0-or-later
"""El muestreador (SPEC-17 §4.2).

Dos cosas medidas mandan sobre el diseño de este módulo:

1. **`stats(stream=False)` tarda ~1004 ms**, así que las lecturas de todos los
   observados tienen que ir en un `gather`. Secuencial, un tic con 12
   observados duraría 12 s y nunca volvería a su periodo.
2. **Un contenedor parado responde `200` con un frame de `null`**, no un 409.
   Por eso el estado se pregunta con un `containers.list()` por tic y a los
   parados ni se les pregunta.
"""

import asyncio

import pytest
from aiodocker.exceptions import DockerError

from app.core.config import settings
from app.schemas.metrics import MetricSample
from app.services.metrics_sampler import bucle_muestreo, muestrear_una_vez
from app.services.metrics_store import MetricsStore

pytestmark = pytest.mark.asyncio


class Reloj:
    def __init__(self, ahora: float = 1_000_000.0):
        self.ahora = ahora

    def __call__(self) -> float:
        return self.ahora

    def avanzar(self, segundos: float) -> None:
        self.ahora += segundos


@pytest.fixture
def reloj() -> Reloj:
    return Reloj()


@pytest.fixture
def store(reloj) -> MetricsStore:
    return MetricsStore(now=reloj, max_samples=100, max_tracked=12, ttl_s=600)


async def test_mide_un_observado_por_tic(mock_docker, store, reloj):
    store.observe("c123")

    await muestrear_una_vez(mock_docker, store=store, now=reloj)

    muestras = store.get("c123").samples
    assert len(muestras) == 1
    # El valor viene de `calculate_stats`, no de un dict crudo: con el doble de
    # test, CPU = (1000/10000) * 2 * 100 = 20.0 %.
    assert muestras[0].cpu_percent == pytest.approx(20.0)
    assert muestras[0].memory_percent == pytest.approx(5.0)
    assert muestras[0].network_rx_bytes == 300
    assert muestras[0].block_write_bytes == 222


async def test_no_mide_lo_que_no_está_observado(mock_docker, store, reloj):
    """Sin pin no hay muestreo. Mirar el modal no convierte al contenedor en
    observado: mirar y observar son cosas distintas (SPEC-17 §3.1)."""
    await muestrear_una_vez(mock_docker, store=store, now=reloj)

    assert store.tracked_ids() == []


async def test_una_lectura_por_contenedor_por_tic(mock_docker, store, reloj):
    """Un tic, una lectura por contenedor. Tres tic del mismo contenedor dan tres
    muestras y no nueve: el que escribe en el anillo es el muestreador, y sólo
    uno, así que abrir tres conexiones al WebSocket no triplica el coste."""
    store.observe("c123")

    for _ in range(3):
        await muestrear_una_vez(mock_docker, store=store, now=reloj)

    assert len(store.get("c123").samples) == 3
    assert mock_docker.containers.get.await_count == 3


async def test_no_añade_muestras_a_un_contenedor_parado(mock_docker, store, reloj):
    """El caso que mide la §2.6: el daemon responde 200 con un frame vacío a un
    contenedor parado, y pasado por `calculate_stats` eso son ceros. Un cero en
    la gráfica afirmaría que el contenedor no usa CPU, que no es lo que se sabe."""
    store.observe("c456")  # /db-postgres, exited

    await muestrear_una_vez(mock_docker, store=store, now=reloj)

    h = store.get("c456")
    assert h.samples == []
    assert h.running is False
    # Ni siquiera se le ha preguntado: se sabe por el `list()` del tic.
    assert mock_docker.containers.get.await_count == 0


async def test_el_estado_viene_de_un_solo_list(mock_docker, store, reloj):
    """El estado de todos los observados sale de una llamada, no de una por
    contenedor. Medido: 16-26 ms para el listado completo contra 0,3 ms por
    `show()`, pero `show()` son N llamadas."""
    for cid in ("c123", "c789", "c790", "c791"):
        store.observe(cid)

    await muestrear_una_vez(mock_docker, store=store, now=reloj)

    mock_docker.containers.list.assert_awaited_once()
    for cid in ("c123", "c789", "c790", "c791"):
        assert store.get(cid).running is True
        assert len(store.get(cid).samples) == 1


async def test_el_nombre_llega_al_anillo(mock_docker, store, reloj):
    store.observe("c123")

    await muestrear_una_vez(mock_docker, store=store, now=reloj)

    assert store.get("c123").container_name == "web-app"


async def test_la_lectura_es_concurrente(mock_docker, store, reloj):
    """El `gather` no es una optimización: cada lectura cuesta ~1 s. Con cuatro
    observados, secuencial el tic duraría 4 s."""
    for cid in ("c123", "c789", "c790", "c791"):
        store.observe(cid)

    en_curso = {"n": 0, "maximo": 0}

    original = mock_docker.containers.get.side_effect

    async def get_lento(cid):
        en_curso["n"] += 1
        en_curso["maximo"] = max(en_curso["maximo"], en_curso["n"])
        await asyncio.sleep(0)
        en_curso["n"] -= 1
        return await original(cid)

    mock_docker.containers.get.side_effect = get_lento

    await muestrear_una_vez(mock_docker, store=store, now=reloj)

    assert en_curso["maximo"] > 1


async def test_sobrevive_a_docker_error(mock_docker, store, reloj, caplog):
    """El 900 de aiodocker no es un código HTTP, y el daemon caído es el fallo
    más probable de todo el panel. El muestreador avisa y sigue vivo."""
    store.observe("c123")
    original = mock_docker.containers.get.side_effect

    async def get_fallido(cid):
        raise DockerError(900, "Cannot connect to Docker Engine via unix:///var/run/docker.sock")

    mock_docker.containers.get.side_effect = get_fallido

    await muestrear_una_vez(mock_docker, store=store, now=reloj)

    assert store.get("c123").samples == []

    # Y el siguiente tic funciona: un fallo transitorio no deja el muestreador
    # muerto, que es lo que pasa con un `except` mal colocado.
    mock_docker.containers.get.side_effect = original
    await muestrear_una_vez(mock_docker, store=store, now=reloj)
    assert len(store.get("c123").samples) == 1


async def test_sobrevive_a_docker_error_en_el_listado(mock_docker, store, reloj):
    """Si el `list()` falla, no se samplinga nada y no se cae: sin estado no se
    sabe qué está en marcha, y adivinarlo sería meter ceros."""
    store.observe("c123")
    mock_docker.containers.list.side_effect = DockerError(900, "Cannot connect")

    await muestrear_una_vez(mock_docker, store=store, now=reloj)

    assert store.get("c123").samples == []


async def test_el_periodo_viene_de_la_configuración(store, reloj):
    assert store.interval_s == settings.METRICS_SAMPLE_INTERVAL_S
    assert store.interval_s >= 2.0, "por debajo de 2 s ningún tic cae en la ola del daemon"


async def test_la_marca_de_tiempo_la_pone_el_reloj_del_backend(mock_docker, store, reloj):
    """`t` es del backend y no del `read` del daemon: el panel necesita un reloj
    con el que comparar sus propios `t`, y el `read` del daemon es una cadena
    ISO con nanosegundos y zona."""
    store.observe("c123")
    reloj.ahora = 1_700_000_000.5

    await muestrear_una_vez(mock_docker, store=store, now=reloj)

    assert store.get("c123").samples[0].t == 1_700_000_000.5


async def test_la_muestra_es_del_tipo_del_contrato(mock_docker, store, reloj):
    store.observe("c123")
    await muestrear_una_vez(mock_docker, store=store, now=reloj)

    assert isinstance(store.get("c123").samples[0], MetricSample)


async def test_no_se_pregunta_a_lo_que_no_está_observado_aunque_esté_en_marcha(
    mock_docker, store, reloj
):
    """El coste del panel es el de los observados, ni uno más. Con el pin vacío
    no se llega ni a preguntar el estado: cero tráfico contra el daemon."""
    await muestrear_una_vez(mock_docker, store=store, now=reloj)

    assert mock_docker.containers.list.await_count == 0
    assert mock_docker.containers.get.await_count == 0


# --- El bucle ---------------------------------------------------------------


async def test_el_bucle_mide_una_vez_por_tic(mock_docker, store):
    store.observe("c123")
    ticks = 0

    async def dormir(_periodo):
        nonlocal ticks
        ticks += 1
        if ticks >= 3:
            raise asyncio.CancelledError

    monkey = {"sleep": dormir}
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(asyncio, "sleep", dormir)
        with pytest.raises(asyncio.CancelledError):
            await bucle_muestreo(mock_docker, store=store, interval_s=0)

    # Tres tics, tres muestras. Ni una más: un bucle que mide dos veces por tic
    # no está muestreando más, está duplicando el coste.
    assert len(store.get("c123").samples) == 3
    assert monkey["sleep"] is dormir


async def test_el_bucle_no_muere_por_un_tic_fallido(mock_docker, store):
    """Un `DockerError` con el pin vacío no falla, pero el bucle tiene que
    sobrevivir a lo que sea: si un tic lo mata, el panel deja de muestrear en
    silencio y nadie se entera."""
    ticks = 0

    async def dormir(_periodo):
        nonlocal ticks
        ticks += 1
        if ticks >= 2:
            raise asyncio.CancelledError

    async def tic_fallido(*_a, **_kw):
        raise RuntimeError("boom")

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(asyncio, "sleep", dormir)
        mp.setattr("app.services.metrics_sampler.muestrear_una_vez", tic_fallido)
        with pytest.raises(asyncio.CancelledError):
            await bucle_muestreo(mock_docker, store=store, interval_s=0)

    assert ticks == 2


async def test_el_cliente_de_docker_se_espera_antes_de_muestrear():
    """`get_docker()` es `async` porque existe para ser dependencia de FastAPI.

    Pasarle el coroutine sin `await` hace que el muestreador escriba contra un
    objeto que no es un cliente de Docker, y el fallo no sale al arrancar: sale
    en el primer tic, cuando ya hay algo que perder. Este test mira el arranque
    del lifespan, que es donde esa espera tiene que estar.
    """
    import inspect

    from app.main import lifespan

    fuente = inspect.getsource(lifespan)
    assert "bucle_muestreo(await get_docker())" in fuente
    assert "bucle_muestreo(get_docker())" not in fuente


# --- La expulsión por antigüedad tiene que correr siempre ---------------------
#
# `evict_expired()` estaba al final del camino feliz del tic, detrás de tres
# salidas tempranas. Con cero observados —el caso normal de un panel en uso
# ligero— el tic se iba por `if not observados: return` y no expulsaba NADA. Es
# justo el caso en el que hay algo que limpiar: el histórico de quien miró un
# contenedor y cerró la ventana.
#
# No era una fuga (max_tracked acota a 12 anillos), pero dejaba el TTL sin efecto
# en el estado del panel y hacía que los anillos sólo se fueran cuando, por
# casualidad, había algo observado y en marcha.


async def test_expulsa_aunque_no_haya_nada_observado(mock_docker, store, reloj):
    store.append("c-visitado", MetricSample(
        t=1000.0, cpu_percent=1.0, memory_percent=1.0,
        network_rx_bytes=0, network_tx_bytes=0, block_read_bytes=0, block_write_bytes=0,
    ))
    assert store.tracked_ids() != []

    reloj.avanzar(store.ttl_s + 1)
    await muestrear_una_vez(mock_docker, store=store, now=reloj)

    assert store.tracked_ids() == []


async def test_expulsa_aunque_el_daemon_no_responda(mock_docker, store, reloj):
    """El TTL es limpieza, no medida: si el daemon se cae no hay razón para
    dejar de limpiar, y al revés tampoco."""
    store.append("c-visitado", MetricSample(
        t=1000.0, cpu_percent=1.0, memory_percent=1.0,
        network_rx_bytes=0, network_tx_bytes=0, block_read_bytes=0, block_write_bytes=0,
    ))
    store.observe("c-observado")
    reloj.avanzar(store.ttl_s + 1)

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(
            "app.services.metrics_sampler._estado_del_host",
            _que_falla,
        )
        await muestrear_una_vez(mock_docker, store=store, now=reloj)

    # El no observado se va. El observado tampoco: el pin se va con su anillo
    # (§4.3), y sin lecturas no hay forma de saber que sigue existiendo.
    assert store.tracked_ids() == []


async def _que_falla(_docker):
    raise DockerError(500, "el daemon no responde")
