# SPEC-02: Streaming de Logs en Tiempo Real con WebSockets

## 1. Contexto y Objetivos
- **Problema**: Inspeccionar la salida estándar (`stdout`) y de error (`stderr`) de los contenedores locales requiere ejecutar comandos manuales (`docker logs -f`). Los desarrolladores necesitan una visualización continua, fluida y reactiva en el navegador que les permita depurar sus servicios sin saturar la red ni la memoria.
- **Objetivo**: Proveer una conexión persistente vía WebSockets y un endpoint REST complementario para transmitir logs de contenedores en tiempo real con soporte para búsqueda, auto-scroll inteligente, selección de histórico (`tail`) y formateo de timestamps.
- **Alcance**:
  - Incluye: Canal WebSocket bidireccional (`/ws/containers/{id}/logs`), endpoint REST de instantánea (`GET /api/v1/containers/{id}/logs`), visor de logs interactivo en React (`LogsViewer`), buffer circular en memoria y control de auto-scroll.
  - No incluye (en esta spec): Métricas de consumo de CPU/RAM (SPEC-03), terminal interactivo `xterm.js` (SPEC-04).

---

## 2. Contrato de Datos (Schemas & Types)

### Backend (Pydantic v2) - `app/schemas/log.py`
```python
from typing import Optional, List
from pydantic import BaseModel, Field

class LogEntry(BaseModel):
    timestamp: Optional[str] = None
    stream: str = "stdout"  # "stdout" | "stderr" | "system"
    message: str

class LogSnapshotResponse(BaseModel):
    id: str
    total_lines: int
    lines: List[LogEntry] = Field(default_factory=list)
```

### Frontend (TypeScript) - `src/types/log.ts`
```typescript
export type LogStreamType = 'stdout' | 'stderr' | 'system';

export interface LogEntry {
  timestamp?: string;
  stream: LogStreamType;
  message: string;
}

export interface LogSnapshotResponse {
  id: string;
  total_lines: number;
  lines: LogEntry[];
}
```

---

## 3. Contrato de API y WebSockets

### 3.1. Endpoint REST (Instantánea / Fallback)
| Método | Endpoint | Query Params | Código Respuesta | Descripción |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/containers/{id}/logs` | `tail` (int/str, default=100), `timestamps` (bool, default=true) | `200 OK`: `LogSnapshotResponse` | Obtiene las últimas N líneas de log de un contenedor |

### 3.2. Canal WebSocket
- **Ruta**: `/ws/containers/{id}/logs`
- **Query Params**:
  - `tail`: cantidad de líneas previas a enviar tras conectar (ej. `100`, `"all"`). Default: `100`.
  - `follow`: mantener el stream abierto escuchando nuevos eventos. Default: `true`.
  - `timestamps`: incluir marcas de tiempo en las líneas emitidas. Default: `true`.

#### Formato de Mensajes Salientes (Servidor ➔ Cliente):
Cada evento emitido por el backend es un JSON serializado de tipo `LogEntry`:
```json
{
  "timestamp": "2026-09-25T17:20:00.123456Z",
  "stream": "stdout",
  "message": "Server started on port 8080"
}
```
Mensajes del sistema (para informar el estado del stream):
```json
{
  "timestamp": null,
  "stream": "system",
  "message": "--- Conectado al stream de logs de [web-nginx] ---"
}
```

#### Eventos de Cierre y Desconexión:
- **Código 4404**: Contenedor no encontrado.
- **Código 1000**: Cierre normal cuando el stream finaliza o el cliente se desconecta.
- **Cancelación de Corrutina**: Al producirse un `WebSocketDisconnect`, el servidor debe cancelar inmediatamente la tarea asíncrona de lectura del daemon Docker para no dejar descriptores de archivo abiertos.

---

## 4. Criterios de Aceptación (Gherkin en Español)

```gherkin
# language: es
Característica: Transmisión y visualización de logs en vivo mediante WebSockets
  Como desarrollador de aplicaciones en contenedores
  Quiero ver los logs generados por mis contenedores en tiempo real desde la web
  Para diagnosticar errores y monitorizar el comportamiento de mis servicios sin salir del navegador

  Antecedentes:
    Dado que el servidor backend de DockPilot está en ejecución
    Y la conexión al daemon Docker está establecida

  Escenario: Conexión WebSocket y recepción del histórico inicial
    Dado que existe un contenedor con ID "c123" que posee logs previos
    Cuando el cliente web abre una conexión WebSocket a "/ws/containers/c123/logs?tail=50"
    Entonces el servidor acepta la conexión
    Y envía un primer mensaje del sistema "stream: system" indicando conexión exitosa
    Y transmite las últimas líneas registradas con stream "stdout" o "stderr"

  Escenario: Transmisión continua en tiempo real (follow)
    Dado que la conexión WebSocket está abierta con "follow=true"
    Cuando el contenedor genera una nueva línea en su salida estándar
    Entonces el servidor transmite de forma asíncrona e inmediata la nueva línea en formato JSON
    Y el cliente añade la línea al visor sin necesidad de refrescar la página

  Escenario: Identificación visual de mensajes de error (stderr)
    Dado que el contenedor emite un mensaje a través del descriptor "stderr"
    Cuando el servidor procesa el byte stream
    Entonces envía el objeto con "stream: stderr"
    Y el visor web resalta el texto en color diferenciado (rojo/ámbar)

  Escenario: Cierre limpio al detenerse el contenedor
    Dado que el cliente está escuchando logs de un contenedor activo
    Cuando el contenedor finaliza su ejecución y cierra sus streams
    Entonces el servidor envía un mensaje del sistema indicando la finalización
    Y cierra la conexión WebSocket con código normal 1000

  Escenario: Intento de conexión a contenedor inexistente
    Dado que no existe ningún contenedor con identificador "id-fantasma"
    Cuando un cliente intenta conectar a "/ws/containers/id-fantasma/logs"
    Entonces el servidor rechaza la conexión o la cierra de inmediato con código 4404
    Y no se inician tareas de escucha en segundo plano

  Escenario: Desconexión limpia del usuario
    Dado que el cliente cierra la pestaña del navegador o cambia de vista
    Cuando se detecta el evento de desconexión del WebSocket
    Entonces el backend cancela la tarea de iteración asíncrona de Docker
    Y libera inmediatamente los recursos asociados sin registrar excepciones no controladas
