# AGENT.MD - DockPilot

Guía de desarrollo, arquitectura, especificaciones y directrices para agentes y desarrolladores que trabajen en **DockPilot**, un gestor web local para Docker bajo una metodología **SDD (Spec-Driven Development)**.

---

## 1. Visión General del Proyecto

**DockPilot** es un panel de control web moderno, reactivo y de alto rendimiento diseñado para gestionar y monitorizar el entorno Docker local directamente desde el navegador.

- **Objetivo Principal**: Proporcionar una alternativa ligera, rápida y estética a herramientas como Portainer o Docker Desktop, orientada a desarrolladores en Linux.
- **Alcance**: Gestión completa de contenedores, monitorización de métricas en vivo (CPU, RAM, Red), gestión de imágenes y terminal interactivo embebido (`docker exec`).
- **Entorno Objetivo**: Sistema Linux local conectándose directamente al socket UNIX de Docker (`/var/run/docker.sock`).
- **Seguridad**: Ejecución exclusiva en `127.0.0.1` (localhost) sin capa de autenticación, enfocado en simplicidad y velocidad para uso personal.
- **Metodología de Desarrollo**: **Spec-Driven Development (SDD)**. Cada incremento de funcionalidad debe nacer de un documento de especificación formal redactado y aprobado antes de escribir código.

---

## 2. Metodología: Spec-Driven Development (SDD)

Todo desarrollo en DockPilot sigue rigurosamente el ciclo SDD de 5 etapas:

```text
[1. Spec (Gherkin)] ──► [2. Aprobación] ──► [3. Schemas & Tests] ──► [4. Implementación & Tasks] ──► [5. Verificación]
 (specs/*.md en ES)      (Feedback Usuario)     (Pydantic/TS + Pytest)    (Marcar [x] en el spec)      (Tests & Quality Gates)
```

### Reglas Obligatorias para las Especificaciones (`specs/`):

1. **Estructura Gherkin en Español**:
   - Todo criterio de aceptación debe escribirse en formato estándar Gherkin en español (`# language: es`).
   - Palabras clave requeridas: `Característica:`, `Antecedentes:`, `Escenario:`, `Dado`, `Cuando`, `Entonces`, `Y`, `Pero`.
2. **Desglose de Tareas con Checkboxes (`[ ]`)**:
   - Cada archivo de especificación debe concluir con una sección de **Plan de Tareas (Tasks)** dividida por fases.
   - Formato estricto: listas con casillas `- [ ]` que deben ir marcándose progresivamente como `- [x]` conforme se completen durante la ejecución.

---

## 3. Stack Tecnológico

### Frontend
- **Framework**: React 19 con TypeScript.
- **Build Tool**: Vite 8+.
- **Estilos**: Tailwind CSS v4 (`@tailwindcss/vite`).
- **Iconografía**: `lucide-react`.
- **Terminal Web**: `@xterm/xterm` y `@xterm/addon-fit`.
- **Linter & Typecheck**: Oxlint y `tsc -b`.
- **Testing**: Vitest + `@testing-library/react` + `jsdom`.

### Backend
- **Framework**: FastAPI (Python 3.12+).
- **Servidor ASGI**: Uvicorn con soporte `uvloop`.
- **Integración Docker**: `aiodocker` (comunicación asíncrona nativa sobre `/var/run/docker.sock`).
- **Validación de Datos**: Pydantic v2 / Pydantic Settings.
- **Tiempo Real**: WebSockets nativos de FastAPI.
- **Testing**: `pytest`, `pytest-asyncio`, `httpx` (FastAPI `AsyncClient`), `unittest.mock`.

---

## 4. Estructura de Directorios

