# SPDX-License-Identifier: AGPL-3.0-or-later
"""El anillo de métricas (SPEC-17).

Es el primer estado que el backend recuerda entre peticiones, y deliberately
está en memoria y con topes: no hay base de datos, no hay persistencia y
reiniciar el panel lo borra todo (§4.8). Un anillo sin tope no es un histórico,
es una fuga.

Tres reglas que salen de la estructura y que no son negociables:

1. **`append()` es el único escritor.** El WebSocket de métricas no lo llama:
   el stream en vivo y el anillo acabarían con dos puntos distintos para la
   misma muestra (§4.1).
2. **Un contenedor parado no deja una muestra.** No se añade ni un 0, porque
   un 0 dibujado afirma "no usa CPU" y lo que se sabe es "no se está midiendo".
   El hueco se ve como hueco (§4.5).
3. **Un truncado que no se dice es un dato que miente.** Por eso `truncated`
   viaja en la respuesta, igual que `COMPOSE_BROWSE_MAX` lo hacía en su día.
"""

from __future__ import annotations

import time
from collections import deque
from collections.abc import Callable

from app.core.config import settings
from app.schemas.metrics import MetricSample, MetricsHistory


def _clave(container_id: str) -> str:
    """La clave de un anillo es el **id corto**, que es lo que el daemon manda en
    `/containers/json` y lo que viaja en el listado del panel.

    Normalizar aquí, y no en quien llama, es lo que evita la clase de bug que
    agent.md documenta con las etiquetas: un módulo que recorta el id y otro que
    no son dos reglas, y se discrepan en cuanto uno de los dos recibe el id
    entero. Aquí entran el id largo y el corto y salen la misma clave.
    """
    return container_id[:12] if len(container_id) > 12 else container_id


class _Anillo:
    """El estado de un contenedor dentro del almacén."""

    __slots__ = (
        "activity",
        "container_id",
        "name",
        "observed",
        "running",
        "sampled_at",
        "samples",
        "truncated",
    )

    def __init__(self, container_id: str, activity: float) -> None:
        self.container_id = container_id
        self.samples: deque[MetricSample] = deque()
        self.observed = False
        self.running = False
        self.name = ""
        # `sampled_at` es de reloj de pared, no el `t` de las muestras: lo que
        # responde es "¿se está midiendo ahora?", y eso lo contesta el reloj del
        # backend, no la marca del daemon.
        self.sampled_at: float | None = None
        self.activity = activity
        self.truncated = False


