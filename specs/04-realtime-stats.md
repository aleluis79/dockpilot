# SPEC-04: Métricas y Estadísticas en Tiempo Real (CPU, RAM, Red, Disco)

## 1. Contexto y Objetivos
- **Problema**: Evaluar el impacto de los contenedores en los recursos de la máquina local (consumo de CPU, memoria RAM consumida vs. límite asignado, tráfico de red y operaciones de I/O de disco) requiere recurrir al comando `docker stats` por terminal de forma aislada. Los desarrolladores necesitan una monitorización visual, reactiva y clara directamente desde el panel de control web.
- **Objetivo**: Implementar un canal WebSocket para streaming continuo de estadísticas y un endpoint REST complementario para lecturas instantáneas, permitiendo visualizar métricas en tiempo real con indicadores visuales (CPU %, Memoria %, Red Rx/Tx, Disco Read/Write, PIDs) y un mini gráfico de historial reciente.
- **Alcance**:
  - Incluye:
    - Endpoint REST `GET /api/v1/containers/{id}/stats` (instantánea de métricas).
    - Canal WebSocket `/ws/containers/{id}/stats` (streaming continuo emitido por Docker).
    - Lógica de cálculo y normalización de métricas de Docker (CPU %, memoria efectiva, red total, I/O de bloques).
    - Hook de React `useDockerStats` para gestión del ciclo de vida del WebSocket y retención de historial reciente (últimos 20-30 puntos).
    - Componente modal `StatsModal` con tarjetas de métricas, barras de progreso dinámicas, badges y gráficos reactivos (SVG / Sparklines).
    - Botón de acceso directo a métricas en la tabla de contenedores (`ContainersTable`).
  - No incluye (en esta spec):
    - Terminal interactivo `xterm.js` (cubierto en SPEC-05).
    - Persistencia en base de datos histórica de métricas a largo plazo (enfoque exclusivamente en vivo / local).

---

## 2. Contrato de Datos (Schemas & Types)

### Backend (Pydantic v2) - `app/schemas/stats.py`
```python
from typing import Optional
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
    pids_current: Optional[int] = Field(None, description="Número de procesos activos en el contenedor")
    timestamp: str = Field(..., description="Marca temporal ISO 8601 del reporte de estadísticas")
```

### Frontend (TypeScript) - `src/types/stats.ts`
```typescript
export interface ContainerStats {
  container_id: string;
  container_name: string;
  cpu_percent: number;
  memory_usage: number;
  memory_limit: number;
  memory_percent: number;
  network_rx_bytes: number;
  network_tx_bytes: number;
  block_read_bytes: number;
  block_write_bytes: number;
  pids_current?: number;
  timestamp: string;
}

export interface StatsHistoryPoint {
  timestamp: string;
  cpu_percent: number;
  memory_percent: number;
}
```

---

## 3. Algoritmo de Cálculo y Normalización de Métricas

A partir del diccionario crudo provisto por la API del daemon Docker (`/containers/{id}/stats`):

1. **CPU Porcentaje (`cpu_percent`)**:
   $$\Delta \text{CPU} = \text{cpu\_stats.cpu\_usage.total\_usage} - \text{precpu\_stats.cpu\_usage.total\_usage}$$
   $$\Delta \text{Sistema} = \text{cpu\_stats.system\_cpu\_usage} - \text{precpu\_stats.system\_cpu\_usage}$$
   $$\text{online\_cpus} = \text{cpu\_stats.online\_cpus} \lor \text{len(cpu\_stats.cpu\_usage.percpu\_usage)} \lor 1$$
   $$\text{cpu\_percent} = \left(\frac{\Delta \text{CPU}}{\Delta \text{Sistema}}\right) \times \text{online\_cpus} \times 100.0 \quad (\text{si } \Delta \text{Sistema} > 0 \text{ y } \Delta \text{CPU} > 0, \text{ sino } 0.0)$$

2. **Memoria RAM (`memory_usage`, `memory_limit`, `memory_percent`)**:
   - `memory_limit` = `memory_stats.limit`
   - Descuento de caché/buffers (cgroups v1 `cache`, cgroups v2 `inactive_file`):
     `inactive_cache = memory_stats.stats.inactive_file or memory_stats.stats.cache or 0`
     `memory_usage = max(0, memory_stats.usage - inactive_cache)`
   - `memory_percent = (memory_usage / memory_limit) * 100.0` (si `memory_limit > 0`, sino `0.0`)