```text
dockpilot/
├── agent.md                    # Especificaciones maestras y reglas SDD
├── specs/                      # Especificaciones funcionales por módulo (SDD)
│   ├── template.md             # Plantilla estándar con Gherkin y tasks [ ]
│   ├── 01-containers.md        # Spec: Ciclo de vida y gestión de contenedores
│   ├── 02-realtime-logs.md     # Spec: Streaming de logs con WebSockets
│   ├── 03-realtime-stats.md    # Spec: Métricas en vivo (CPU, RAM, Red)
│   ├── 04-terminal.md          # Spec: Terminal interactivo con xterm.js
│   └── 05-images.md            # Spec: Gestión y pull de imágenes
├── backend/
│   ├── app/
│   │   ├── api/
│   │   │   ├── v1/
│   │   │   │   ├── containers.py
│   │   │   │   ├── images.py
│   │   │   │   ├── system.py
│   │   │   │   └── ws.py
│   │   │   └── router.py
│   │   ├── core/
│   │   │   ├── config.py
│   │   │   └── docker.py
│   │   ├── schemas/
│   │   │   ├── container.py
│   │   │   ├── image.py
│   │   │   └── stats.py
│   │   ├── services/
│   │   │   ├── container_service.py
│   │   │   ├── image_service.py
│   │   │   └── terminal_service.py
│   │   └── main.py
│   ├── tests/
│   │   ├── conftest.py
│   │   ├── test_containers.py
│   │   ├── test_images.py
│   │   ├── test_system.py
│   │   └── test_ws.py
│   ├── requirements.txt
│   └── .venv/
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── layout/
│   │   │   ├── ui/
│   │   │   ├── containers/
│   │   │   ├── terminal/
│   │   │   ├── logs/
│   │   │   ├── stats/
│   │   │   └── images/
│   │   ├── hooks/
│   │   ├── services/
│   │   ├── types/
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   └── index.css
│   ├── tests/
│   │   ├── setup.ts
│   │   ├── components/
│   │   └── hooks/
│   ├── package.json
│   ├── vite.config.ts
│   └── vitest.config.ts
```

---

## 5. Estrategia de Testing y Verificación

### 5.1. Backend Testing (`pytest` + `pytest-asyncio` + `httpx`)
- **Mocking de `aiodocker`**: Fixtures en `conftest.py` para tests aislados y reproducibles sin requerir el daemon real.
- **Fidelidad Gherkin**: Cada escenario Gherkin de la especificación debe reflejarse como al menos una función de prueba (`test_escenario_...`).

### 5.2. Frontend Testing (`vitest` + `@testing-library/react`)
- **Pruebas de Componentes**: Renderizado según datos de la API y manejo de eventos de usuario (clicks, confirmaciones).
- **Pruebas de Hooks**: Flujo de estados (loading, data, error) y gestión de ciclo de vida de WebSockets.

---

## 6. Comandos de Trabajo y Testing

### Backend
```bash
cd backend
source .venv/bin/activate
pytest -v                                        # Ejecutar suite de pruebas
uvicorn app.main:app --reload --host 127.0.0.1  # Iniciar servidor
```

### Frontend
```bash
cd frontend
pnpm run test     # Ejecutar tests con Vitest
pnpm run lint     # Oxlint
pnpm run build    # Typecheck (tsc -b) y build con Vite
pnpm dev          # Iniciar frontend en desarrollo
```

---

## 7. Directrices Estrictas para Agentes de IA

1. **Flujo SDD Inviolable**:
   - **Prohibido** generar código de backend o frontend sin un archivo de especificación previo en `specs/` validado y aprobado por el usuario.
2. **Formato Gherkin en Español**:
   - No redactar criterios de aceptación informales; siempre usar la sintaxis Gherkin en español (`Característica`, `Antecedentes`, `Escenario`, `Dado`, `Cuando`, `Entonces`, `Y`, `Pero`).
3. **Mantenimiento del Checklist de Tasks**:
   - Cada vez que se finalice un paso de implementación, el agente debe actualizar la especificación correspondiente marcando la casilla de `- [ ]` a `- [x]`.
4. **Sin código no solicitado**:
   - Nunca escribir código antes de que el usuario haya aceptado explícitamente el spec del paso actual.
5. **Fidelidad al Contrato**:
   - Los schemas de Pydantic y las interfaces de TypeScript deben coincidir exactamente campo por campo.
6. **Validación Continua**:
   - No considerar completada una tarea hasta que todos los tests del spec pasen exitosamente (`pytest` y `vitest`).
