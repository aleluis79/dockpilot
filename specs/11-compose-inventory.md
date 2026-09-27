# SPEC-11: Inventario de Proyectos Docker Compose

## 1. Contexto y Objetivos
- **Problema**: DockPilot muestra contenedores, imágenes, volúmenes y redes como listas planas, sin ninguna señal de cuáles forman parte de un proyecto de Docker Compose. Un contenedor de `docker compose up` y uno creado a mano desde el panel son indistinguibles. En el host de referencia hay **3 proyectos compose** y **2 de ellos están huérfanos**: `simp-sica` y `tickets-app` conservan 7 volúmenes en total y **cero contenedores**. Ese espacio ocupado no aparece en ninguna vista y no hay forma de saber de qué proyecto viene ni de que se puede limpiar. La causa estructural es que el panel solo conoce el Engine API resource por resource, y la noción de "proyecto" no existe en ese API: es una convención de labels.
- **Objetivo**: Añadir una sexta pestaña `Proyectos` que agrupe contenedores, redes y volúmenes por proyecto compose, señale los proyectos huérfanos y permita saltar a la vista que los_cleanup. Enriquecer además las tres vistas existentes con el proyecto al que pertenece cada recurso, para que la correlación se vea sin cambiar de pestaña.
- **Alcance**:
  - Incluye:
    - Lectura de las labels `com.docker.compose.*` de contenedores, redes y volúmenes, y agrupación por `com.docker.compose.project`.
    - Endpoints REST `GET /api/v1/compose/projects` y `GET /api/v1/compose/projects/{name}`.
    - Sexta pestaña `Proyectos` con el inventario, un indicador de proyecto huérfano y un modal de detalle con servicios, redes y volúmenes.
    - Campo `compose_project` en los resúmenes de contenedor, red y volumen, y su correspondiente insignia en las tres tablas existentes.
    - Recuento de recursos **no** gestionados por compose, que es el dato que responde "¿qué hay aquí que no es de ningún proyecto?".
  - No incluye (en esta spec):
    - **Leer o ejecutar un archivo compose.** La ruta del archivo se muestra como dato pero no se abre. Eso es SPEC-12.
    - **Cualquier acción sobre un proyecto** (arrancar, parar, borrar, actualizar). Esta spec es de lectura pura y su superficie de escritura es cero. Eso es SPEC-13.
    - **Descubrir proyectos que solo existen como archivo en disco.** Un YAML sin `up` ejecutado no ha creado nada y no deja labels: no hay nada que inventariar. Encontrarlos exige leer el disco, que es SPEC-12.
    - **Recuperar o reconstruir un proyecto a partir de sus labels.** Las labels no guardan el YAML, solo su hash (`config-hash`): el archivo original no se puede regenerar.
    - Limpieza de imágenes asociadas a proyectos. SPEC-07.

---

## 2. Contrato de Datos (Schemas & Types)

### 2.1 Backend (Pydantic v2) - `app/schemas/compose.py`

