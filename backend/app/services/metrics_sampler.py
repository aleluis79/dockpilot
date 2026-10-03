# SPDX-License-Identifier: AGPL-3.0-or-later
"""El muestreador de métricas (SPEC-17 §4.2).

Una sola tarea de asyncio para todo el panel. Ni una por contenedor, ni un
`create_task` por pin: el coste de esa decisión son cuarenta líneas y una sola
lista de cancelación, y es la diferencia entre esta spec y la clase de bug que
`agent.md` ya documenta dos veces sobre tareas y conexiones huérfanas.

Dos mediciones del daemon mandan sobre el diseño (SPEC-17 §2.6):

* **`stats(stream=False)` tarda ~1004 ms.** No es una lectura, es una espera a la
  próxima ola de recolección del daemon. Por eso las lecturas van en un
  `gather`: secuencial, un tic con doce observados duraría doce segundos y
  nunca volvería a su periodo de dos.
* **Un contenedor parado responde `200` con un frame de `null`**, no un `409`.
  Por eso el estado se pregunta con un `containers.list()` por tic —16-26 ms
  para todos, contra 0,3 ms por `show()` pero N llamadas— y a los que no están
  en marcha ni se les pregunta. Un cero habría sido un invento (§4.5).
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable

import aiodocker

from app.schemas.metrics import MetricSample
from app.services.metrics_store import MetricsStore, get_store
from app.services.stats_service import calculate_stats

logger = logging.getLogger(__name__)


def _short_id(container_id: str) -> str:
    return container_id[:12] if len(container_id) > 12 else container_id


def _short_name(container_id: str, info: dict | None) -> str:
    nombres = (info or {}).get("Names") or []
    nombre = str(nombres[0]) if nombres else ""
    return nombre.lstrip("/") or _short_id(container_id)


async def _estado_del_host(docker: aiodocker.Docker) -> dict[str, dict]:
    """Un `list()` y con él el estado de todos los observados.

    Se filtra por `all=False`: un contenedor parado no sale, y no salir es
    exactamente la respuesta que se necesita. Es una llamada por tic en lugar de
    una por contenedor, que es la diferencia entre un tope de 16 ms y otro de
    16 ms por contenedor.
    """
    contenedores = await docker.containers.list(all=False)
    estado: dict[str, dict] = {}
    for c in contenedores:
        datos = c if isinstance(c, dict) else getattr(c, "_container", None)
        if not isinstance(datos, dict):
            continue
        cid = str(datos.get("Id") or "")
        if not cid:
            continue
        estado[_short_id(cid)] = datos
    return estado


async def _leer_una_muestra(
    docker: aiodocker.Docker,
    container_id: str,
    info: dict,
    now: Callable[[], float],
) -> MetricSample | None:
    """Una lectura de un contenedor en marcha. Devuelve `None` si no se pudo.

    No distingue "no se pudo" de "no hay datos": las dos cosas dejan el anillo
    igual que estaba, que es un hueco y no un cero.
    """
    try:
        contenedor = await docker.containers.get(container_id)
        crudo = contenedor.stats(stream=False)
        muestras = await crudo if asyncio.iscoroutine(crudo) else crudo
    except Exception as e:
        # El 900 de aiodocker no es un código HTTP y aquí no se sirve nada, así
        # que no hay status que traducir: sólo se avisa y se sigue.
        logger.warning("No se pudo muestrear %s: %s", container_id, e)
        return None

    if not muestras:
        return None
    ultimo = muestras[-1] if isinstance(muestras, list) else muestras
    stats = calculate_stats(ultimo, container_id=container_id, container_name=_short_name(container_id, info))
    return MetricSample(
        # El reloj del backend y no el `read` del daemon: `t` tiene que ser
        # comparable con el `t` de las otras muestras del anillo, y el `read` es
        # una cadena ISO con nanosegundos y zona horaria.
        t=now(),
        cpu_percent=stats.cpu_percent,
        memory_percent=stats.memory_percent,
        network_rx_bytes=stats.network_rx_bytes,
        network_tx_bytes=stats.network_tx_bytes,
        block_read_bytes=stats.block_read_bytes,
        block_write_bytes=stats.block_write_bytes,
    )


async def muestrear_una_vez(
    docker: aiodocker.Docker,
    *,
    store: MetricsStore | None = None,
    now: Callable[[], float] | None = None,
) -> None:
    """Un tic: estado de todos, lectura de los observados que estén en marcha.

    Es una función aparte del bucle para que los tests puedan ejercitar un tic
    entero sin dormir ni una tarea que cancelar.
    """
    almacen = store or get_store()
    reloj = now or time.time

    observados = almacen.observed_ids()
    if not observados:
        return

    try:
        estado = await _estado_del_host(docker)
    except Exception as e:
        # El daemon caído es el fallo más probable de todo el panel. Se avisa y
        # el tic no mide nada: adivinar qué está en marcha sería meter ceros.
        logger.warning("No se pudo leer el estado de los contenedores: %s", e)
        return

    en_marcha: list[tuple[str, dict]] = []
    for cid in observados:
        info = estado.get(cid)
        if info is None:
            # Parado o borrado: se dice que no lo está y no se le mide. Su serie
            # no se toca, así que vuelve entera cuando arrancar.
            almacen.estado(cid, running=False)
            continue
        almacen.estado(cid, running=True, name=_short_name(cid, info))
        en_marcha.append((cid, info))

    if not en_marcha:
        return

    resultados = await asyncio.gather(
        *(_leer_una_muestra(docker, cid, info, reloj) for cid, info in en_marcha),
        return_exceptions=True,
    )
    for (cid, _info), resultado in zip(en_marcha, resultados, strict=True):
        if isinstance(resultado, BaseException):
            logger.warning("No se pudo muestrear %s: %s", cid, resultado)
            continue
        if resultado is not None:
            almacen.append(cid, resultado)

    almacen.evict_expired()


async def bucle_muestreo(
    docker: aiodocker.Docker,
    *,
    store: MetricsStore | None = None,
    interval_s: float | None = None,
    now: Callable[[], float] | None = None,
) -> None:
    """El bucle. Una tarea, un `sleep`, y un `CancelledError` que se propaga.

    El `sleep` va **después** del tic y no antes: si fuera antes, el primer tic
    tardaría un periodo entero en arrancar y el panel perdería las primeras
    muestras de todo contenedor que se observe al abrirlo.
    """
    almacen = store or get_store()
    periodo = interval_s if interval_s is not None else almacen.interval_s

    while True:
        try:
            await muestrear_una_vez(docker, store=almacen, now=now)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.warning("Fallo en el tic de muestreo: %s", e)
        await asyncio.sleep(periodo)
