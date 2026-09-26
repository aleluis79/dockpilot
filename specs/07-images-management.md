# SPEC-07: Gestión de Imágenes Docker (Listado, Descarga, Inspección y Borrado)

## 1. Contexto y Objetivos
- **Problema**: DockPilot solo permite **leer** imágenes. El backend expone `GET /api/v1/images/local` y `GET /api/v1/images/search`, y el frontend únicamente las consume dentro de `CreateContainerModal` para elegir un nombre al crear un contenedor. No existe forma de ver el inventario real de imágenes del host, descargar una imagen de forma controlada, inspeccionar su composición ni liberar espacio. `ImageService.list_local_images` además **descarta campos útiles** que el daemon ya devuelve (`Containers`, `RepoDigests`), y el cliente `dockerApi.getLocalImages()` está escrito pero no lo consume ninguna pantalla (código muerto). El efecto práctico es que el flujo "descargo una imagen y la uso" solo funciona a través del alta de contenedor, que vuelve a descargarla cada vez, y no hay inventario ni control del espacio.
- **Objetivo**: Incorporar la gestión de imágenes como citizen de primera clase del panel: una pantalla de inventario con las imágenes locales (tags, tamaño, fecha, si están en uso), descarga con **progreso en vivo por capa** a través de WebSocket, inspección detallada (configuración, capas, historial de construcción) y borrado con protección frente a imágenes en uso. Cerrar el pilar de "gestión de imágenes" del alcance del proyecto y dar uso a las piezas ya escritas.
- **Alcance**:
  - Incluye:
    - Enriquecimiento del listado local con `containers` (imágenes en uso) y `repo_digests`.
    - Endpoint REST `GET /api/v1/images/{id}` (inspección) y `DELETE /api/v1/images/{id}` (borrado, con `force`).
    - Canal WebSocket `/ws/images/pull` que emite el progreso de descarga Emitido por el daemon, capa a capa.
    - Validación de la referencia de imagen en el borde (evita entradas malformadas hacia el daemon).
    - Pantalla de imágenes con inventario, indicador de "en uso", y acciones de ejecutar, inspeccionar y borrar.
    - Modal de descarga con barras de progreso por capa, digest final y manejo de error.
    - Modal de detalle con metadatos, configuración y tabla de historial.
    - Selector de vista Contenedores / Imágenes en la barra principal.
  - No incluye (en esta spec):
    - **Etiquetado** de imágenes (`POST /images/{id}/tag`). Es una operación de bajo uso en un entorno local monousuario y añadiría un modal de edición por cada fila; queda para un incremento posterior.
    - Autenticación con registros privados (`docker login`). Los repos privados fallarán con un error 403/404 legible, que es el comportamiento honesto sin credenciales.
    - `docker push`, construcción de imágenes (`build`) y `docker image prune` (limpieza masiva).
    - Selección explícita de plataforma (`--platform linux/arm64`).
    - Historial de métricas de imágenes (no aplica: ya cubierto por SPEC-04).

---

## 2. Contrato de Datos (Schemas & Types)

### 2.1 Backend (Pydantic v2) - `app/schemas/image.py`

`LocalImageSummary` se **extiende** (campos nuevos opcionales para no romper a los consumidores actuales) y se añaden tres modelos.

