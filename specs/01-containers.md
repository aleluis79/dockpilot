# SPEC-01: Gestión y Ciclo de Vida de Contenedores

## 1. Contexto y Objetivos
- **Problema**: Los desarrolladores necesitan una forma ágil de consultar el estado de sus contenedores locales y ejecutar acciones comunes (arrancar, detener, reiniciar, pausar y eliminar) sin recurrir a la CLI de Docker o herramientas pesadas.
- **Objetivo**: Proporcionar una API REST robusta y una interfaz gráfica responsiva para listar, filtrar, inspeccionar y controlar el ciclo de vida de contenedores locales.
- **Alcance**:
  - Incluye: Listado de contenedores (todos o filtrados por estado), inspección básica, y acciones de control (`start`, `stop`, `restart`, `pause`, `unpause`, `remove`).
  - No incluye (en esta spec): Streaming de logs en vivo (SPEC-02), métricas de CPU/RAM (SPEC-03), terminal interactivo (SPEC-04).

---

## 2. Contrato de Datos (Schemas & Types)

### Backend (Pydantic v2) - `app/schemas/container.py`
```python
from typing import List, Optional, Dict
from pydantic import BaseModel, Field

class PortMapping(BaseModel):
    ip: Optional[str] = "0.0.0.0"
    private_port: int
    public_port: Optional[int] = None
    type: str = "tcp"

class ContainerSummary(BaseModel):
    id: str
    name: str
    image: str
    status: str  # "running", "exited", "paused", "restarting", "created"
    state: str   # Estado detallado de Docker (ej. "running", "exited")
    created: int # Epoch timestamp
    ports: List[PortMapping] = Field(default_factory=list)

class ContainerDetail(ContainerSummary):
    command: Optional[str] = None
    env: List[str] = Field(default_factory=list)
    labels: Dict[str, str] = Field(default_factory=dict)
    mounts: List[Dict[str, str]] = Field(default_factory=list)
    networks: List[str] = Field(default_factory=list)

class ContainerActionResponse(BaseModel):
    id: str
    action: str
    success: bool
    message: str
```

### Frontend (TypeScript) - `src/types/docker.ts`
```typescript
export interface PortMapping {
  ip?: string;
  private_port: number;
  public_port?: number;
  type: string;
}

export type ContainerState = 'running' | 'exited' | 'paused' | 'restarting' | 'created' | 'dead';

export interface ContainerSummary {
  id: string;
  name: string;
  image: string;
  status: ContainerState | string;
  state: string;
  created: number;
  ports: PortMapping[];
}

export interface ContainerDetail extends ContainerSummary {
  command?: string;
  env: string[];
  labels: Record<string, string>;
  mounts: Array<Record<string, string>>;
  networks: string[];
}

export interface ContainerActionResponse {
  id: string;
  action: string;
  success: bool;
  message: string;
}
```

---

## 3. Contrato de API REST