```python
from typing import Optional
from pydantic import BaseModel, Field

# --- Recursos de un proyecto, para el detalle ---

class ComposeService(BaseModel):
    """Un servicio del proyecto, con los contenedores que lo materializan."""
    name: str = Field(..., description="Valor de com.docker.compose.service")
    image: str = Field("", description="Etiqueta com.docker.compose.image; vacío si no está")
    container_names: list[str] = Field(default_factory=list)
    container_ids: list[str] = Field(default_factory=list)
    replicas: int = Field(0, description="Contenedores del servicio, includedo container-number")
    running: int = 0

class ComposeNetwork(BaseModel):
    """Red declarada por el proyecto.

    `logical_name` es la clave dentro del archivo compose; `name` es el nombre
    real en Docker, que compose prefija con el proyecto. No son lo mismo.
    """
    logical_name: str = Field("", description="Valor de com.docker.compose.network")
    name: str = Field(..., description="Nombre real de la red en Docker")
    driver: str = "bridge"

class ComposeVolume(BaseModel):
    """Volumen declarado por el proyecto. Misma dualidad de nombres que la red."""
    logical_name: str = Field("", description="Valor de com.docker.compose.volume")
    name: str = Field(..., description="Nombre real del volumen en Docker")
    driver: str = "local"

# --- Vista de listado ---

class ComposeProjectSummary(BaseModel):
    """Fila del inventario: lo justo para ordenar y decidir sin abrir nada."""
    name: str = Field(..., description="Valor de com.docker.compose.project")
    services_count: int = 0
    containers_total: int = 0
    containers_running: int = 0
    networks_count: int = 0
    volumes_count: int = 0
    config_files: list[str] = Field(default_factory=list)
    working_dir: str = ""
    compose_version: str = ""
    orphaned: bool = Field(
        False,
        description="Sin contenedores pero con red o volúmenes: conserva recursos del proyecto",
    )

# --- Vista de detalle ---

class ComposeProjectDetail(ComposeProjectSummary):
    """Resumen más el desglose de servicios, redes y volúmenes."""
    services: list[ComposeService] = Field(default_factory=list)
    networks: list[ComposeNetwork] = Field(default_factory=list)
    volumes: list[ComposeVolume] = Field(default_factory=list)

# --- Payload único ---

class ComposeOverview(BaseModel):
    """Inventario completo, para la pestaña y sus contadores."""
    projects: list[ComposeProjectSummary] = Field(default_factory=list)
    total_projects: int = 0
    running_projects: int = Field(
        0, description="Proyectos con al menos un contenedor en ejecución"
    )
    orphaned_projects: int = 0
    unlabelled_containers: int = Field(
        0,
        description="Contenedores sin com.docker.compose.project: los gestiona DockPilot o a mano",
    )
    unlabelled_networks: int = 0
    unlabelled_volumes: int = 0
```

### 2.2 Frontend (TypeScript) - `src/types/compose.ts`

```typescript
export interface ComposeService {
  name: string;
  image: string;
  container_names: string[];
  container_ids: string[];
  replicas: number;
  running: number;
}

export interface ComposeNetwork {
  logical_name: string;
  name: string;
  driver: string;
}

export interface ComposeVolume {
  logical_name: string;
  name: string;
  driver: string;
}

export interface ComposeProjectSummary {
  name: string;
  services_count: number;
  containers_total: number;
  containers_running: number;
  networks_count: number;
  volumes_count: number;
  config_files: string[];
  working_dir: string;
  compose_version: string;
  orphaned: boolean;
}

export interface ComposeProjectDetail extends ComposeProjectSummary {
  services: ComposeService[];
  networks: ComposeNetwork[];
  volumes: ComposeVolume[];
}

export interface ComposeOverview {
  projects: ComposeProjectSummary[];
  total_projects: number;
  running_projects: number;
  orphaned_projects: number;
  unlabelled_containers: number;
  unlabelled_networks: number;
  unlabelled_volumes: number;
}

/** Filtro de la pestaña `Proyectos`, análogo a los de Imágenes y Volúmenes. */
export type ComposeProjectFilter = 'all' | 'running' | 'orphaned';
```

### 2.3 Extensión de contratos existentes

Para la insignia, tres resúmenes reciben un campo opcional. Es un cambio de contrato sobre schemas de SPEC-01, SPEC-08 y SPEC-10, y por tanto **aditivo y opcional**: si la label no está, el campo es `null` y la insignia no se pinta.

| Fichero | Campo añadido |
| :--- | :--- |
| `app/schemas/container.py` → `ContainerSummary` | `compose_project: Optional[str] = None` |
| `app/schemas/network.py` → `NetworkSummary` | `compose_project: Optional[str] = None` |
| `app/schemas/volume.py` → `VolumeSummary` | `compose_project: Optional[str] = None` |

Y sus equivalentes en `src/types/docker.ts`, `src/types/network.ts` y `src/types/volume.ts`.

---

## 3. Mecánica

### 3.1 Las labels son la única fuente, y por qué es suficiente

El Engine API no tiene noción de proyecto compose: un proyecto es exclusivamente una convención de labels. El conjunto completo, **verificado contra el daemon de referencia**, es:

| Label | En | Significado |
| :--- | :--- | :--- |
| `com.docker.compose.project` | contenedores, redes, volúmenes | Nombre del proyecto. Es la única clave de agrupación. |
| `com.docker.compose.service` | contenedores | Nombre del servicio dentro del proyecto |
| `com.docker.compose.container-number` | contenedores | Réplica: `1`, `2`, `3`… Un servicio con réplicas tiene varios contenedores. |
| `com.docker.compose.oneoff` | contenedores | `"True"` para contenedores de un solo uso (`docker compose run`) |
| `com.docker.compose.image` | contenedores | Digest o referencia de imagen que se usó |
| `com.docker.compose.project.config_files` | contenedores | Rutas de los archivos compose, **separadas por coma** |
| `com.docker.compose.project.working_dir` | contenedores | Directorio de trabajo del proyecto |
| `com.docker.compose.version` | los tres | Versión de compose que lo creó |
| `com.docker.compose.config-hash` | los tres | Hash de la configuración. **No permite recuperar el YAML.** |
| `com.docker.compose.network` | redes | Nombre **lógico** de la red dentro del archivo |
| `com.docker.compose.volume` | volúmenes | Nombre **lógico** del volumen dentro del archivo |

### 3.2 Cuatro trampas del daemon, comprobadas una a una

1. **`/volumes` devuelve `Labels: null`, no `{}`.** Es el único de los tres listados que lo hace: `/networks` y `/containers/json` devuelven `Labels: {}`. Leerlo con `entry["Labels"].items()` revienta con `AttributeError` en cuanto hay un volumen sin etiquetar, y en el host de referencia ya hay uno (`test_volume_67dc933e`). SPEC-08 ya resolvió esto con `_clean_labels()` en `app/services/volume_service.py:36`; esta spec **reutiliza ese helper** y no escribe un segundo normalizador. `/containers/json` incluye el contenedor `Names` con barra inicial (`/elasticsearch`): hay que quitar esa barra antes de mostrarlo o compararlo.

2. **Tener labels no significa ser de compose.** Los volúmenes anónimos llevan `com.docker.volume.anonymous` y ningún `com.docker.compose.project`. Agrupar por "tiene labels" metería 6 volúmenes de caché de compilación en un proyecto inventado. La agrupación es por la clave `com.docker.compose.project` **exactamente presente**, y el resto va al contador `unlabelled_*`.

3. **El nombre real lleva prefijo; la label no.** En el host de referencia el archivo declara `networks: { elastic: { driver: bridge } }` y `volumes: { elasticsearch_data: {} }`, pero en Docker se llaman `elasticsearch-local_elastic` y `elasticsearch-local_elasticsearch_data`. La label `com.docker.compose.network` vale `elastic`. Por eso `ComposeNetwork` y `ComposeVolume` llevan **dos** nombres: `logical_name` (lo que dice el archivo) y `name` (lo que acepta `docker network inspect`). Mostrar solo uno de los dos lleva a error en cuanto el usuario copia el nombre para una terminal.

4. **`docker compose ls` no sirve, y por eso esto no es un envoltorio de un comando.** En el host de referencia `docker compose ls --format json` devuelve **un solo proyecto** (`elasticsearch-local`, el único con contenedores corriendo) y omite `simp-sica` y `tickets-app`, que son exactamente los huérfanos que hay que detectar. El inventario se construye leyendo los tres listados del Engine API, que sí los ven.

### 3.3 Construcción del inventario

Tres llamadas, ninguna más:

```text
GET /containers/json?all=1   -> contenedores, grouped por project+service
GET /networks                 -> redes,     grouped por project
GET /volumes                 -> volúmenes, grouped por project
```

No hace falta unirse a `/system/df`: el desglose por proyecto es de **recuento**, no de tamaño, así que se evita la llamada extra que SPEC-08 sí necesita. El coste son 3 peticiones al daemon en cada carga de la pestaña, y solo cuando la pestaña está montada.

Orden de salida: primero los proyectos con contenedores en ejecución, después los huérfanos, y dentro de cada grupo por nombre. Un inventario cuyo orden cambia en cada recarga es imposible de escanear.