```python
from typing import Any, Literal, Optional
from pydantic import BaseModel, Field

class LocalImageSummary(BaseModel):
    id: str
    tags: list[str] = Field(default_factory=list)
    size: int = 0
    created: int = 0
    # --- nuevos en SPEC-07 ---
    containers: int = Field(0, description="Contenedores que usan esta imagen (0 = eliminable sin force)")
    repo_digests: list[str] = Field(default_factory=list)

class ImageHistoryEntry(BaseModel):
    id: str = Field(..., description="ID de la capa")
    created: int = Field(0, description="Epoch de creación de la capa")
    created_by: str = Field("", description="Instrucción Dockerfile que creó la capa")
    size: int = Field(0, description="Tamaño de la capa en bytes")
    comment: str = ""
    tags: Optional[list[str]] = None

class ImageDetail(BaseModel):
    id: str
    tags: list[str] = Field(default_factory=list)
    repo_digests: list[str] = Field(default_factory=list)
    size: int = 0
    created: int = 0
    architecture: str = ""
    os: str = ""
    entrypoint: Optional[list[str]] = None
    cmd: Optional[list[str]] = None
    env: list[str] = Field(default_factory=list)
    exposed_ports: dict[str, Any] = Field(default_factory=dict)
    working_dir: str = ""
    user: str = ""
    labels: dict[str, str] = Field(default_factory=dict)
    layer_count: int = Field(0, description="Número de capas del RootFS")
    history: list[ImageHistoryEntry] = Field(default_factory=list)

class ImagePullMessage(BaseModel):
    """Mensaje del canal de descarga. Modelo plano con campos opcionales, en línea
    con TerminalServerMessage. Campos válidos por tipo:

    start  -> image
    layer  -> image, id, status, current, total, progress
    digest -> image, digest
    done   -> image, id, tags
    error  -> image, code, message
    """
    type: Literal["start", "layer", "digest", "done", "error"]
    image: str
    id: Optional[str] = None
    status: Optional[str] = None
    current: Optional[int] = None
    total: Optional[int] = None
    progress: Optional[str] = None
    digest: Optional[str] = None
    tags: Optional[list[str]] = None
    code: Optional[int] = None
    message: Optional[str] = None

class ImageDeleteResponse(BaseModel):
    id: str
    deleted: bool
    untagged: list[str] = Field(default_factory=list, description="Tags que han quedado sin referenciar")
    message: str
```

### 2.2 Frontend (TypeScript) - `src/types/image.ts`

```typescript
export interface LocalImageSummary {
  id: string;
  tags: string[];
  size: number;
  created: number;
  containers: number;
  repo_digests: string[];
}

export interface ImageHistoryEntry {
  id: string;
  created: number;
  created_by: string;
  size: number;
  comment: string;
  tags?: string[] | null;
}

export interface ImageDetail {
  id: string;
  tags: string[];
  repo_digests: string[];
  size: number;
  created: number;
  architecture: string;
  os: string;
  entrypoint?: string[] | null;
  cmd?: string[] | null;
  env: string[];
  exposed_ports: Record<string, unknown>;
  working_dir: string;
  user: string;
  labels: Record<string, string>;
  layer_count: number;
  history: ImageHistoryEntry[];
}

export type ImagePullMessageType = 'start' | 'layer' | 'digest' | 'done' | 'error';

export interface ImagePullMessage {
  type: ImagePullMessageType;
  image: string;
  id?: string;
  status?: string;
  current?: number;
  total?: number;
  progress?: string;
  digest?: string;
  tags?: string[];
  code?: number;
  message?: string;
}

export type ImageLayerState = 'pending' | 'downloading' | 'extracting' | 'done';

export interface ImagePullLayer {
  id: string;
  status: string;
  current: number;
  total: number;
  state: ImageLayerState;
}

export interface ImageDeleteResponse {
  id: string;
  deleted: boolean;
  untagged: string[];
  message: string;
}
```

---

## 3. Mecánica

### 3.1 Normalización del listado local

`GET /api/v1/images/local` sigue filtrando las imágenes sin tag (`<none>:<none>`) como hasta ahora, y ahora puebla también:

| Campo | Origen en `images.list()` | Normalización |
| :--- | :--- | :--- |
| `containers` | `Containers` | `int(Containers or 0)`. Es el dato que decide si el borrado necesita `force` |
| `repo_digests` | `RepoDigests` | Descarta `<none>@<none>` |

El campo `Containers` del daemon **ya existe** y hoy se descarta; no requiere ninguna llamada adicional al daemon.

### 3.2 Validación de la referencia de imagen

La referencia viaja en el query param y acaba en el daemon, así que se valida en el borde antes de tocar Docker. Se acepta un repositorio con tag y/o digest, con host de registro opcional:

```python
IMAGE_REF_PATTERN = re.compile(
    r"^[a-zA-Z0-9][a-zA-Z0-9._-]*"
    r"(?:/[a-zA-Z0-9._-]+)*"
    r"(?::[a-zA-Z0-9._-]+)?"
    r"(?:@sha256:[a-f0-9]{64})?$"
)
```