| Método | Endpoint | Query Params / Body | Código Respuesta | Descripción |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/containers` | `all` (bool, default=true), `status` (opcional: running, exited, etc.) | `200 OK`: `List[ContainerSummary]` | Lista todos los contenedores con filtros |
| `GET` | `/api/v1/containers/{id}` | Ninguno | `200 OK`: `ContainerDetail` | Inspecciona un contenedor por ID o nombre |
| `POST` | `/api/v1/containers/{id}/start` | Ninguno | `200 OK`: `ContainerActionResponse` | Inicia un contenedor detenido |
| `POST` | `/api/v1/containers/{id}/stop` | `timeout` (int, default=10) | `200 OK`: `ContainerActionResponse` | Detiene un contenedor en ejecución |
| `POST` | `/api/v1/containers/{id}/restart` | `timeout` (int, default=10) | `200 OK`: `ContainerActionResponse` | Reinicia un contenedor |
| `POST` | `/api/v1/containers/{id}/pause` | Ninguno | `200 OK`: `ContainerActionResponse` | Pausa los procesos del contenedor |
| `POST` | `/api/v1/containers/{id}/unpause` | Ninguno | `200 OK`: `ContainerActionResponse` | Reanuda un contenedor pausado |
| `DELETE` | `/api/v1/containers/{id}` | `force` (bool, default=false), `v` (bool, default=false) | `200 OK`: `ContainerActionResponse` | Elimina un contenedor |

### Respuestas de Error Comunes
- `404 Not Found`: Cuando el `id` o nombre del contenedor no existe en Docker.
- `409 Conflict`: Cuando la acción no es válida para el estado actual (ej. pausar un contenedor detenido).
- `503 Service Unavailable`: Si el socket `/var/run/docker.sock` no está disponible o el daemon está caído.

---

## 4. Criterios de Aceptación (Gherkin en Español)

```gherkin
# language: es
Característica: Gestión y control del ciclo de vida de contenedores locales
  Como desarrollador de software
  Quiero visualizar y controlar mis contenedores Docker desde una interfaz web
  Para operar mi entorno de desarrollo local sin memorizar comandos de terminal

  Antecedentes:
    Dado que el servicio DockPilot está en ejecución
    Y el cliente aiodocker tiene comunicación activa con "/var/run/docker.sock"

  Escenario: Listado general de contenedores
    Dado que existen contenedores registrados en Docker
    Cuando el usuario solicita el listado de contenedores mediante "GET /api/v1/containers"
    Entonces el sistema responde con código HTTP 200
    Y devuelve una lista con los campos "id", "name", "image", "status" y "ports" de cada contenedor

  Escenario: Filtrado de contenedores por estado
    Dado que existen contenedores con estado "running" y contenedores con estado "exited"
    Cuando el usuario solicita "GET /api/v1/containers?status=running"
    Entonces el sistema responde con código HTTP 200
    Y todos los elementos devueltos tienen "status" igual a "running"

  Escenario: Detener un contenedor en ejecución exitosamente
    Dado que existe un contenedor con ID "c123" y estado "running"
    Cuando el usuario envía una petición "POST /api/v1/containers/c123/stop"
    Entonces el sistema responde con código HTTP 200
    Y el cuerpo de respuesta indica "success: true" y "action: stop"
    Y el estado del contenedor pasa a ser "exited"

  Escenario: Iniciar un contenedor detenido exitosamente
    Dado que existe un contenedor con ID "c456" y estado "exited"
    Cuando el usuario envía una petición "POST /api/v1/containers/c456/start"
    Entonces el sistema responde con código HTTP 200
    Y el cuerpo de respuesta indica "success: true" y "action: start"
    Y el estado del contenedor pasa a ser "running"

  Escenario: Reiniciar un contenedor
    Dado que existe un contenedor con ID "c789"
    Cuando el usuario envía una petición "POST /api/v1/containers/c789/restart"
    Entonces el sistema responde con código HTTP 200
    Y el cuerpo de respuesta indica "success: true" y "action: restart"

  Escenario: Eliminar un contenedor detenido
    Dado que existe un contenedor con ID "c999" en estado "exited"
    Cuando el usuario envía una petición "DELETE /api/v1/containers/c999"
    Entonces el sistema responde con código HTTP 200
    Y el contenedor ya no aparece en el listado general

  Escenario: Intentar eliminar un contenedor en ejecución sin forzar
    Dado que existe un contenedor con ID "c888" en estado "running"
    Cuando el usuario envía una petición "DELETE /api/v1/containers/c888" con "force=false"
    Entonces el sistema responde con código HTTP 409
    Y devuelve un mensaje explicativo solicitando detener el contenedor o usar borrado forzado

  Escenario: Operar sobre un contenedor que no existe
    Dado que no existe ningún contenedor con ID "inexistente-000"
    Cuando el usuario solicita cualquier acción sobre "inexistente-000"
    Entonces el sistema responde con código HTTP 404
    Y el cuerpo de respuesta indica "Contenedor inexistente-000 no encontrado"

  Escenario: Error de comunicación con el daemon Docker
    Dado que el servicio Docker daemon no responde o el socket está desconectado
    Cuando el usuario realiza una petición a cualquier endpoint de contenedores
    Entonces el sistema responde con código HTTP 503
    Y devuelve un mensaje indicando que no se pudo conectar con el socket Docker
