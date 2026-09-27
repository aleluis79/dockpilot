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

### Docker Compose (SPEC-11 a SPEC-15)
- **El Engine API no tiene noción de proyecto compose.** Un proyecto existe únicamente como convención de etiquetas `com.docker.compose.*` sobre contenedores, redes y volúmenes. `docker compose ls` **no sirve** para inventariar: en el host de referencia devuelve un solo proyecto y omite los huérfanos, que son justo los que hay que detectar.
- **SPEC-11 es solo lectura y no necesita el CLI de compose.** Se apoya solo en etiquetas, así que el inventario funciona entero aunque `docker compose` no esté instalado.

#### `GET /api/v1/compose/browse`: el explorador está confinado (SPEC-14)
El explorador de archivos existe porque la ruta había que copiarla a mano, y eso acababa en previsualizar el proyecto equivocado: en el host de referencia hay 4 compose files y el inventario solo conoce 1, porque los otros tres no están en marcha y no dejan etiquetas.

Tres reglas que **no se pueden relajar** sin romper el modelo de seguridad:

1. **El confinamiento se comprueba sobre la ruta ya resuelta.** `Path(path).resolve()` y luego `raiz in objetivo.parents`. Nunca `str.startswith()`: sin separador acepta `/home/alejandro` para una raíz `/home/al`, y con separador rechaza todo cuando la raíz es `/` porque buscaría `//`. Un enlace simbólico a `~/.ssh` colado en el home pasa cualquier comparación de texto, y `resolve()` es lo único que lo para.
2. **Solo se devuelven nombres, tipos y tamaños. Nunca contenido.** Leer el archivo es de `build_plan` (SPEC-12), con su límite de tamaño y su validación. Una segunda vía de lectura sería superficie que nadie pidió.
3. **Sin `path` se devuelve la raíz, y la raíz la dice el backend.** El cliente no puede deducirla: `~` apunta al home del usuario del **backend**, no al del navegador. Si el cliente calculara la raíz por su cuenta, la regla de confinamiento estaría en dos sitios y tarde o temprano discreparían.

`path` **relativa** da `400`, fuera de la raíz da `403`, y el `403` usa el mismo mensaje exista o no el destino: si se distinguieran, el endpoint serviría para mapear el disco probando rutas y leyendo códigos de respuesta.

#### Desplegar desde el plan: `project_name` es obligatorio (SPEC-15)
El WebSocket de compose **exige** `project_name` y devuelve `400` si falta. No es rigidez por gusto: compose deduce el nombre de la etiqueta `name:` del **archivo**, no del directorio, y en el host de referencia `sica/docker-compose.yml` declara `name: simp-sica` con el directorio `sica`. La función que adivinaba por directorio se borró en SPEC-15; las dos únicas fuentes que existen —el inventario y el plan— ya conocen el nombre, porque el plan lo saca del propio `config`.

Se valida **dentro del handler** y no con `Query(...)` en la firma: un parámetro obligatorio que falta hace que FastAPI cierre la conexión del WebSocket antes de que el handler pueda devolver un `400` legible.

`--remove-orphans` se puede apagar por petición, y el despliegue desde el plan lo hace. El flag solo se lleva contenedores de servicios ausentes del archivo, y en el camino del plan el nombre puede chocar con otro proyecto. Un proyecto **huérfano** (cero contenedores) nunca bloquea: no hay contenedores que perder, y bloquearlo dejaría fuera justo el despliegue que la spec vino a permitir.

`PlannedService.build` **no es un booleano**: es el coste estimado del contexto, con `bytes_aprox`, `ficheros_aprox`, `truncado` y `error`. La estimación **no aplica `.dockerignore`** y sobreestima a propósito, porque un número alto hace que el usuario pregunte y uno bajo hace que el `up` tarde 8 minutos sin avisar. Si el contexto no se puede medir, se dice en `error`: un `0` mudo se lee como "no pesa".