Casos válidos: `nginx`, `nginx:alpine`, `library/redis:7`, `ghcr.io/propietario/app:1.2`, `ubuntu@sha256:<64 hex>`.
Se rechazan (y se responde `error` con `code=400`, sin contactar con el daemon): referencias vacías, con espacios, con más de 255 caracteres, con caracteres fuera del patrón, o con un digest que no sea `sha256` de 64 hex.

Si la referencia no lleva tag embebido ni digest, se normaliza a `<ref>:latest` para que el comportamiento sea idéntico al de `docker pull`.

### 3.3 Endpoints REST

| Método | Endpoint | Query / Body | Respuesta | Errores |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/images/local` | — | `200 OK` (`LocalImageSummary[]`) | `503` daemon no disponible |
| `GET` | `/api/v1/images/{id}` | — | `200 OK` (`ImageDetail`) | `404` imagen inexistente |
| `DELETE` | `/api/v1/images/{id}` | `force` (bool, def. `false`) | `200 OK` (`ImageDeleteResponse`) | `404` inexistente, `409` en uso |

`GET /{id}` acepta tanto el ID completo (`sha256:...`) como cualquiera de sus tags. Se resuelve con `images.inspect()` y se completa con `images.history()`. Si `history` falla pero `inspect` tuvo éxito, se devuelve el detalle con `history` vacío: el historial es informativo y no debe impedir inspeccionar.

`DELETE` mapea el conflicto del daemon a `409` con un mensaje que indica si hace falta `force`. La respuesta `untagged` recoge los tags que quedan huérfanos, que es el dato que explica al usuario por qué el espacio no baja del todo.

### 3.4 Canal WebSocket de descarga con progreso

- **Ruta**: `/ws/images/pull?image=<referencia>`
- **Query params**: `image` (obligatorio, se valida según §3.2).
- **Flujo**:
  1. El backend acepta la conexión y emite `start` de inmediato, para que el cliente confirme que la referencia es válida antes de que empiece la descarga.
  2. Se itera `docker.images.pull(ref, stream=True)` y **cada** evento del daemon se normaliza a `ImagePullMessage` y se reenvía. No se filtran eventos: el daemon decide el detalle, el backend solo lo adapta.
  3. Al terminar el stream se emite `done` con el ID corto y los tags resultantes.
- **Mapeo de eventos del daemon a `layer`**: los eventos reales del daemon tienen esta forma (verificado contra `hello-world:latest`):

  ```json
  {"status": "Pulling from library/hello-world", "id": "latest"}
  {"status": "Pulling fs layer", "progressDetail": {}, "id": "4f55086f7dd0"}
  {"status": "Download complete", "progressDetail": {}, "id": "4f55086f7dd0"}
  {"status": "Pull complete", "progressDetail": {}, "id": "4f55086f7dd0"}
  {"status": "Digest: sha256:5e2309035332..."}
  {"status": "Status: Downloaded newer image for hello-world:latest"}
  ```

  El mapeo es textual sobre `status`, y `current`/`total` se toman de `progressDetail` cuando existen (el daemon los omite en `Downloading` de capas ya cacheadas):

  | `status` del daemon | Tipo emitido | `state` en el cliente |
  | :--- | :--- | :--- |
  | `Pulling fs layer` | `layer` | `pending` |
  | `Downloading` | `layer` | `downloading` |
  | `Extracting` | `layer` | `extracting` |
  | `Download complete` / `Pull complete` | `layer` | `done` |
  | `Digest: sha256:...` | `digest` | — |
  | `Status: ...` | `done` | — |

- **Cancelación**: el cliente cancela cerrando el socket. `WebSocketDisconnect` se propaga y el generador de aiodocker se cierra, liberando la respuesta HTTP subyacente. No hay mensaje de cancelación ni estado servidor adicional que sincronizar.
- **Concurrencia**: un mismo cliente no debe abrir dos descargas simultáneas de la misma referencia; el frontend deshabilita el botón mientras hay una descarga en curso. El backend no bloquea descargas concurrentes de referencias distintas porque cada iteración es independiente.

### 3.5 Manejo de errores

Comportamiento **verificado** contra el daemon, no supuesto:

| Situación | Qué lanza aiodocker | Traducción |
| :--- | :--- | :--- |
| Repositorio inexistente o privado | `DockerError(status=404)`, `pull access denied for X, repository does not exist or may require 'docker login'` | `error` con `code=404` y el mensaje del daemon |
| Tag inexistente | `DockerError(status=404)`, `failed to resolve reference ...: not found` | `error` con `code=404` |
| Referencia malformada | `ValueError` de aiodocker o validación propia | `error` con `code=400` |
| Borrado de imagen en uso | `DockerError(status=409)` | `HTTPException(409)` en el endpoint REST |
| Borrado de imagen inexistente | `DockerError(status=404)`, `No such image` | `HTTPException(404)` |

> **Nota para quien implemente**: el docstring de `aiodocker.images.pull` afirma que los errores del stream llegan como `DockerStreamError`. **No es el caso en aiodocker 0.27.0**: se lanza `DockerError` durante la iteración. Hay que capturar `DockerError` y mirar `e.status`, no una clase que nunca se instancia.

Ningún error de descarga debe cerrar el socket con un código de cierre: se envía un mensaje `error` y se cierra con `1000`, para que el cliente pueda distinguir "falló la descarga" de "se cortó la conexión".

### 3.6 Superficie de usuario

- **Selector de vista**: la barra principal incluye un conmutador `Contenedores | Imágenes`. Es la mínima perturbación de `App.tsx`: el contenido actual se conserva y la nueva vista se monta al activarse.
- **Toolbar por pestaña**: los filtros por estado (`Todos`, `Activos`, `Detenidos`, `Pausados`) y el buscador por nombre/imagen/ID son **exclusivos de contenedores**, así que se renderizan dentro de la pestaña `Contenedores`, debajo del conmutador. En la pestaña `Imágenes` no deben aparecer: son controles que no filtrarían nada allí. El conmutador queda por encima, porque es la navegación primaria entre pestañas.
- **Inventario** (`ImagesTable`): una fila por imagen con tags (el primero en `font-mono`, el resto como badges), tamaño con `formatBytes` (ya existe en `src/utils/format.ts`), fecha, y un indicador de "en uso" cuando `containers > 0`. Filas ordenadas por más reciente. Estados de carga, vacío y error, en línea con `ContainersTable`.
- **Buscador de imágenes**: la vista de Imágenes tiene su propio buscador, **distinto del de contenedores** (aquel filtra por nombre, imagen e ID de un contenedor; este filtra por tag e ID de imagen). Se aplica en el cliente sobre el inventario ya cargado, sin nuevas peticiones a la API, porque responder al instante importa más que filtrar en el servidor. Coincide sin distinguir mayúsculas sobre cualquier tag y sobre el ID. Mientras hay texto activo el contador muestra `coincidencias de total`, y si no hay coincidencias se muestra un estado vacío propio ("ninguna imagen coincide con…"), distinto del "no hay imágenes locales" del host vacío.
- **Descarga** (`PullImageModal`): el flujo tiene **dos fases explícitas**, porque escribir no debe tener efectos:
  1. **Búsqueda**: input de texto libre y un botón `Buscar`. Escribir **nunca** dispara nada; el único disparador es el botón. Al pulsar se consulta `GET /api/v1/images/search?term=...` y se listan las alternativas encontradas (nombre, descripción, estrellas y si es oficial).
  2. **Elección**: el usuario elige una alternativa, o confirma la referencia escrita tal cual (para descargar un tag o digest concreto que la búsqueda no devuelva). Solo al elegir se abre el WebSocket y empieza la descarga, que muestra una barra por capa.
  - Las alternativas que **ya están en local** se señalan, porque no hace falta volver a descargarlas.
  - El progreso total se muestra como bytes downloaded / total, no como porcentaje cuando `total` es 0 (el daemon lo omite en capas cacheadas y una división por cero mostraría `NaN`).
  - Editar el texto, pulsar `Buscar` de nuevo o elegir otra alternativa **descarta la descarga en curso** (cierra el socket) y vuelve a la fase de búsqueda.
- **Detalle** (`ImageDetailModal`): metadatos (id, tags, digests, tamaño, arquitectura, SO), bloque de configuración (entrypoint, cmd, env, puertos expuestos, usuario, directorio de trabajo) y tabla de historial con `created_by` y tamaño por capa.
- **Borrado**: reutiliza `DeleteConfirmModal`, **ampliado** para admitir un descriptor genérico (`{ id, name, subtitle }`) y textos de confirmación configurables. `ContainerSummary` ya cumple esa forma estructuralmente, así que el uso actual y sus tests siguen funcionando sin cambios.
- **Acción "Ejecutar"**: desde una imagen se abre `CreateContainerModal` con la imagen preseleccionada, reutilizando el flujo existente (SPEC-03).

---

## 4. Criterios de Aceptación (Gherkin en Español)

```gherkin
# language: es
Característica: Gestión de imágenes Docker
  Como desarrollador de software
  Quiero ver, descargar, inspeccionar y eliminar las imágenes de mi host
  Para controlar el espacio que ocupan y lanzar contenedores sin descargas redundantes

  Antecedentes:
    Dado que el servidor backend de DockPilot está en ejecución
    Y la conexión al socket de Docker está establecida

  Escenario: Inventario de imágenes locales
    Dado que el host tiene las imágenes "nginx:alpine" y "redis:7"
    Y la imagen "redis:7" la usa un contenedor en ejecución
    Cuando el usuario abre la vista "Imágenes"
    Entonces el sistema responde con código HTTP 200 al solicitar "GET /api/v1/images/local"
    Y devuelve una entrada por cada imagen con los campos "id", "tags", "size" y "created"
    Y la imagen "redis:7" informa "containers" mayor que 0
    Y la imagen "nginx:alpine" informa "containers" igual a 0
    Y el tamaño se muestra formateado en unidades legibles

  Escenario: Escribir una referencia no dispara ninguna descarga
    Dado que el modal de descarga de imagen está abierto
    Cuando el usuario escribe "alpine" carácter a carácter
    Entonces no se abre ninguna conexión WebSocket de descarga
    Y el texto puede seguir editándose libremente

  Escenario: Búsqueda de alternativas y elección por el usuario
    Dado que el modal de descarga de imagen está abierto
    Y el usuario ha escrito "nginx"
    Cuando el usuario pulsa el botón "Buscar"
    Entonces el sistema responde con código 200 a "GET /api/v1/images/search?term=nginx"
    Y se listan las alternativas encontradas con su nombre y su descripción
    Y las imágenes que ya están en local se señalan como disponibles
    Y todavía no se ha iniciado ninguna descarga

  Escenario: Descarga de la alternativa elegida
    Dado que el modal muestra las alternativas de la búsqueda
    Y el usuario elige la alternativa "nginx"
    Entonces se abre una conexión WebSocket a "/ws/images/pull?image=nginx:latest"
    Y el servidor emite un mensaje de tipo "start" con la referencia "nginx:latest"
    Y a continuación emite mensajes de tipo "layer" con el progreso de cada capa
    Y los mensajes incluyen el estado de la capa y los bytes descargados cuando el daemon los informa
    Y al finalizar el stream el servidor emite un mensaje de tipo "done"
    Y la acción principal del modal pasa de "Cancelar" a "Cerrar", porque ya no hay descarga que cancelar

  Escenario: Inspección del detalle de una imagen
    Dado que existe la imagen local "nginx:alpine"
    Cuando el usuario solicita "GET /api/v1/images/nginx:alpine"
    Entonces el sistema responde con código HTTP 200
    Y la respuesta incluye "architecture", "os" y "layer_count"
    Y la respuesta incluye la configuración con "entrypoint", "cmd" y "env"
    Y la respuesta incluye el historial de capas con "created_by" y "size"

  Escenario: Borrado de una imagen no utilizada
    Dado que existe la imagen "nginx:alpine" que no usa ningún contenedor
    Cuando el usuario solicita "DELETE /api/v1/images/nginx:alpine"
    Entonces el sistema responde con código HTTP 200
    Y la respuesta indica "deleted" en true
    Y la imagen deja de aparecer en el inventario local

  Escenario: Borrado de una imagen en uso
    Dado que existe la imagen "redis:7" usada por un contenedor en ejecución
    Cuando el usuario solicita "DELETE /api/v1/images/redis:7" sin forzar
    Entonces el sistema responde con código HTTP 409
    Y el cuerpo del error indica que la imagen está en uso
    Y cuando el usuario reintenta con "force=true"
    Entonces el sistema responde con código HTTP 200

  Escenario: Inspección o borrado de una imagen inexistente
    Dado que no existe ninguna imagen con identificador "sha256:inexistente"
    Cuando el usuario solicita "GET /api/v1/images/sha256:inexistente"
    Entonces el sistema responde con código HTTP 404
    Y cuando el usuario solicita "DELETE /api/v1/images/sha256:inexistente"
    Entonces el sistema responde con código HTTP 404

  Escenario: Descarga de un repositorio inexistente
    Dado que el registro no conoce el repositorio "no-existe-este-repo-xyz123"
    Cuando el cliente abre una conexión WebSocket a "/ws/images/pull?image=no-existe-este-repo-xyz123"
    Entonces el servidor emite un mensaje de tipo "error" con el código 404
    Y el mensaje incluye la causa devuelta por el daemon
    Y el WebSocket se cierra con el código 1000

  Escenario: Referencia de imagen malformada
    Dado que el usuario introduce una referencia con espacios como "nginx alpine"
    Cuando el cliente intenta abrir "/ws/images/pull?image=nginx%20alpine"
    Entonces el servidor responde con un mensaje de tipo "error" con el código 400
    Y no se realiza ninguna descarga

  Escenario: Cancelación de la descarga en curso
    Dado que el usuario tiene una descarga de imagen en progreso
    Cuando el usuario cierra el modal de descarga
    Entonces el frontend cierra el WebSocket
    Y el backend libera la descarga en el daemon sin dejar la conexión colgada
    Y el inventario local se refresca al reabrir la vista

  Escenario: Descartar la descarga al cambiar de intención
    Dado que el usuario tiene una descarga de imagen en progreso
    Cuando el usuario edita el texto de la referencia o pulsa "Buscar" de nuevo
    Entonces el frontend cierra el WebSocket de la descarga anterior
    Y el modal vuelve a la fase de búsqueda sin barras de progreso
    Y al elegir una alternativa nueva se abre un WebSocket nuevo

  Escenario: Los filtros de contenedores no se muestran en la vista de imágenes
    Dado que el usuario está en la pestaña "Contenedores"
    Y ve los filtros "Todos", "Activos", "Detenidos" y "Pausados" junto al buscador
    Cuando el usuario cambia a la pestaña "Imágenes"
    Entonces los filtros por estado de contenedor ya no son visibles
    Y el buscador de contenedores tampoco es visible
    Y al volver a la pestaña "Contenedores" ambos vuelven a estar disponibles

  Escenario: Filtrar el inventario de imágenes por tag
    Dado que el host tiene las imágenes "nginx:alpine", "redis:alpine" y "postgres:16-alpine"
    Cuando el usuario escribe "ngin" en el buscador de la vista "Imágenes"
    Entonces solo se listan las imágenes cuyo tag contiene "ngin"
    Y el contador muestra las coincidencias sobre el total
    Y al borrar el texto se vuelve a listar el inventario completo

  Escenario: Filtrar sin coincidencias
    Dado que el host tiene varias imágenes locales
    Y el usuario escribe un término que no coincide con ningún tag
    Entonces la vista muestra un estado vacío indicando que no hay coincidencias
    Y ese estado se distingue del de un host sin ninguna imagen

  Escenario: Lanzar un contenedor desde una imagen local
    Dado que el usuario visualiza el inventario de imágenes
    Cuando pulsa la acción "Ejecutar" sobre la imagen "nginx:alpine"
    Entonces se abre el modal de creación de contenedor
    Y el campo de imagen viene preseleccionado con "nginx:alpine"