```

---

## 5. Plan de Pruebas Automatizadas

### Backend (`pytest` + `pytest-asyncio` + `httpx`)
- `tests/test_containers.py`:
  - `test_list_containers_empty`: Respuesta 200 y lista vacía cuando no hay contenedores.
  - `test_list_containers_populated`: Serialización y respuesta 200 con contenedores mockeados.
  - `test_filter_containers_by_status`: Filtrado correcto por query parameter `status`.
  - `test_start_container_success`: Llamada a `docker.containers.get().start()` y respuesta 200.
  - `test_stop_container_success`: Llamada a `stop()` y respuesta 200.
  - `test_restart_container_success`: Llamada a `restart()` y respuesta 200.
  - `test_remove_container_success`: Llamada a `delete()` y respuesta 200.
  - `test_container_not_found`: Respuesta 404 ante `DockerError(status=404)`.
  - `test_container_conflict_error`: Respuesta 409 ante `DockerError(status=409)`.
  - `test_docker_daemon_unavailable`: Respuesta 503 ante fallos de conexión al socket.

### Frontend (`vitest` + `@testing-library/react`)
- `tests/components/ContainersTable.test.tsx`:
  - Renderiza lista de contenedores con sus badges de estado en el color adecuado (verde para running, gris para exited).
  - Muestra puertos expuestos mapeados a enlaces `localhost`.
  - Dispara la función `onStop` al hacer click en el botón de detener.
  - Dispara el modal de confirmación antes de llamar a `onDelete`.
- `tests/hooks/useContainers.test.ts`:
  - Verifica el ciclo de vida del hook: `loading -> data -> refetch`.
  - Maneja y expone errores de conexión con el backend.

---

## 6. Plan de Tareas (Tasks)

- [x] **Fase 1: Preparación del Entorno y Dependencias**
  - [x] Instalar dependencias en backend (`aiodocker`, `pytest`, `pytest-asyncio`, `httpx`)
  - [x] Instalar dependencias en frontend (`lucide-react`, `vitest`, `@testing-library/react`, `jsdom`)
  - [x] Configurar proxy de Vite en `frontend/vite.config.ts` hacia `http://127.0.0.1:8181` (y `ws://127.0.0.1:8181` para `/ws`)
- [x] **Fase 2: Contratos de Datos (Schemas & Types)**
  - [x] Crear `backend/app/schemas/container.py` con los modelos Pydantic
  - [x] Crear `frontend/src/types/docker.ts` con las interfaces TypeScript correspondientes
- [x] **Fase 3: Tests Primero en Backend (TDD)**
  - [x] Crear `backend/tests/conftest.py` con fixtures de `AsyncClient` y mocks de `aiodocker`
  - [x] Crear `backend/tests/test_containers.py` implementando los escenarios Gherkin
- [x] **Fase 4: Implementación Backend**
  - [x] Crear cliente Docker y lifespan en `backend/app/core/docker.py`
  - [x] Implementar `backend/app/services/container_service.py` con llamadas a `aiodocker`
  - [x] Implementar router de contenedores en `backend/app/api/v1/containers.py`
  - [x] Registrar router en `backend/app/main.py` y verificar `pytest -v` (todos los tests en verde)
- [x] **Fase 5: Tests Primero en Frontend**
  - [x] Configurar entorno Vitest en `frontend/vitest.config.ts` y `frontend/tests/setup.ts`
  - [x] Escribir tests unitarios para tabla de contenedores y badges de estado
- [x] **Fase 6: Implementación Frontend**
  - [x] Crear cliente de API en `frontend/src/services/dockerApi.ts`
  - [x] Crear hook `frontend/src/hooks/useContainers.ts`
  - [x] Crear componentes UI: `StatusBadge`, `ActionButtons`, `ContainersTable`, `ContainerDetailModal`
  - [x] Integrar vista principal en `frontend/src/App.tsx`
- [x] **Fase 7: Verificación y Quality Gates**
  - [x] Ejecutar y validar `pytest -v` en backend
  - [x] Ejecutar y validar `pnpm run test` en frontend
  - [x] Ejecutar linter y typecheck (`pnpm run lint` y `tsc -b`)
  - [x] Marcar todas las tareas completadas en este documento