#### `app/services/compose_cli.py`: el único módulo que lanza procesos
El backend **dejó de ser cliente puro del Engine API** en SPEC-12. A partir de ahí este módulo es el **único** sitio con permiso para invocar procesos externos, y SPEC-13 solo le añade un modo de streaming. Si alguna vez hace falta otro proceso, se añade aquí y en ningún otro sitio.

Se llama al CLI y **no se parsea el YAML en Python** porque la utilidad de un preview es ser fiel: un parser propio tendría que replicar la interpolación de variables, `extends`, `profiles`, `include` y la precedencia de `env_file`, y el día que se le escapara uno el preview mentiría. `docker compose config` es el propio compose diciendo qué interpretó, así que el preview y el `up` de SPEC-13 no pueden discrepar.

Cinco obligaciones, implementadas y con test:

| Obligación | Dónde |
| :--- | :--- |
| Lista de argumentos, **nunca** `shell=True` | `argumentos_config()` + `_crear_proceso()` |
| `PATH` reducido a una lista conocida | `KNOWN_PATH` |
| `COMPOSE_*` y `DOCKER_*` limpias del entorno hijo | `_entlimpio()` |
| `stdin=DEVNULL` | `_crear_proceso()` |
| Proceso muerto en **todos** los caminos de salida | `_matar()` (síncrono) + `_terminar()` |

SPEC-13 amplía el runner con un **modo streaming** sobre el mismo núcleo, no un segundo camino. Cuatro cosas que no son evidentes:

- **El servicio va como argumento POSICIONAL.** Compose v2 no tiene `--service` (`unknown flag: --service`); `stop`, `logs` y `pull` lo toman posicional. Y a diferencia del preview, las acciones **no** llevan `--profile`: un `up` debe arrancar el perfil por defecto, no todos.
- **`_matar()` es síncrono a propósito.** Dentro del `finally` de una tarea que se cancela, cualquier `await` puede volver a lanzar `CancelledError` y saltarse el resto de la limpieza. Con un `_terminar()` que hace `await`, el `docker compose` **sobrevivía** a la cancelación.
- **Cancelar es cancelar la tarea consumidora, no `aclose()`.** Un generador asíncrono que ya está leyendo no se puede cerrar por fuera: lanza `asynchronous generator is already running`.
- **`logs --follow` no termina nunca**: emite líneas y el EOF no llega. El doble de `tests/conftest.py` modela eso con `PipeQueEmiteYNoTermina`, y es el caso que justifica el botón «Cancelar».

**Un fallo de compose no es un fallo del panel.** Un `up` que muere porque el puerto está ocupado es `exit` con `code != 0`, no un mensaje `error`. `error` queda para lo que impide ejecutar (ruta inválida, `409`, CLI ausente, `504`).

**Trampa de `docker compose config`: excluye los servicios con `profiles`** salvo que se activen. Por eso los argumentos llevan siempre `--profile '*'`: sin él, un proyecto con un servicio `profiles: [dev]` devuelve un plan con un servicio menos **sin avisar**. Otras tres rarezas de su salida, todas en SPEC-12 §3.2: `networks` y `volumes` de la raíz son **mapas** (clave = nombre lógico, valor = nombre real prefijado), `networks` de un servicio también es un mapa con valor `null`, y `published` de un puerto es una **cadena**.

**`stderr` con código de salida 0 son avisos, no errores.** Compose valida el archivo y aun así avisa de una variable sin definir. Por eso `ejecutar_config()` devuelve `stderr` siempre, y `build_plan()` lo expone en `warnings`.

