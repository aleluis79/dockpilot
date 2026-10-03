# DockPilot

Gestor local de Docker. Panel web para inspeccionar y operar el daemon de Docker
del propio host: contenedores, imágenes, volúmenes, redes y estado del sistema.

Se comunica con el socket local de Docker. **No es multiusuario, no tiene
autenticación y está pensado para un único operador en `127.0.0.1`.**

## Características

- **Contenedores** — listado, detalle, creación, arranque, parada, reinicio, pausa y borrado.
- **Logs en tiempo real** — streamed por WebSocket, con volcado inicial y reconexión.
- **Terminal** — sesión interactiva por WebSocket con xterm.js.
- **Estadísticas** — CPU, memoria, red y bloque E/S en vivo, con sparkline.
- **Imágenes** — inventario local, búsqueda en Docker Hub, detalle, descarga y borrado protegido.
- **Limpieza** — imágenes sin etiqueta, imágenes con etiqueta sin uso, y contenedores parados, cada uno con su preaviso y su confirmación.
- **Volúmenes** — listado con tamaño real, detalle, filtros por uso, limpieza de huérfanos y borrado.
- **Redes** — inventario con subredes, detalle con IPAM, creación con CIDR opcional, borrado protegido y limpieza.
- **Resumen del host** — versión de Docker, SO, núcleos, RAM, driver y espacio recuperable por tipo de recurso.
- **Proyectos compose** — inventario por etiquetas, previsualización del archivo, despliegue, ciclo de vida y logs en vivo.
- **Salud, renombrado y ficheros** — healthcheck con su log de sondas, renombrar sin recrear, y explorar y copiar ficheros dentro del contenedor.
- **Histórico de métricas** — series de CPU, memoria, red y disco por contenedor, con observar para que sigan midiéndose con las ventanas cerradas.
- **Tema claro/oscuro/sistema**, con detección de `prefers-color-scheme`.

## Stack

| Capa | Tecnología |
| :--- | :--- |
| Backend | Python 3.12+, FastAPI, `aiodocker` 0.27.0, Pydantic v2, `uvicorn` |
| Frontend | React 19, TypeScript, Vite 8, Tailwind CSS 4, `lucide-react`, `xterm.js` |
| Tests | `pytest` + `pytest-asyncio` + `httpx` / `vitest` + `@testing-library/react` |
| Lint | `ruff` (backend) / `oxlint` + `tsc` (frontend) |

## Puertos

| Servicio | Puerto | Motivo |
| :--- | :--- | :--- |
| Backend | 8181 | Evita el 8000, que es el default de FastAPI, Flask y Jupyter |
| Frontend | 8182 | Evita el 5173, que es el default de Vite |

Son adyacentes y con un prefijo poco usado (`818`), para que se recuerden juntos
y sea improbable que otro proceso los ocupe.

Están declarados en tres sitios, y un test los mantiene sincronizados
(`frontend/tests/ports.test.ts`):

- `Makefile` — variables `PORT_BACKEND` y `PORT_FRONTEND`, que usa `up` y `down`.
- `frontend/vite.config.ts` — `server.port` y el destino del proxy de `/api` y `/ws`.
- `backend/app/core/config.py` — `FRONTEND_PORT`, del que se derivan los orígenes de CORS.

El host de los WebSocket **no** se declara en ninguna parte: los hooks lo derivan
de `window.location` mediante `src/services/wsUrl.ts`.

Para cambiarlos, override con `FRONTEND_PORT` y `CORS_ORIGINS` (en JSON), o edita
los tres ficheros anteriores.

## Requisitos