3. **Red I/O (`network_rx_bytes`, `network_tx_bytes`)**:
   - Suma acumulativa a través de todos los adaptadores en `networks` (`eth0`, etc.):
     $$\text{rx\_bytes} = \sum \text{net['rx\_bytes']}, \quad \text{tx\_bytes} = \sum \text{net['tx\_bytes']}$$

4. **Disco/Block I/O (`block_read_bytes`, `block_write_bytes`)**:
   - Suma sobre las entradas de `blkio_stats.io_service_bytes_recursive` agrupadas por operación (`Read` y `Write`).

---

## 4. Contrato de API y WebSockets

### 4.1. Endpoint REST (Instantánea)
| Método | Endpoint | Parámetros | Código Respuesta | Descripción |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/containers/{id}/stats` | Ninguno | `200 OK`: `ContainerStats` | Devuelve la instantánea calculada más reciente |
| `GET` | `/api/v1/containers/{id}/stats` | Id inexistente | `404 Not Found` | Error con detalle del contenedor no encontrado |
| `GET` | `/api/v1/containers/{id}/stats` | Contenedor no en ejecución | `200 OK` (valores a 0) | Retorna estadísticas en reposo con métricas en cero |

### 4.2. Canal WebSocket
- **Ruta**: `/ws/containers/{id}/stats`
- **Flujo**:
  - Al conectarse el cliente, el backend inicia la subscripción asíncrona a `container.stats(stream=True)`.
  - Con cada lectura del generador asíncrono, se calcula la estructura normalizada `ContainerStats` y se envía un mensaje JSON al cliente.
  - Si el contenedor no existe, se envía el código de cierre `4404`.
  - Al desconectarse el cliente (`WebSocketDisconnect`), la tarea de streaming de Docker se cancela inmediatamente para evitar fugas de memoria o sockets abiertos.

---

## 5. Criterios de Aceptación (Gherkin en Español)

```gherkin
# language: es
Característica: Monitorización y visualización de métricas en tiempo real
  Como desarrollador de software
  Quiero ver el consumo de CPU, memoria, red y disco de mis contenedores en tiempo real
  Para detectar cuellos de botella, fugas de memoria o consumos anómalos en mi entorno local

  Antecedentes:
    Dado que el servidor backend de DockPilot está en ejecución
    Y la conexión al daemon Docker está establecida

  Escenario: Lectura de instantánea de métricas mediante REST
    Dado que existe un contenedor en ejecución con identificador "web-app"
    Cuando el usuario solicita "GET /api/v1/containers/web-app/stats"
    Entonces el sistema responde con código HTTP 200
    Y devuelve los campos "cpu_percent", "memory_usage", "memory_limit" y "memory_percent"
    Y "cpu_percent" y "memory_percent" son números válidos mayores o iguales a 0

  Escenario: Streaming de estadísticas mediante WebSocket
    Dado que existe un contenedor en ejecución con identificador "database"
    Cuando el cliente frontend abre una conexión WebSocket a "/ws/containers/database/stats"
    Entonces la conexión es aceptada
    Y el servidor emite periódicamente mensajes JSON con el schema "ContainerStats"
    Y al cerrar la conexión desde el cliente, los recursos del servidor son liberados limpiamente

  Escenario: Solicitud de métricas para un contenedor inexistente
    Dado que no existe ningún contenedor con identificador "fantasma-99"
    Cuando el usuario solicita "GET /api/v1/containers/fantasma-99/stats"
    Entonces el sistema responde con código HTTP 404
    Y cuando un cliente intenta conectar por WebSocket a "/ws/containers/fantasma-99/stats"
    Entonces el WebSocket es cerrado con código 4404

  Escenario: Visualización en el panel frontend
    Dado que el usuario visualiza la tabla de contenedores
    Cuando hace click en el botón de estadísticas de un contenedor en ejecución
    Entonces se abre el modal "StatsModal"
    Y se visualizan las tarjetas de CPU y Memoria con barras de progreso animadas
    Y se visualiza el tráfico de Red (Rx/Tx) y operaciones de Disco (Read/Write) formateadas en unidades legibles (KB, MB, GB)
    Y un gráfico sparkline refleja la evolución de los últimos 20 puntos temporales