**Trampa de aiodocker**: `containers.list()` devuelve objetos `DockerContainer`, no dicts, y las etiquetas viven en `_container`. Sin desenvolverlo el inventario sale vacío **sin dar ningún error**. Ver SPEC-11 §3.6.
**Trampa del daemon**: `/volumes` devuelve `Labels: null` donde `/networks` y `/containers/json` devuelven `{}`. Normalizar con `_labels()` antes de leer.
**SPEC-13 reutiliza este runner** y no abre un segundo camino de ejecución. El canal es **uno solo** (`/ws/compose/{action}`, con la acción validada contra una lista cerrada) y no cinco: cinco handlers casi idénticos serían cinco sitios donde olvidar el `finally` que mata el proceso.

#### Trampa: un hook en `App` no se desmonta al cambiar de pestaña
`useContainers` se llama desde `App`, no desde una vista, así que **vive todo el tiempo que la app**. Solo pedía datos al montarse y al cambiar el filtro de estado, nunca al cambiar de pestaña. El síntoma era desconcertante: desplegar un proyecto desde «Proyectos» dejaba la lista de contenedores obsoleta y los contenedores nuevos no aparecían hasta tocar el filtro, porque eso era lo único que disparaba un refetch.

Las otras vistas no tienen el problema: `VolumesView`, `NetworksView` y `ProjectsView` son componentes que piden sus datos al montarse, así que se recargan al volver a su pestaña.

La regla que se sigue ahora: **un hook que pinte una vista recibe `activo` y refresca al activarse**, saltando la primera vez para no duplicar la carga inicial, y con el `refetch` en un ref para no re-dispararse en cada cambio de filtro.

No se movió el hook a una vista propia a propósito: `App` tiene siete estados de modales de contenedores (detalle, logs, stats, terminal, borrado, alta) que habría que subir o mover, y el arreglo/refresco cubre el bug sin tocar ese refactor.