`orphaned` es `containers_total == 0 and (networks_count + volumes_count) > 0`. Un proyecto con cero recursos no puede existir: si no tiene nada, no se crea entrada. Y un proyecto con contenedores detenidos pero vivos **no** es huérfano: tiene recursos que puede querer recuperar arrancándolo.

### 3.4 Endpoints REST

| Método | Endpoint | Respuesta | Errores |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/compose/projects` | `200 OK` (`ComposeOverview`) | `503` daemon no disponible |
| `GET` | `/api/v1/compose/projects/{name}` | `200 OK` (`ComposeProjectDetail`) | `404` proyecto sin recursos etiquetados, `503` daemon no disponible |

Se ofrecen los dos, y no un `?detail=`, por el mismo motivo que en SPEC-08 y SPEC-10: el listado se pinta entero en la tabla y el detalle solo al abrir un modal, así que descargar redes, volúmenes y la lista de contenedores de cada proyecto para luego no mostrarlos es trabajo de sobra en cada recarga de la tabla.

`{name}` va en el path y no en query porque es un identificador, no un filtro. Se decodifica con `unquote` porque los nombres de proyecto admiten caracteres que `encodeURIComponent` escapa.

### 3.5 Superficie de usuario

- **Pestaña `Proyectos`**: sexta del conmutador, con contador. Tabla con proyecto, servicios, contenedores (corriendo/total), redes, volúmenes, versión de compose, archivo de configuración y una insignia `Huerfano` en ámbar. Filtros `Todos` / `En ejecución` / `Huerfanos` y búsqueda por nombre, alineados con SPEC-08.
- **Modal de detalle**: servicios con sus contenedores y su estado, redes con el par nombre lógico → nombre real, volúmenes igual, y el directorio de trabajo. Un enlace `Ver contenedores` lleva a la pestaña de contenedores; es navegación, no acción.
- **Insignias en las vistas existentes**: una columna `Proyecto` en las tablas de contenedores, redes y volúmenes, que **solo se pinta si el recurso es de un proyecto**. Una columna vacía en el 100% de las filas es ruido.
- Los datos se piden al montar la pestaña, sin sondeo automático, y con botón de refresco por el mismo motivo que en SPEC-09: el estado de un proyecto cambia por acción del usuario, no por tiempo.

### 3.6 Notas de aiodocker 0.27.0 (verificadas)

- `docker.containers.list(all=True)`, `docker.networks.list()` y `docker.volumes.list()` exponen `Labels` en los tres casos. No hace falta `_query_json` ni ningún endpoint crudo, al contrario que con `/system/df` en SPEC-08/09.
- **`containers.list()` devuelve objetos `DockerContainer`, no dicts**, y las etiquetas viven en su atributo `_container`. `networks.list()` sí devuelve dicts y `volumes.list()` un dict con clave `Volumes`: solo los contenedores necesitan desenvolverse. Leer `info.get("Labels")` sobre el objeto sin desenvolver devuelve nada y el inventario sale **vacío sin dar ningún error**, que es el peor síntoma posible. El doble de `conftest.py` devuelve dicts, así que hace falta un test que fije la forma real o el fallo reaparece con el siguiente que escriba sobre él.
- `docker.volumes.list()` devuelve un `dict` con clave `Volumes` y no una lista. SPEC-08 ya lo documentó; se reutiliza su forma de leerlo.
- Los networks y containers traen `Name`/`Names`; los volumes traen `Name`. No hay `Id` en el listado de volúmenes, así que la identidad de un volumen es su nombre.

---

## 4. Criterios de Aceptación (Gherkin en Español)

```gherkin
# language: es
Característica: Inventario de proyectos Docker Compose
  Como usuario de DockPilot
  Quiero ver qué proyectos de Docker Compose existen en mi host
  Para saber qué ocupa espacio y qué se puede limpiar

  Antecedentes:
    Dado que el servidor backend de DockPilot está en ejecución
    Y la conexión al socket de Docker está establecida

  Escenario: Los proyectos se agrupan por su label de proyecto
    Dado que hay un contenedor con la label "com.docker.compose.project" igual a "tickets-app"
    Y un volumen con esa misma label
    Cuando el usuario solicita "GET /api/v1/compose/projects"
    Entonces el sistema responde con código HTTP 200
    Y la respuesta incluye un proyecto llamado "tickets-app"
    Y ese proyecto declara un volumen y ningún contenedor

  Escenario: Un proyecto sin contenedores pero con recursos se marca huérfano
    Dado que el proyecto "simp-sica" tiene tres volúmenes y ningún contenedor
    Cuando el usuario solicita "GET /api/v1/compose/projects"
    Entonces el proyecto "simp-sica" viene con "orphaned" igual a true
    Y el contador "orphaned_projects" refleja ese proyecto

  Escenario: Un proyecto con contenedores detenidos no es huérfano
    Dado que el proyecto "web" tiene un contenedor en estado "exited" y ninguna red
    Cuando el usuario consulta el inventario
    Entonces ese proyecto viene con "orphaned" igual a false

  Escenario: Los recursos sin proyecto no se inventarian como proyectos
    Dado que hay un contenedor sin la label "com.docker.compose.project"
    Cuando el usuario consulta el inventario
    Entonces ese contenedor no aparece en ningún proyecto
    Y el contador "unlabelled_containers" es mayor o igual que uno

  Escenario: Un volumen con labels pero sin proyecto no se agrupa
    Dado que un volumen tiene la label "com.docker.volume.anonymous" y ningún proyecto
    Cuando el usuario consulta el inventario
    Entonces ese volumen no aparece en ningún proyecto
    Y el contador "unlabelled_volumes" aumenta

  Escenario: Un volumen sin labels no rompe el inventario
    Dado que el listado de volúmenes devuelve "Labels" con valor nulo en una entrada
    Cuando el usuario consulta el inventario
    Entonces el sistema responde con código HTTP 200
    Y esa entrada cuenta como volumen sin proyecto

  Escenario: Los nombres reales llevan el prefijo del proyecto
    Dado que un volumen tiene la label "com.docker.compose.volume" igual a "postgres_data"
    Y el nombre real del volumen es "tickets-app_postgres_data"
    Cuando el usuario solicita "GET /api/v1/compose/projects/tickets-app"
    Entonces el detalle declara el volumen con nombre lógico "postgres_data"
    Y con nombre real "tickets-app_postgres_data"

  Escenario: Las réplicas de un servicio se agrupan bajo el mismo servicio
    Dado que hay tres contenedores con "com.docker.compose.service" igual a "api"
    Y con "com.docker.compose.container-number" igual a "1", "2" y "3"
    Cuando el usuario solicita el detalle del proyecto
    Entonces el servicio "api" declara tres réplicas
    Y tres nombres de contenedor

  Escenario: La ruta del archivo compose se informa pero no se lee
    Dado que un contenedor tiene la label "com.docker.compose.project.config_files"
    Cuando el usuario consulta el detalle del proyecto
    Entonces la respuesta incluye la ruta del archivo de configuración
    Y la respuesta no incluye el contenido de ese archivo

  Escenario: Proyecto inexistente
    Dado que no hay ningún recurso con la label de proyecto "no-existe"
    Cuando el usuario solicita "GET /api/v1/compose/projects/no-existe"
    Entonces el sistema responde con código 404
    Y el cuerpo de la respuesta contiene un mensaje de error descriptivo

  Escenario: Daemon no disponible
    Dado que el daemon de Docker no responde
    Cuando el usuario solicita "GET /api/v1/compose/projects"
    Entonces el sistema responde con código 503
    Y el cuerpo de la respuesta contiene un mensaje de error descriptivo

  Escenario: La insignia solo aparece en recursos de un proyecto
    Dado que un contenedor no tiene label de proyecto y otro sí
    Cuando el usuario abre la tabla de contenedores
    Entonces la fila del contenedor que pertenece a un proyecto muestra su insignia
    Y la fila del contenedor sin proyecto no muestra columna de proyecto