class MetricsStore:
    """Anillos por contenedor, con topes de muestras, de anillos y de antigüedad.

    El reloj es inyectable porque los tres topes se prueban con los valores de
    `config.py` (450 muestras, 12 anillos, 1800 s) y esperar a que ocurran en un
    test convertiría la suite en media hora de reloj.
    """

    def __init__(
        self,
        *,
        now: Callable[[], float] | None = None,
        interval_s: float | None = None,
        max_samples: int | None = None,
        max_tracked: int | None = None,
        ttl_s: float | None = None,
    ) -> None:
        self._now = now or time.time
        self.interval_s = interval_s if interval_s is not None else settings.METRICS_SAMPLE_INTERVAL_S
        self.max_samples = max_samples if max_samples is not None else settings.METRICS_MAX_SAMPLES
        self.max_tracked = max_tracked if max_tracked is not None else settings.METRICS_MAX_TRACKED
        self.ttl_s = ttl_s if ttl_s is not None else settings.METRICS_TTL_S
        self._anillos: dict[str, _Anillo] = {}

    # -- ventana ------------------------------------------------------------

    @property
    def window_s(self) -> int:
        """La ventana que abarca el anillo. Es la que la interfaz ofrece como
        máximo, y por eso el tope de muestras y el de ventana son el mismo
        número dicho de dos maneras."""
        return int(self.max_samples * self.interval_s)

    # -- escritura ----------------------------------------------------------

    def append(self, container_id: str, sample: MetricSample) -> None:
        """Añade una muestra. **Único escritor del anillo** (§4.1)."""
        ahora = self._now()
        clave = _clave(container_id)
        anillo = self._anillos.get(clave)
        if anillo is None:
            anillo = self._crear(clave, ahora)
            if anillo is None:
                return

        anillo.samples.append(sample)
        anillo.sampled_at = ahora
        anillo.activity = ahora

        while len(anillo.samples) > self.max_samples:
            anillo.samples.popleft()
            anillo.truncated = True

    def estado(self, container_id: str, *, running: bool, name: str | None = None) -> None:
        """Fija lo que se sabe del contenedor sin aún haberlo medido.

        Es el estado del tic, no una medición: por eso no añade ninguna muestra
        y por eso un contenedor que se para deja de "estar midiéndose" sin que
        su serie pierda una sola de las que tenía.
        """
        ahora = self._now()
        clave = _clave(container_id)
        anillo = self._anillos.get(clave)
        if anillo is None:
            anillo = self._crear(clave, ahora)
            if anillo is None:
                return
        anillo.running = running
        if name:
            anillo.name = name
        anillo.activity = ahora

    def _crear(self, container_id: str, ahora: float) -> _Anillo | None:
        """Crea un anillo si cabe. Si no cabe, expulsa al más viejo no observado
        y reintenta; si todos están observados, **no crea** y devuelve `None`.

        El tope se aplica aquí y no en `observe()` a propósito: si sólo estuviera
        en `observe()`, un `append()` sobre un id nuevo lo esquivaría y el número
        de anillos dejaría de estar acotado.
        """
        if len(self._anillos) < self.max_tracked:
            anillo = _Anillo(container_id, ahora)
            self._anillos[container_id] = anillo
            return anillo

        self._expulsar_no_observado()
        if len(self._anillos) >= self.max_tracked:
            return None
        anillo = _Anillo(container_id, ahora)
        self._anillos[container_id] = anillo
        return anillo

    # -- el pin -------------------------------------------------------------

    def observe(self, container_id: str) -> bool:
        """Fija un contenedor. Devuelve `False` si no cabe y no se puede expulsar
        a nadie: el que se expulsa es siempre el más viejo **no observado**,
        porque apagar un histórico que alguien pidió sería peor que no
        acomodar la petición."""
        ahora = self._now()
        clave = _clave(container_id)
        anillo = self._anillos.get(clave)
        if anillo is not None:
            if not anillo.observed:
                anillo.observed = True
                anillo.activity = ahora
            return True

        # `_crear()` es la puerta del tope y ya se encarga de expulsar al más
        # viejo no observado si hace falta (§4.2). Por eso aquí no se repite: la
        # versión anterior que sí lo repetía quedó inalcanzable detrás de este
        # `return True`, y para siempre.
        anillo = self._crear(clave, ahora)
        if anillo is None:
            return False
        anillo.observed = True
        return True

    def unobserve(self, container_id: str) -> None:
        ahora = self._now()
        anillo = self._anillos.get(_clave(container_id))
        if anillo is None:
            return
        anillo.observed = False
        anillo.activity = ahora

    def is_observed(self, container_id: str) -> bool:
        anillo = self._anillos.get(_clave(container_id))
        return bool(anillo and anillo.observed)

    def observed_ids(self) -> list[str]:
        return [cid for cid, anillo in self._anillos.items() if anillo.observed]

    def _expulsar_no_observado(self) -> None:
        """Expulsa el anillo no observado con más antigüedad. Si todos están
        observados no expulsa nada, y quien llama lo nota en el `False`."""
        candidatos = [a for a in self._anillos.values() if not a.observed]
        if not candidatos:
            return
        viejo = min(candidatos, key=lambda a: a.activity)
        del self._anillos[viejo.container_id]

    # -- lectura ------------------------------------------------------------

    def get(self, container_id: str) -> MetricsHistory:
        """La serie de un contenedor. **No crea el anillo**: mirar no es observar,
        y un `GET` que dejara al contenedor midiéndose sería el coste de una
        llamada al daemon cada 2 s que nadie pidió."""
        ahora = self._now()
        clave = _clave(container_id)
        anillo = self._anillos.get(clave)
        if anillo is None:
            return MetricsHistory(
                container_id=clave,
                container_name="",
                running=False,
                observed=False,
                sampling=False,
                interval_s=self.interval_s,
                window_s=self.window_s,
                truncated=False,
                samples=[],
            )

        # Muestrear cuenta como actividad aunque no haya añadido muestra: si no,
        # un contenedor observado y parado —que no deja muestras— vería expirar
        # su anillo y perdería el pin solo (§4.8).
        if anillo.observed:
            anillo.activity = ahora

        return MetricsHistory(
            container_id=clave,
            container_name=anillo.name,
            running=anillo.running,
            observed=anillo.observed,
            sampling=self._esta_muestreando(anillo, ahora),
            interval_s=self.interval_s,
            window_s=self.window_s,
            truncated=anillo.truncated,
            samples=list(anillo.samples),
        )

    def _esta_muestreando(self, anillo: _Anillo, ahora: float) -> bool:
        if not (anillo.observed and anillo.running and anillo.sampled_at is not None):
            return False
        # Tres periodos de margen: un tic que se pasó de largo no debe dejar de
        # reportarse como "midiendo" mientras el siguiente sigue en marcha.
        return (ahora - anillo.sampled_at) <= 3 * self.interval_s

    def tracked_ids(self) -> list[str]:
        return list(self._anillos.keys())

    # -- expulsión por antigüedad -------------------------------------------

    def evict_expired(self) -> None:
        """Tira los anillos sin actividad durante más de `ttl_s`. **También los
        observados**, y no es un descuido: el pin es un flag en memoria atado a
        su anillo, así que un anillo observado que nadie suelta se lleva el pin
        detrás y el panel deja de medirlo sin que nadie lo pidiera (§4.3).

        Lo que evita que eso duela es que el anillo observado se refresca en cada
        tic (`estado()`) y en cada lectura (`get()`): un contenedor **parado** no
        deja muestras, y si la antigüedad no lo viera, su pin se iría solo por no
        tener nada que escribir.

        Soltar un pin es de quien lo fijó, y lo hace `unobserve()`, no el reloj.
        Lo que el reloj suelta es el resto: el histórico de alguien que miró un
        contenedor y se fue.
        """
        ahora = self._now()
        caducados = [cid for cid, anillo in self._anillos.items() if ahora - anillo.activity > self.ttl_s]
        for cid in caducados:
            del self._anillos[cid]


# El módulo expone un único anillo, como `get_docker()` expone un único cliente:
# es el estado del panel, no el de una petición. `reset_store()` existe para los
# tests, que de otro modo heredarían los pines del test anterior.
_store = MetricsStore()


def get_store() -> MetricsStore:
    return _store


def reset_store() -> MetricsStore:
    """Vacía el anillo del módulo. Sólo para tests: en producción el estado vive
    hasta que el proceso muere, que es justo lo que se le dijo al usuario."""
    global _store
    _store = MetricsStore()
    return _store
