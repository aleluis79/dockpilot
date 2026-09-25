# SPEC-XX: [Nombre de la Funcionalidad]

## 1. Contexto y Objetivos
- **Problema**: Descripción concisa de la necesidad o funcionalidad requerida.
- **Objetivo**: Qué comportamiento esperado debe tener el sistema tras completarse.
- **Alcance**: Delimitación clara de lo que incluye y lo que NO incluye esta especificación.

---

## 2. Contrato de Datos (Schemas & Types)

### Backend (Pydantic v2)
```python
# app/schemas/...py
from pydantic import BaseModel

class ExampleSchema(BaseModel):
    id: str
    name: str
    status: str
```

### Frontend (TypeScript)
```typescript
// src/types/...ts
export interface ExampleModel {
  id: string;
  name: string;
  status: string;
}
```

---

## 3. Contrato de API

### Endpoints REST
| Método | Endpoint | Descripción | Body | Respuesta Exitosa | Errores Posibles |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/...` | Listado | N/A | `200 OK` (Array) | `500`, `503` |
| `POST` | `/api/v1/.../{id}/action` | Ejecutar acción | JSON opcional | `200 OK` | `400`, `404`, `409` |

### Canales WebSocket (si aplica)
- **URL**: `/ws/...`
- **Mensaje Entrante**: `{ "action": "resize", "cols": 80, "rows": 24 }`
- **Mensaje Saliente**: `{ "type": "stdout", "data": "..." }`
- **Cierre / Desconexión**: Código de estado y limpieza de recursos.

---

## 4. Criterios de Aceptación (Gherkin en Español)

```gherkin
# language: es
Característica: [Nombre de la funcionalidad]
  Como [rol del usuario]
  Quiero [acción o funcionalidad que se desea realizar]
  Para [beneficio o valor que aporta al usuario]

  Antecedentes:
    Dado que el backend de DockPilot está en ejecución y conectado al socket de Docker

  Escenario: [Nombre del escenario exitoso]
    Dado que existe un recurso con estado "..."
    Cuando el usuario envía una petición para "..."
    Entonces el sistema responde con código 200
    Y el estado del recurso se actualiza a "..."

  Escenario: [Nombre del escenario de error o recurso no encontrado]
    Dado que no existe ningún recurso con identificador "id-inexistente"
    Cuando el usuario solicita ejecutar una acción sobre "id-inexistente"
    Entonces el sistema responde con código 404
    Y el cuerpo de la respuesta contiene un mensaje de error descriptivo
```

---

## 5. Plan de Pruebas Automatizadas

### Backend (`pytest`)
- `tests/test_...py`:
  - `test_action_success`: Verifica respuesta 200 y mock llamado correctamente.
  - `test_action_not_found`: Verifica 404 al no encontrar la entidad.
  - `test_action_docker_error`: Verifica propagación controlada del error de Docker.

### Frontend (`vitest` + `@testing-library/react`)
- `tests/...test.tsx`:
  - Renderizado de componentes con datos mock.
  - Simulación de interacción de usuario (click en botón de acción).
  - Verificación del estado visual y feedback de error.

---

## 6. Plan de Tareas (Tasks)

- [ ] **Fase 1: Contratos y Modelos**
  - [ ] Definir schemas Pydantic en `backend/app/schemas/`
  - [ ] Definir interfaces TypeScript en `frontend/src/types/`
- [ ] **Fase 2: Tests Primero (TDD)**
  - [ ] Escribir tests de API y servicios en `backend/tests/`
  - [ ] Escribir tests unitarios de componentes en `frontend/tests/`
- [ ] **Fase 3: Implementación Backend**
  - [ ] Implementar servicio de conexión con Docker en `backend/app/services/`
  - [ ] Implementar endpoints en `backend/app/api/v1/`
- [ ] **Fase 4: Implementación Frontend**
  - [ ] Implementar cliente HTTP y hooks en `frontend/src/services/` y `frontend/src/hooks/`
  - [ ] Construir componentes visuales con Tailwind en `frontend/src/components/`
- [ ] **Fase 5: Verificación y Quality Gates**
  - [ ] Ejecutar y aprobar suite backend (`pytest -v`)
  - [ ] Ejecutar y aprobar suite frontend (`pnpm run test`)
  - [ ] Chequeos de tipo y linter (`tsc -b`, `pnpm run lint`)