```

---

## 5. Plan de Pruebas Automatizadas

### Backend (`pytest` + `pytest-asyncio` + `starlette.testclient`)
- `tests/test_images.py`:
  - `test_list_local_images_enriched`: verifica `containers` y `repo_digests`, y que se excluyen las imágenes `<none>:<none>`.
  - `test_image_detail_success`: `GET /{id}` por tag devuelve 200 con `architecture`, `layer_count` e historial.
  - `test_image_detail_not_found`: 404.
  - `test_image_detail_tolerates_history_failure`: si `history` falla, el detalle se sirve con `history` vacío.
  - `test_delete_image_success`: 200 con `deleted=true`.
  - `test_delete_image_conflict`: 409 sin `force`, 200 con `force=true`.
  - `test_delete_image_not_found`: 404.
  - `test_ws_pull_streams_progress`: recibe `start`, varios `layer` y un `done`.
  - `test_ws_pull_invalid_reference`: mensaje `error` con `code=400` y sin invocar a Docker.
  - `test_ws_pull_registry_error`: `DockerError(404)` del stream se traduce a `error` con `code=404` y cierre `1000`.
  - `test_ws_pull_close_releases_stream`: al cerrar el cliente, el generador se cierra.
- `tests/test_image_reference.py` (validación pura, sin Docker):
  - `test_valid_references`: `nginx`, `nginx:alpine`, `library/redis:7`, `ghcr.io/propietario/app:1.2`, digest válido.
  - `test_invalid_references`: vacío, con espacios, >255 chars, digest mal formado, caracteres no permitidos.
  - `test_reference_without_tag_defaults_to_latest`.

### Frontend (`vitest` + `@testing-library/react`)
- `tests/hooks/useImagePull.test.ts`:
  - Conexión, progreso acumulado por capa, transiciones de estado de capa, recepción de `digest` y `done`.
  - Mensaje `error`: propaga el mensaje y detiene el estado "descargando".
  - Cierre del socket al desmontar; sin reconexión automática (la descarga es una acción, no una suscripción).
- `tests/components/PullImageModal.test.tsx`:
  - Escribir una referencia **no** abre ningún WebSocket (el bug que motivó el cambio).
  - El botón `Buscar` consulta el endpoint de búsqueda y lista las alternativas.
  - Las alternativas ya presentes en local se señalan.
  - Elegir una alternativa abre el WebSocket con la referencia normalizada.
  - Confirmar la referencia escrita tal cual también inicia la descarga.
  - Editar el texto o pulsar `Buscar` de nuevo cancela la descarga en curso.
  - Barras por capa, porcentaje sin `NaN` cuando `total` es 0, error del backend y cierre por botón y Escape.
- `tests/components/ImagesTable.test.tsx`: renderizado de tags y tamaño, indicador "en uso", acciones por fila, y estados de carga/vacío/error.
- `tests/components/ImagesView.test.tsx`: el buscador filtra por tag sin distinguir mayúsculas y por ID, el contador refleja las coincidencias, el estado de "sin coincidencias" es distinto del de "host vacío", y al borrar el texto se restaura el inventario.
- `tests/components/ImageDetailModal.test.tsx`: bloques de metadatos y configuración, y tabla de historial.
- `tests/services/imageApi.test.ts`: `getLocalImages`, `getImage`, `deleteImage` (con `force`) y `isValidImageRef` reflejando el backend.

### Verificación manual
- Descargar una imagen de tamaño real (cientos de MB) y comprobar que las barras avanzan y que el total no muestra `NaN`.
- Intentar borrar una imagen en uso desde la interfaz y comprobar el camino de `409` → `force`.
- Coherencia visual de la vista de imágenes con el sistema de tokens de SPEC-06.

---

## 6. Plan de Tareas (Tasks)

- [x] **Fase 1: Contratos y Schemas**
  - [x] Extender `LocalImageSummary` con `containers` y `repo_digests` en `backend/app/schemas/image.py`
  - [x] Añadir `ImageDetail`, `ImageHistoryEntry`, `ImagePullMessage` e `ImageDeleteResponse`
  - [x] Crear `frontend/src/types/image.ts` con las interfaces equivalentes campo por campo
- [x] **Fase 2: Tests Primero en Backend (TDD)**
  - [x] Añadir `FakeDockerImages` a `backend/tests/conftest.py` con `list`/`inspect`/`history`/`delete` y un `pull(stream=True)` que emita los eventos reales del daemon
  - [x] Crear `backend/tests/test_image_reference.py` para la validación de la referencia
  - [x] Crear `backend/tests/test_images.py` con los casos de listado, detalle, borrado y WebSocket
  - [x] Ejecutar `pytest -v` y confirmar que falla por implementación ausente (fase roja)
- [x] **Fase 3: Implementación Backend**
  - [x] Implementar el validador de referencia de imagen en `backend/app/services/image_service.py`
  - [x] Enriquecer `list_local_images` con `containers` y `repo_digests`
  - [x] Implementar `get_image_detail` (inspect + history tolerante a fallo) y `delete_image` (mapeo de 404/409)
  - [x] Implementar `stream_pull` como generador asíncrono de `ImagePullMessage` con el mapeo de estados de §3.4
  - [x] Registrar `GET /{id}` y `DELETE /{id}` en `backend/app/api/v1/images.py`
  - [x] Implementar el WebSocket `/ws/images/pull` en `backend/app/api/v1/ws.py` con validación previa, `error` por `DockerError` y cierre `1000`
  - [x] Ejecutar `pytest -v` y validar aprobación al 100%
- [x] **Fase 4: Tests Primero en Frontend**
  - [x] Crear `frontend/tests/hooks/useImagePull.test.ts`
  - [x] Crear `frontend/tests/components/PullImageModal.test.tsx`
  - [x] Crear `frontend/tests/components/ImagesTable.test.tsx`
  - [x] Crear `frontend/tests/components/ImageDetailModal.test.tsx`
  - [x] Crear `frontend/tests/services/imageApi.test.ts`
- [x] **Fase 5: Implementación Frontend**
  - [x] Completar `frontend/src/services/dockerApi.ts` con `getImage`, `deleteImage` e `isValidImageRef`
  - [x] Implementar `frontend/src/hooks/useImagePull.ts` con el WebSocket y el estado por capa
  - [x] Crear `frontend/src/components/images/PullImageModal.tsx` con flujo de dos fases (búsqueda de alternativas y elección) y barras de progreso por capa
  - [x] Crear `frontend/src/components/images/ImageDetailModal.tsx` con metadatos, configuración e historial
  - [x] Crear `frontend/src/components/images/ImagesTable.tsx` con el inventario y sus acciones
  - [x] Añadir el buscador de imágenes en `ImagesView` con filtrado en cliente por tag e ID, y estado vacío de "sin coincidencias"
  - [x] Ampliar `DeleteConfirmModal` a un descriptor genérico conservando el comportamiento actual de contenedores
  - [x] Añadir el conmutador de vista `Contenedores | Imágenes` en `frontend/src/App.tsx` y conectar "Ejecutar" con `CreateContainerModal`
  - [x] Reubicar el toolbar de contenedores (filtros por estado y buscador) dentro de la pestaña `Contenedores`, con test de regresión en `frontend/tests/App.test.tsx`
- [x] **Fase 6: Verificación y Quality Gates**
  - [x] Ejecutar y aprobar la suite backend (`PYTHONPATH=. pytest -v`)
  - [x] Ejecutar y aprobar la suite frontend (`pnpm run test`)
  - [x] Ejecutar `pnpm run lint` (Oxlint) y `pnpm run build` (`tsc -b && vite build`)
  - [x] Verificar que el lint del backend sigue sin errores (`make backend-lint`)
  - [x] Probar el buscador de imágenes con el inventario real del host (tags con registro, digest y punto: `keycloak`, `elastic`, `alpine`, `ghcr`, `9.1.3`)
  - [x] Regresión: escribir una referencia no abre ningún WebSocket (el input no dispara descargas; solo el botón `Buscar` o la elección de una alternativa)
  - [x] Comprobar que el test de arquitectura de tokens sigue pasando (no introducir literales de color)
  - [x] Validar una descarga real de imagen de tamaño considerable y comprobar las barras
  - [x] Actualizar `agent.md` (árbol de directorios con `components/images/`, `types/image.ts`, `tests/test_images.py`) y marcar todas las tareas como completadas (`[x]`)
