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

### Sistema de Temas (contrato transversal)
- **Tokens semánticos**: los colores de superficie, texto y borde **no se escriben literals** en los componentes. Se usan los tokens declarados en `frontend/src/index.css` (`bg-base`, `bg-surface`, `bg-elevated`, `bg-elevated-hover`, `bg-inset`, `text-fg`, `text-fg-muted`, `text-fg-subtle`, `border-default`, `border-strong`).
- **Prohibido** reintroducir clases de la paleta `zinc` en `src/**/*.tsx`; un test de arquitectura (`frontend/tests/theme-tokens.test.ts`) lo verifica automáticamente.
- **Un token que se usa debe existir**: en Tailwind v4 una utilidad cuyo color no está en `@theme` no se genera, y la clase queda como texto muerto sin avisar. `hover:bg-elevated-hover` llevaba tiempo en 8 componentes sin que `--color-elevated-hover` existiera. Antes de escribir `bg-`, `text-`, `border-` o `hover:*` de un token, comprobar que la variable está declarada en `index.css`.
- **Variante `dark`**: funciona por clase (`@custom-variant dark`), no por `prefers-color-scheme`. La clase `dark` se aplica a `document.documentElement` por el hook `useTheme`. No existe una clase `light`: el tema claro es la ausencia de `dark`.
- **Default**: `:root` declara los valores **oscuros**, para que la interfaz no cambie de aspecto si el JavaScript no llega a ejecutarse.
- **Superficies no HTML** (xterm.js, barras de scroll) leen los tokens por JavaScript o por variables CSS, nunca por hexadecimales fijos.
- Especificación completa en `specs/06-theme-switcher.md`.

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
├── Makefile                    # Comandos de trabajo (test, lint, build, serve)
├── specs/                      # Especificaciones funcionales por módulo (SDD)
│   ├── template.md             # Plantilla estándar con Gherkin y tasks [ ]
│   ├── 01-containers.md        # Spec: Ciclo de vida y gestión de contenedores
│   ├── 02-realtime-logs.md     # Spec: Streaming de logs con WebSockets
│   ├── 03-create-container.md  # Spec: Alta de contenedores e imágenes
│   ├── 04-realtime-stats.md    # Spec: Métricas en vivo (CPU, RAM, Red, Disco)
│   ├── 05-terminal.md          # Spec: Terminal interactiva con xterm.js
│   ├── 06-theme-switcher.md    # Spec: Temas claro, oscuro y del sistema
│   ├── 07-images-management.md  # Spec: Gestión de imágenes (pull, inspect, delete)
│   ├── 08-volumes-management.md # Spec: Volúmenes (listado, detalle, prune)
│   ├── 09-system-overview.md    # Spec: Resumen del host y consumo de disco
│   └── 10-networks-management.md # Spec: Redes Docker (alta, detalle, prune)
├── backend/
│   ├── app/
│   │   ├── api/
│   │   │   ├── v1/
│   │   │   │   ├── containers.py   # REST de contenedores + /{id}/stats
│   │   │   │   ├── images.py       # REST de imágenes: local, search, detalle, borrado
│   │   │   │   ├── networks.py     # REST de redes: listado, detalle, alta, prune, borrado
│   │   │   │   ├── system.py       # REST de sistema: /info, /df, /overview
│   │   │   │   ├── volumes.py      # REST de volúmenes: listado, detalle, prune, borrado
│   │   │   │   └── ws.py           # WebSocket: /logs, /stats, /terminal, /images/pull
│   │   │   └── router.py
│   │   ├── core/
│   │   │   ├── config.py
│   │   │   └── docker.py
│   │   ├── schemas/
│   │   │   ├── container.py
│   │   │   ├── image.py
│   │   │   ├── log.py
│   │   │   ├── network.py
│   │   │   ├── stats.py
│   │   │   ├── system.py
│   │   │   ├── terminal.py
│   │   │   └── volume.py
│   │   ├── services/
│   │   │   ├── container_service.py
│   │   │   ├── image_service.py
│   │   │   ├── network_service.py
│   │   │   ├── stats_service.py
│   │   │   ├── system_service.py   # Primitivo compartido /info y /system/df (SPEC-09)
│   │   │   └── volume_service.py
│   │   └── main.py
│   ├── tests/
│   │   ├── conftest.py            # Fakes de aiodocker (contenedores, exec, stats)
│   │   ├── fake_volumes.py        # Doble de aiodocker.volumes (devuelve dict, no lista)
│   │   ├── test_containers.py
│   │   ├── test_create_container.py
│   │   ├── test_image_reference.py
│   │   ├── test_images.py
│   ├── test_networks.py
│   ├── test_system.py
│   │   ├── test_images_search.py
│   │   ├── test_stats.py
│   │   ├── test_system_df.py
│   │   ├── test_volumes.py
│   │   ├── test_ws_logs.py
│   │   └── test_ws_terminal.py
│   ├── pyproject.toml             # Configuración de Ruff (target py312)
│   ├── requirements.txt
│   └── .venv/
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── layout/            # Navbar, ThemeToggle
│   │   │   ├── ui/                # StatusBadge
│   │   │   ├── containers/        # Tabla, acciones y modales de contenedor
│   │   │   ├── terminal/          # TerminalModal, TerminalViewer, temas de xterm
│   │   │   ├── logs/              # LogsModal, LogsViewer
│   │   │   ├── stats/             # StatsModal, StatsSparkline
│   │   │   ├── images/            # ImagesView, ImagesTable, PullImageModal, ImageDetailModal
│   │   │   └── volumes/           # VolumesView, VolumesTable, VolumeDetailModal
│   │   ├── hooks/                 # useContainers, useDockerLogs, useDockerStats, useTheme, useImagePull
│   │   ├── services/              # dockerApi.ts
│   │   ├── types/                 # docker.ts, log.ts, terminal.ts, stats.ts, theme.ts, image.ts, volume.ts
│   │   ├── utils/                 # format.ts (formatBytes, formatPercent)
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   └── index.css              # Tokens de tema (@theme inline + @custom-variant dark)
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

Desde la raíz del repositorio:

```bash
make up            # Levanta backend (8181) y frontend (8182)
make down          # Detiene ambos servicios
make test          # Suite completa: pytest + vitest
make lint          # Ruff (backend) + Oxlint (frontend)
make build         # Typecheck + build de producción del frontend
```

### Backend
```bash
cd backend
source .venv/bin/activate
pytest -v                                        # Ejecutar suite de pruebas
python -m ruff check app                         # Lint (config en backend/pyproject.toml)
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

> `make backend-lint` es un **quality gate real**: falla ante cualquier error de Ruff. No reintroducir `|| echo "..."` en los targets del `Makefile`, porque ocultaría los fallos.

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
7. **Colores siempre por Token**:
   - **Prohibido** escribir colores literales de superficie, texto o borde (`zinc-*`, `gray-*`, `slate-*`, hexadecimales) en componentes. Usar los tokens del sistema de temas. La única excepción son las paletas ANSI de xterm.js, que viven en `src/components/terminal/` como mapas de tema.
8. **Idioma**:
   - Toda la documentación (`agent.md`, `specs/*.md`) y los textos visibles de la interfaz están en **español**. Los comentarios de código también. No introducir texto en otro idioma ni caracteres CJK.
