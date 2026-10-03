# SPDX-License-Identifier: AGPL-3.0-or-later
"""Contratos de las series temporales de métricas (SPEC-17).

Una muestra es **lo que dijo el daemon, sin interpretar**: los contadores van
en absolutos y las tasas las deriva el cliente, porque una tasa necesita dos
muestras y saber cuánto tiempo pasó entre ellas (§4.4). Aquí no hay ningún
campo que sea una media, un mínimo o un máximo: eso se calcula al pintar, y
guardarlo sería guardar dos verdades.

Y hay un campo que no está, y es el importante: **ninguna muestra significa
"no se midió"**. Un contenedor parado no deja una muestra a cero, deja un hueco
(§4.5), y `MetricsHistory.running` dice por qué.
"""

from pydantic import BaseModel, Field


class MetricSample(BaseModel):
    """Una medición de un contenedor en un instante.

    `t` es un epoch en segundos, no la cadena ISO-8601 que usa `ContainerStats`.
    La serie se consume por diferencias, y por diferencias de tiempo: un
    `float` evita parsear cientos de cadenas en cada render y no tiene ambigüedad
    de zona horaria que el reloj del navegador pueda interpretar de otra manera.
    """

    t: float = Field(..., description="Epoch en segundos, del reloj del backend")
    cpu_percent: float = Field(..., description="Porcentaje de CPU (0-100% * número de cores)")
    memory_percent: float = Field(..., description="Porcentaje de memoria RAM utilizada (0-100%)")
    network_rx_bytes: int = Field(..., description="Total acumulado de bytes recibidos")
    network_tx_bytes: int = Field(..., description="Total acumulado de bytes transmitidos")
    block_read_bytes: int = Field(..., description="Total acumulado de bytes leídos de bloque")
    block_write_bytes: int = Field(..., description="Total acumulado de bytes escritos de bloque")


class MetricsHistory(BaseModel):
    """La serie de un contenedor, con lo que el panel sabe y con lo que no.

    Los cuatro campos de estado están porque un estado vacío sin explicar por qué
    está vacío se lee como un fallo del panel (SPEC-17 §4.8): `running` dice si
    el contenedor está en marcha, `observed` si está fijado, `sampling` si el
    muestreador lo está midiendo ahora, y `truncated` si el anillo descartó
    muestras por el tope.
    """

    container_id: str
    container_name: str = ""
    running: bool = Field(False, description="Si el contenedor está en marcha ahora")
    observed: bool = Field(False, description="Si está fijado y el muestreador lo sigue")
    sampling: bool = Field(False, description="Si el muestreador lo está midiendo en este momento")
    interval_s: float = Field(..., description="Periodo con el que se pretende muestrear")
    window_s: int = Field(..., description="Ventana que abarca el anillo")
    truncated: bool = Field(False, description="El anillo descartó muestras por el tope")
    samples: list[MetricSample] = Field(default_factory=list)


class WatchResponse(BaseModel):
    """Respuesta de fijar o dejar de observar. El estado vive en el backend."""

    container_id: str
    observed: bool