- Python 3.12 o superior
- [pnpm](https://pnpm.io) 10 o superior
- Acceso al socket de Docker: el usuario que ejecute el backend debe poder
  hablar con `/var/run/docker.sock` (normalmente, pertenecer al grupo `docker`)

## Puesta en marcha

```bash
# 1. Dependencias
make backend-install
make frontend-install

# 2. Levantar ambos servicios en modo desarrollo
make up
```

| Servicio | URL |
| :--- | :--- |
| Frontend | http://localhost:8182 |
| Backend | http://localhost:8181 |
| Documentación interactiva de la API | http://localhost:8181/docs |

Para detenerlos:

```bash
make down
```

Los Makefile lanzan los procesos en segundo plano y escriben sus logs en
`/tmp/dockpilot-backend.log` y `/tmp/dockpilot-frontend.log`.

## Comandos

| Comando | Qué hace |
| :--- | :--- |
| `make help` | Lista los objetivos disponibles |
| `make up` / `make down` | Levanta o detiene backend y frontend |
| `make backend-serve` | Solo el backend, con `--reload` |
| `make frontend-serve` | Solo el frontend, con HMR |
| `make test` | `pytest` + `vitest` |
| `make lint` | `ruff` + `oxlint` |
| `make build` | Typecheck y build de producción del frontend |
| `make clean` | Borra cachés y artefactos de build |

## API

43 endpoints REST bajo `/api/v1`, más `GET /` y `GET /health`:

```
GET    /                             Raíz del servicio
GET    /health                       Comprobación de salud
GET    /api/v1/containers                     Listado de contenedores
POST   /api/v1/containers                     Crear contenedor
GET    /api/v1/containers/prune               Contenedores parados que se pueden limpiar
POST   /api/v1/containers/prune               Limpiar contenedores parados
GET    /api/v1/containers/{id}                Detalle
DELETE /api/v1/containers/{id}                Borrar
GET    /api/v1/containers/{id}/logs           Historial de logs
GET    /api/v1/containers/{id}/stats          Estadísticas en vivo
GET    /api/v1/containers/{id}/metrics        Serie temporal de métricas
POST   /api/v1/containers/{id}/watch          Observar (el panel lo mide siempre)
DELETE /api/v1/containers/{id}/watch          Dejar de observar
POST   /api/v1/containers/{id}/rename         Renombrar
GET    /api/v1/containers/{id}/files          Listar ficheros del contenedor
GET    /api/v1/containers/{id}/files/download Descargar un fichero
POST   /api/v1/containers/{id}/files/upload   Subir un fichero
POST   /api/v1/containers/{id}/{start|stop|restart|pause|unpause}

GET    /api/v1/images/local                   Imágenes locales
GET    /api/v1/images/prune                   Imágenes que se pueden limpiar, por nivel
POST   /api/v1/images/prune?all=[bool]        Limpiar imágenes sin etiqueta (o también con ella)
GET    /api/v1/images/search                  Búsqueda en Docker Hub
GET    /api/v1/images/{id}                    Detalle
DELETE /api/v1/images/{id}                    Borrar

GET    /api/v1/volumes                        Listado con tamaño y referencias
GET    /api/v1/volumes/{name}                 Detalle
DELETE /api/v1/volumes/{name}                 Borrar
GET    /api/v1/volumes/prune                  Resumen previo de la limpieza
POST   /api/v1/volumes/prune                  Limpiar volúmenes sin uso

GET    /api/v1/networks                       Listado con recuento de contenedores
POST   /api/v1/networks                       Crear red
GET    /api/v1/networks/{name}                Detalle
DELETE /api/v1/networks/{name}                Borrar
POST   /api/v1/networks/prune                 Limpiar redes sin uso

GET    /api/v1/system/info                    Datos del host
GET    /api/v1/system/df                      Consumo de disco por recurso
GET    /api/v1/system/overview                Vista completa en una respuesta

GET    /api/v1/compose/projects               Proyectos compose detectados por etiquetas
GET    /api/v1/compose/projects/{name}        Servicios, redes y volúmenes del proyecto
POST   /api/v1/compose/plan                   Previsualizar un archivo compose (no ejecuta nada)
GET    /api/v1/compose/browse                 Explorador para elegir ruta sin copiarla
```

Las acciones del ciclo de vida viajan por WebSocket y no por REST: son procesos
con salida en vivo, no peticiones con respuesta.

`POST /api/v1/compose/plan` es el primero que **invoca un proceso externo**: llama
a `docker compose config` a través de `app/services/compose_cli.py`, el único
módulo del backend con permiso para lanzar procesos. Resolver el plan con el CLI
en vez de con un parser propio es deliberado: si el preview lo hiciera un parser
propio, un día discreparía de lo que hace `up` y el preview mentiría. Si el
comando no está instalado, responde `503` y **el inventario de proyectos sigue
funcionando entero**, porque SPEC-11 no usa el CLI.

Cinco canales viajan por WebSocket:

```text
/ws/containers/{id}/logs        Logs en vivo
/ws/containers/{id}/stats       Estadísticas en vivo
/ws/containers/{id}/terminal    Terminal interactiva
/ws/images/pull                 Progreso de la descarga de una imagen
/ws/compose/{action}            Ciclo de vida de un proyecto compose
```

`/ws/compose/{action}` acepta `up`, `stop`, `down`, `logs` y `pull`, con la acción
validada contra esa lista cerrada. Estas acciones viajan por WebSocket y no por
REST: son procesos con salida en vivo, no peticiones con respuesta. El comando se
anuncia antes de ejecutarlo, su salida llega en vivo y se puede cancelar, y el
proceso de compose muere en el servidor al cancelar o al cerrar la pestaña.

`down --volumes` es la única acción irreversible, y está protegida por cuatro
salvaguardas: nunca es el valor por defecto, exige confirmación en dos pasos con
los nombres reales de los volúmenes a la vista, el servidor responde `409` si el
proyecto tiene contenedores en marcha, y el botón destructivo no comparte aspecto
con el de `down` normal.

Un fallo de compose se reporta como `exit` con código distinto de cero, **no**
como error del panel: el comando llegó a ejecutarse y fue compose el que no tuvo
éxito. `error` queda para lo que impide ejecutar: ruta inválida, `409`, CLI
ausente o `504`.

## Estructura

```text
.
├── Makefile              Atajos de desarrollo
├── agent.md              Contexto, metodología y reglas del proyecto
├── backend/
│   ├── app/
│   │   ├── api/v1/       Routers: containers, images, volumes, networks, system
│   │   ├── schemas/      Contratos Pydantic
│   │   ├── services/     Lógica de negocio
│   │   └── core/         Acceso al cliente de Docker y traducción de errores
│   └── tests/            Suite pytest, con dobles de aiodocker
├── frontend/
│   └── src/
│       ├── components/   UI, agrupada por recurso
│       ├── hooks/        Estado y carga de datos
│       ├── services/     Cliente HTTP
│       └── types/        Interfaces de TypeScript
└── specs/                Especificaciones, una por funcionalidad
```

## Cómo se trabaja: SDD

El proyecto sigue **Spec-Driven Development**. Cada funcionalidad tiene su
especificación en `specs/`, y el flujo es inviolable:

1. Se escribe o actualiza la spec y el usuario la aprueba.
2. Tests primero, que fallan por implementación ausente.
3. Implementación hasta pasarlos.
4. Quality gates limpios.
5. Se marcan las casillas `[x]` de la spec.

`agent.md` recoge las reglas completas: formato Gherkin en español, los schemas
de Pydantic y las interfaces de TypeScript deben coincidir campo por campo, los
colores van siempre por token de tema y no se introduce texto en otro idioma.

## Verificación

```bash
make test    # 540 pruebas de backend + 602 de frontend
make lint    # ruff y oxlint
make build   # typecheck y build
```

## El histórico de métricas

Las métricas de un contenedor tienen dos capas, y conviene no confundirlas:

- **En vivo** es el `WebSocket /ws/containers/{id}/stats`: la lectura de ahora
  mismo, sin memoria.
- **La serie temporal** es lo que acumula: `GET /containers/{id}/metrics` y un
  mensaje `{"type": "history", ...}` que el mismo canal manda antes de la primera
  muestra. Da CPU y memoria por porcentaje, y red y disco en **bytes por
  segundo**, que salen de restar dos lecturas.

Para que la curva siga creciendo con las ventanas cerradas está **Observar**: el
backend sigue midiendo ese contenedor y su serie sigue ahí cuando vuelves, hasta
un máximo de 12 observados. El anillo vive **en memoria**, así que reiniciar el
panel lo borra, y la interfaz lo dice en vez de mostrar un vacío sin explicación.

Tres cosas que el panel se niega a dibujar, porque serían afirmaciones falsas: un
cero donde no se midió (un contenedor parado deja un hueco, no un 0), una línea
uniendo dos puntos separados por un hueco de tiempo, y una caída de 40 GB cuando
el contenedor se reinicia y sus contadores vuelven a cero — ahí el trazo se
parte.

## Limpiar lo que no se usa

Tres niveles, cada uno con su botón y **su** confirmación, porque no son la misma
cosa:

| Botón | Qué borra | Qué no se puede recuperar |
| :--- | :--- | :--- |
| **Limpiar sin etiqueta** (imágenes) | Imágenes sin etiqueta que no use ningún contenedor | Casi nada: es basura de un `build` viejo |
| **quitar también las que tienen etiqueta** | Además, las que tienen etiqueta y no usa nadie | **Habrá que volver a descargarlas** |
| **Limpiar parados** (contenedores) | Los contenedores parados | Su **capa de escritura**: lo escrito dentro y no montado en un volumen |

Dos cosas que conviene saber antes de mirar un número:

- **Los bytes del diálogo son una cota**, y la interfaz escribe *hasta* a propósito:
  el recuento suma el tamaño de cada imagen y dos imágenes pueden compartir capas.
- **El total recuperable del resumen del host no es lo que da el botón.** El
  resumen cuenta todo lo que no usa un contenedor, con y sin etiqueta; el botón
  seguro sólo toca lo que no tiene etiqueta. En una máquina normal son cifras
  muy distintas, y cada botón muestra **su** preaviso.

Ninguna limpieza alcanza lo que está en uso: lo decide el daemon. Y si el daemon
no sabe decirnos qué se puede limpiar, el botón lo dice y se desactiva, en vez de
afirmar que no hay nada.

## Ayuda integrada

El botón de interrogación del navbar abre un manual con cinco secciones: general y
advertencias, qué hace cada pestaña, qué operaciones son irreversibles y qué está
protegido, cómo funcionan los datos en vivo por WebSocket, y resolución de
problemas. Está en `frontend/src/components/help/HelpModal.tsx`.

## Licencia

AGPL-3.0-or-later. El texto completo está en [`LICENSE`](LICENSE).

Se eligió la AGPL y no la GPL por una razón concreta: DockPilot es una
aplicación web que se usa a través del navegador. La sección 13 de la AGPL
obliga a ofrecer el código fuente correspondiente a quien lo use a través de
una red, incluso si no se distribuye una copia. Para una herramienta que da
control del host, esa es exactamente la protección que encaja.

## Advertencias

- **Las operaciones de borrado y limpieza son reales.** `prune` y `delete` alcanzan
  el daemon y borran datos. Durante el desarrollo se evita probarlos contra datos
  reales: se verifica que se rechazan las operaciones protegidas y se contrasta la
  lectura contra el daemon.
- **`force` en el borrado de contenedores y redes es irreversible.** Corta la
  ejecución y, en redes, desconecta el tráfico.
- El panel no aplica autenticación. No lo expongas fuera de `127.0.0.1`.