```

---

## 5. Plan de Pruebas Automatizadas

### Backend (`pytest` + `pytest-asyncio` + `httpx`)
- `tests/test_ws_logs.py`:
  - `test_ws_logs_snapshot_rest`: Petición `GET /api/v1/containers/{id}/logs` devuelve snapshot estructurado.
  - `test_ws_logs_connection_and_stream`: Conexión vía WebSocket mockeado, recepción de logs iniciales y en streaming.
  - `test_ws_logs_not_found`: Cierre con código 4404 cuando el contenedor no existe.
  - `test_ws_logs_client_disconnect_cleanup`: Comprobación de que la tarea asíncrona se cancela al desconectarse el cliente sin dejar fugas.

### Frontend (`vitest` + `@testing-library/react`)
- `tests/components/LogsViewer.test.tsx`:
  - Renderizado de líneas de log estructuradas (timestamp, stream badge, contenido).
  - Comportamiento del auto-scroll y botón de pausar/reanudar scroll.
  - Funcionalidad del filtro de búsqueda (ocultar líneas que no coinciden con el término).
  - Botón de limpieza de buffer (vaciar logs en pantalla).
- `tests/hooks/useDockerLogs.test.ts`:
  - Conexión al WebSocket mock, acumulación de mensajes en buffer con límite máximo (ej. 2000 líneas).
  - Cierre y reconexión limpia al cambiar de contenedor.

---

## 6. Plan de Tareas (Tasks)

- [x] **Fase 1: Contratos y Modelos**
  - [x] Crear `backend/app/schemas/log.py` con los modelos Pydantic `LogEntry` y `LogSnapshotResponse`
  - [x] Crear `frontend/src/types/log.ts` con los tipos TypeScript correspondientes
- [x] **Fase 2: Tests Primero en Backend (TDD)**
  - [x] Crear `backend/tests/test_ws_logs.py` implementando los escenarios Gherkin para REST y WebSocket
- [x] **Fase 3: Implementación Backend**
  - [x] Implementar método de lectura de logs en `backend/app/services/container_service.py`
  - [x] Implementar endpoint REST `GET /api/v1/containers/{id}/logs` en `backend/app/api/v1/containers.py`
  - [x] Implementar endpoint WebSocket `/ws/containers/{id}/logs` en `backend/app/api/v1/ws.py`
  - [x] Registrar router de WebSockets en `backend/app/main.py` y verificar `pytest -v` (todos los tests en verde)
- [x] **Fase 4: Tests Primero en Frontend**
  - [x] Escribir tests para el componente `LogsViewer` en `frontend/tests/components/LogsViewer.test.tsx`
  - [x] Escribir tests para el hook `useDockerLogs` en `frontend/tests/hooks/useDockerLogs.test.ts`
- [x] **Fase 5: Implementación Frontend**
  - [x] Implementar hook `frontend/src/hooks/useDockerLogs.ts` con gestión de WebSocket y buffer circular
  - [x] Implementar componente `frontend/src/components/logs/LogsViewer.tsx` con búsqueda, auto-scroll y copia
  - [x] Integrar botón de "Ver Logs" en la tabla y modal en `frontend/src/App.tsx`
- [x] **Fase 6: Verificación y Quality Gates**
  - [x] Ejecutar y validar `pytest -v` en backend (16/16 passed)
  - [x] Ejecutar y validar `pnpm run test` en frontend (14/14 passed)
  - [x] Ejecutar `pnpm run lint` y `pnpm run build` (0 warnings, 0 errors)
  - [x] Marcar todas las tareas completadas en este documento