Y hay una regla fácil de romper en el mismo hook: **el filtro de estado se aplica en el navegador, no en el servidor**. El backend lo admite (`GET /containers?status=...`), pero pedir solo los de un estado hacía que los contadores de las pills bailaran —se calculan sobre la lista completa, así que al elegir «Activos» el contador de «Todos» marcaba el número de activos y los otros dos caían a cero— y convertía cada clic en un filtro en una ida y vuelta al daemon. Los contadores son un censo del host, no un recuento de lo que se está viendo.

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
│   ├── 10-networks-management.md # Spec: Redes Docker (alta, detalle, prune)
│   ├── 11-compose-inventory.md  # Spec: Inventario de proyectos compose (solo lectura, por labels)
│   ├── 12-compose-plan.md       # Spec: Lectura y previsualización de archivos compose (1er subprocess)
│   ├── 13-compose-lifecycle.md  # Spec: Ciclo de vida de proyectos compose (up/stop/down/pull/logs)
│   ├── 14-compose-file-browser.md # Spec: Explorador de archivos compose (elegir ruta sin copiarla)
│   └── 15-compose-deploy-from-plan.md # Spec: Desplegar un compose file desde el plan (up, coste de build)
├── backend/
│   ├── app/
│   │   ├── api/
│   │   │   ├── v1/
│   │   │   │   ├── compose.py      # REST de compose: /projects, /projects/{name}, POST /plan, GET /browse
│   │   │   │   ├── ws.py           # + /ws/compose/{action} (SPEC-13)
│   │   │   │   ├── containers.py   # REST de contenedores + /{id}/stats
│   │   │   │   ├── images.py       # REST de imágenes: local, search, detalle, borrado
│   │   │   │   ├── networks.py     # REST de redes: listado, detalle, alta, prune, borrado
│   │   │   │   ├── system.py       # REST de sistema: /info, /df, /overview
│   │   │   │   ├── volumes.py      # REST de volúmenes: listado, detalle, prune, borrado
│   │   │   └── router.py
│   │   ├── core/
│   │   │   ├── config.py
│   │   │   └── docker.py
│   │   ├── schemas/
│   │   │   ├── compose.py
│   │   │   ├── container.py
│   │   │   ├── image.py
│   │   │   ├── log.py
│   │   │   ├── network.py
│   │   │   ├── stats.py
│   │   │   ├── system.py
│   │   │   ├── terminal.py
│   │   │   └── volume.py
│   │   ├── services/
│   │   │   ├── compose_cli.py      # ÚNICO módulo que lanza procesos (SPEC-12)
│   │   │   ├── compose_service.py  # Inventario por labels (SPEC-11) y build_plan (SPEC-12)
│   │   │   ├── container_service.py
│   │   │   ├── image_service.py
│   │   │   ├── network_service.py
│   │   │   ├── stats_service.py
│   │   │   ├── system_service.py   # Primitivo compartido /info y /system/df (SPEC-09)
│   │   │   └── volume_service.py
│   │   └── main.py
│   ├── tests/
│   │   ├── conftest.py            # Fakes de aiodocker (contenedores, exec, stats, compose)
│   │   ├── fake_volumes.py        # Doble de aiodocker.volumes (devuelve dict, no lista)
│   │   ├── test_containers.py
│   │   ├── test_create_container.py
│   │   ├── test_image_reference.py
│   │   ├── test_images.py
│   │   ├── test_compose.py
│   │   ├── test_networks.py
│   │   ├── test_system.py
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
│   │   │   ├── layout/            # Navbar, ThemeProvider, ThemeToggle
│   │   │   ├── ui/                # StatusBadge, modalOverlay (velo compartido)
│   │   │   ├── containers/        # Tabla, acciones y modales de contenedor
│   │   │   ├── terminal/          # TerminalModal, TerminalViewer, temas de xterm
│   │   │   ├── logs/              # LogsModal, LogsViewer
│   │   │   ├── stats/             # StatsModal, StatsSparkline
│   │   │   ├── images/            # ImagesView, ImagesTable, PullImageModal, ImageDetailModal
│   │   │   ├── volumes/           # VolumesView, VolumesTable, VolumeDetailModal
│   │   │   ├── networks/          # NetworksView, NetworksTable, CreateNetworkModal, NetworkDetailModal
│   │   │   ├── system/            # SystemSummaryBar, SystemDetailPanel
│   │   │   ├── compose/           # ProjectsView, ProjectsTable, ProjectDetailModal, ComposeBadge,
│   │   │   │                     # ComposePlanModal, ComposeEditor, ComposeActionPanel,
│   │   │   │                     # ComposeDownDialog, ComposeLogsViewer, ComposeFilePicker,
│   │   │                     # ComposeActionPanel, ComposeDeployDialog
│   │   │   └── help/              # HelpModal
│   │   ├── hooks/                 # useContainers, useDockerLogs, useDockerStats, useTheme, useImagePull,
│   │   │                         # useNetworks, useSystemOverview, useComposeProjects, useComposeCommand
│   │   ├── services/              # dockerApi.ts, wsUrl.ts
│   │   ├── types/                 # docker.ts, log.ts, terminal.ts, stats.ts, theme.ts, image.ts, volume.ts, network.ts, system.ts, compose.ts
│   │   ├── utils/                 # format.ts (formatBytes, formatPercent), compose.ts (rutaDeProyecto)
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   └── index.css              # Tokens de tema (@theme inline + @custom-variant dark)
│   ├── tests/
│   │   ├── setup.ts
│   │   ├── theme-tokens.test.ts   # Arquitectura: prohibe `zinc-*` y tokens no declarados
│   │   ├── ports.test.ts
│   │   ├── components/
│   │   │   └── compose/           # ProjectsView, ProjectsTable, ProjectDetailModal, ComposeBadge,
│   │   │                         # ComposeFilePicker, ComposeLogsViewer, composeActions
│   │   ├── hooks/
│   │   └── services/
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
- **Test de arquitectura de tokens** (`tests/theme-tokens.test.ts`): además de prohibir las paletas neutras literales, **verifica que toda clase de color use un token declarado en `index.css`**. En Tailwind v4 una utilidad cuyo color no está en `@theme` no se genera y la clase queda muerta sin avisar.

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