```

---

## 5. Plan de Pruebas Automatizadas

### Backend (`pytest` + `pytest-asyncio`)
- `tests/test_compose.py`:
  - `test_agrupa_recursos_por_proyecto`: contenedores, red y volumen con la misma etiqueta `project` caen en la misma entrada.
  - `test_proyecto_sin_contenedores_queda_orphaned`: recursos sin contenedores y con red o volúmenes → `orphaned=True`.
  - `test_proyecto_con_contenedores_detenidos_no_es_orphaned`: un contenedor `exited` hace que `orphaned=False`.
  - `test_proyecto_sin_recursos_no_aparece`: una etiqueta de proyecto que no aparece en ningún recurso no genera entrada.
  - `test_recurso_sin_project_label_no_se_agrupa`: un contenedor con otras labels pero sin `project` va a `unlabelled_containers`.
  - `test_volumen_anonymous_no_se_agrupa`: labels `com.docker.volume.anonymous` sin `project` no crean proyecto.
  - `test_labels_nulos_no_rompen_el_inventario`: `Labels: None` en `/volumes` y `Labels: {}` en `/networks` y `/containers/json` se normalizan igual.
  - `test_nombre_logico_y_real_de_red_y_volumen`: la label da el nombre lógico y el listado da el real, y no se confunden.
  - `test_replicas_se_agrupan_por_servicio`: tres `container-number` distintos producen un servicio con `replicas=3`.
  - `test_quita_la_barra_inicial_de_los_nombres_de_contenedor`: `Names: ["/web"]` produce `web`.
  - `test_config_files_se_separa_por_coma`: dos rutas en la label producen dos entradas.
  - `test_orden_proyectos_running_antes_que_huerfanos`: el inventario ordena primero los que tienen contenedores en ejecución.
  - `test_usa_una_sola_llamada_por_tipo_de_recurso`: se verifica que no se llama a `/system/df` ni se repite ningún listado.
  - `test_acepta_contenedores_como_objetos_de_aiodocker`: `containers.list()` devuelve objetos `DockerContainer` y no dicts. El doble base devuelve dicts, así que sin este test el servicio parece correcto y contra el daemon real devuelve un inventario vacío (§3.6).
  - `test_proyecto_no_encontrado_devuelve_404`: nombre sin recursos etiquetados.
  - `test_compose_projects_daemon_unavailable`: 503 cuando el daemon falla.

- Doble de `aiodocker` en `tests/conftest.py`: un `FakeDockerCompose` que sirva contenedores, redes y volúmenes con las labels del host de referencia, incluyendo el caso `Labels: None` y el `Names: ["/..."]`.

### Frontend (`vitest` + `@testing-library/react`)
- `tests/components/compose/ProjectsView.test.tsx`: la tabla lista los proyectos con sus contadores, la insignia `Huerfano` aparece solo en los que lo son, y los filtros `Todos` / `En ejecución` / `Huerfanos` y la búsqueda por nombre acotan el listado.
- `tests/components/compose/ProjectsTable.test.tsx`: el orden de la tabla y el formato de los recuentos `corriendo/total`.
- `tests/components/compose/ProjectDetailModal.test.tsx`: los servicios con sus réplicas, el par nombre lógico → nombre real de redes y volúmenes, y el enlace `Ver contenedores` llama a `onNavigateTab('containers')`.
- `tests/components/compose/ComposeBadge.test.tsx`: la insignia muestra el nombre del proyecto y **no se pinta nada** cuando `compose_project` es `null`.
- `tests/components/ContainersTable.test.tsx` (ampliar): la columna `Proyecto` aparece en las filas con proyecto y no en las demás.
- `tests/services/composeApi.test.ts`: los dos endpoints y la propagación del mensaje de error.
- `tests/hooks/useComposeProjects.test.ts`: carga, estado de error y refresco.

### Verificación manual
- [x] Contrastar el inventario con `docker ps -a --filter label=com.docker.compose.project` y con
  `docker volume ls --filter label=com.docker.compose.project` en una terminal: deben coincidir los
  tres proyectos y sus recuentos.
- [x] Comprobar que `simp-sica` y `tickets-app` aparecen como huérfanos con sus 7 volúmenes, y que
  `docker compose ls` **no** los muestra: es la razón de que el inventario no se apoye en ese comando.
- [x] Comprobar en el navegador que la insignia de proyecto aparece en la tabla de contenedores de
  `elasticsearch` y `elasticvue`, y no en `full-editor-db`.

> Ejecutado contra el daemon real durante la implementación. Resultado: 3 proyectos, 1 en
> ejecución, 2 huérfanos, 1 contenedor / 3 redes / 7 volúmenes sin proyecto, y los pares
> `elastic` → `elasticsearch-local_elastic` y `elasticsearch_data` →
> `elasticsearch-local_elasticsearch_data` correctos.

---

## 6. Plan de Tareas (Tasks)

- [x] **Fase 1: Contratos**
  - [x] Crear `backend/app/schemas/compose.py` con `ComposeService`, `ComposeNetwork`, `ComposeVolume`, `ComposeProjectSummary`, `ComposeProjectDetail` y `ComposeOverview`
  - [x] Añadir `compose_project` opcional a `ContainerSummary`, `NetworkSummary` y `VolumeSummary` en sus schemas
  - [x] Crear `frontend/src/types/compose.ts` con las interfaces equivalentes campo por campo
  - [x] Añadir `compose_project` opcional a los tipos de `docker.ts`, `network.ts` y `volume.ts`
- [x] **Fase 2: Tests Primero en Backend (TDD)**
  - [x] Añadir a `backend/tests/conftest.py` un doble que sirva los tres listados con labels, incluido `Labels: None` y `Names: ["/..."]`
  - [x] Crear `backend/tests/test_compose.py` con los casos de la sección 5
  - [x] Ejecutar `pytest -v` y confirmar que falla por implementación ausente (fase roja)
- [x] **Fase 3: Implementación Backend**
  - [x] Implementar `list_projects` y `get_project` en `app/services/compose_service.py`, reutilizando `_clean_labels` de `volume_service`
  - [x] Calcular `orphaned`, los contadores `unlabelled_*` y el orden de salida
  - [x] Poblar `compose_project` en los servicios de contenedores, redes y volúmenes sin alterar su comportamiento actual
  - [x] Registrar los endpoints en `app/api/v1/compose.py` e incluirlo en `api/router.py`
  - [x] Ejecutar `pytest -v` y validar aprobación al 100%
- [x] **Fase 4: Tests Primero en Frontend**
  - [x] Crear `frontend/tests/services/composeApi.test.ts` y `frontend/tests/hooks/useComposeProjects.test.ts`
  - [x] Crear `frontend/tests/components/compose/ProjectsView.test.tsx`, `ProjectsTable.test.tsx` y `ProjectDetailModal.test.tsx`
  - [x] Crear `frontend/tests/components/compose/ComposeBadge.test.tsx` y ampliar `ContainersTable.test.tsx`
  - [x] Ejecutar `vitest` y confirmar que los casos nuevos fallan por implementación ausente (fase roja)
- [x] **Fase 5: Implementación Frontend**
  - [x] Añadir `listComposeProjects` y `getComposeProject` a `frontend/src/services/dockerApi.ts`
  - [x] Crear `frontend/src/hooks/useComposeProjects.ts` con carga, error y refresco
  - [x] Implementar `ProjectsView.tsx` con los filtros, la búsqueda y el botón de refresco
  - [x] Implementar `ProjectsTable.tsx` e `ProjectDetailModal.tsx`
  - [x] Implementar `ComposeBadge.tsx` y añadir la columna `Proyecto` a las tablas de contenedores, redes y volúmenes
  - [x] Registrar la sexta pestaña en `App.tsx`, con su contador y el enlace de navegación del modal
  - [x] Ejecutar `vitest` y validar aprobación al 100%
- [x] **Fase 6: Verificación y Quality Gates**
  - [x] Ejecutar y aprobar la suite backend (`make backend-test`) y el lint (`make backend-lint`)
  - [x] Ejecutar y aprobar la suite frontend (`pnpm run test`, `pnpm run lint`, `pnpm run build`)
  - [x] Contrastar el inventario contra el daemon real en una terminal
  - [x] Actualizar `agent.md` (árboles, `specs/11-compose-inventory.md`) y marcar las tareas como completadas (`[x]`)