```

---

## 6. Plan de Pruebas Automatizadas

### Backend (`pytest` + `pytest-asyncio` + `httpx`)
- `tests/test_stats.py`:
  - `test_calculate_stats_helper_accurate`: Prueba unitaria de las fórmulas de CPU, memoria, red y disco con datos mock conocidos de Docker.
  - `test_container_stats_rest_success`: Verifica `GET /api/v1/containers/{id}/stats` devolviendo 200 con `ContainerStats`.
  - `test_container_stats_rest_not_found`: Verifica 404 ante contenedor inexistente.
  - `test_container_stats_ws_stream`: Conexión WebSocket mediante `TestClient`, recepción de paquetes de estadísticas y cierre ordenado.
  - `test_container_stats_ws_not_found`: Verifica cierre con código 4404 ante contenedor inexistente.

### Frontend (`vitest` + `@testing-library/react`)
- `tests/hooks/useDockerStats.test.ts`:
  - Conexión inicial, recepción progresiva de mensajes y actualización de `currentStats`.
  - Construcción del buffer de historial (`history`) limitado a los últimos 20 puntos.
  - Manejo de reconexión y error en desconexión.
- `tests/components/StatsModal.test.tsx`:
  - Renderizado correcto de valores en porcentajes y formateadores de bytes (`formatBytes`).
  - Renderizado de barras de progreso y colores de alerta según umbrales (>70% amarillo, >90% rojo).
  - Cierre del modal con botón de escape o click en botón de cierre.

---

## 7. Plan de Tareas (Tasks)

- [x] **Fase 1: Contratos y Schemas**
  - [x] Crear `backend/app/schemas/stats.py` con el modelo Pydantic `ContainerStats`
  - [x] Crear `frontend/src/types/stats.ts` con interfaces TypeScript `ContainerStats` y `StatsHistoryPoint`
- [x] **Fase 2: Tests Primero en Backend (TDD)**
  - [x] Añadir fixtures de stats en `backend/tests/conftest.py`
  - [x] Crear `backend/tests/test_stats.py` cubriendo cálculo, endpoint REST y WebSocket
- [x] **Fase 3: Implementación Backend**
  - [x] Implementar helper de cálculo de métricas en `backend/app/services/stats_service.py` (o módulo de servicio correspondiente)
  - [x] Implementar endpoint REST `GET /api/v1/containers/{id}/stats` en `backend/app/api/v1/containers.py`
  - [x] Implementar endpoint WebSocket `/ws/containers/{id}/stats` en `backend/app/api/v1/ws.py`
  - [x] Ejecutar `pytest -v` y validar aprobación al 100%
- [x] **Fase 4: Tests Primero en Frontend**
  - [x] Crear `frontend/tests/hooks/useDockerStats.test.ts`
  - [x] Crear `frontend/tests/components/StatsModal.test.tsx`
- [x] **Fase 5: Implementación Frontend**
  - [x] Añadir método `getContainerStats` en `frontend/src/services/dockerApi.ts`
  - [x] Implementar hook `frontend/src/hooks/useDockerStats.ts` con gestión de WebSocket y buffer circular de historial
  - [x] Crear componente `frontend/src/components/stats/StatsSparkline.tsx` para visualización gráfica ligera en SVG
  - [x] Crear componente `frontend/src/components/stats/StatsModal.tsx` con cards de métricas, barras reactivas y formateadores de bytes
  - [x] Integrar botón de estadísticas en `frontend/src/components/containers/ActionButtons.tsx` / `ContainersTable.tsx` y conectar con `App.tsx`
- [x] **Fase 6: Verificación y Quality Gates**
  - [x] Ejecutar y aprobar suite backend (`PYTHONPATH=. pytest -v`)
  - [x] Ejecutar y aprobar suite frontend (`pnpm run test`)
  - [x] Ejecutar `pnpm run lint` (Oxlint) y `pnpm run build` (`tsc -b && vite build`)
  - [x] Marcar todas las tareas como completadas (`[x]`) en este documento
