# SPDX-License-Identifier: AGPL-3.0-or-later
from pydantic import BaseModel, Field


class ContainerStats(BaseModel):
    container_id: str
    container_name: str
    cpu_percent: float = Field(..., description="Porcentaje de uso de CPU (0-100% * número de cores)")
    memory_usage: int = Field(..., description="Bytes de memoria RAM utilizados")
    memory_limit: int = Field(..., description="Límite de memoria RAM asignado en bytes")
    memory_percent: float = Field(..., description="Porcentaje de memoria RAM utilizado (0-100%)")
    network_rx_bytes: int = Field(..., description="Total de bytes recibidos por interfaces de red")
    network_tx_bytes: int = Field(..., description="Total de bytes transmitidos por interfaces de red")
    block_read_bytes: int = Field(..., description="Total de bytes leídos de almacenamiento de bloque")
    block_write_bytes: int = Field(..., description="Total de bytes escritos a almacenamiento de bloque")
    pids_current: int | None = Field(None, description="Número de procesos activos en el contenedor")
    timestamp: str = Field(..., description="Marca temporal ISO 8601 del reporte de estadísticas")
