# SPEC-09: Resumen del Host (Información de Docker y Consumo de Disco)

## 1. Contexto y Objetivos
- **Problema**: DockPilot no ofrece ninguna visión de conjunto del host. El usuario ve sus contenedores e imágenes pero no sabe qué versión de Docker corre, con cuántos núcleos y cuánta memoria trabaja la máquina, ni cuánto disco consumen las imágenes, los contenedores y los volúmenes. Consecuencia práctica: cuando el disco se llena, el panel no ofrece ninguna pista de por qué ni de cuánto se puede recuperar. En el host de referencia, `/system/df` reporta **4.22 GB de imágenes recuperables** (el 83% de las imágenes) y **482 MB de volúmenes recuperables** (el 91%), y nada de eso es visible. Además, `app/api/v1/system.py` estaba previsto en el plan original de `agent.md` desde el principio y nunca se construyó.
- **Objetivo**: Añadir un resumen del host, presented as an always-visible header strip and expandable into a detail panel, answering three questions at a glance: **what machine am I on** (Docker, OS, CPU, RAM, driver), **how much space is it using** (images, containers, volumes, build cache) and **how much of that is reclaimable** (the `Reclaimable` figures, with links to the actions that free it).
- **Alcance**:
  - Incluye:
    - Endpoint REST `GET /api/v1/system/info` (datos de `/info` del daemon).
    - Endpoint REST `GET /api/v1/system/df` (consumo de disco de `/system/df`).
    - Franja de resumen siempre visible en la `Navbar` o bajo ella, con los datos esenciales del host y el espacio total.
    - Panel de detalle desplegable con el desglose por tipo de recurso, los mayores consumidores de espacio y los enlaces a las acciones que liberan espacio.
    - Indicador de si el daemon responde y de la versión, porque es la causa más frecuente de "no me carga nada".
  - No incluye (en esta spec):
    - **Acciones de limpieza.** Esta spec solo **informa** y **enlaza** a las pantallas que ya limpian (SPEC-07 para imágenes, SPEC-08 para volúmenes). Ejecutar `image prune` o `volume prune` desde aquí mezclaría lectura con acción destructiva y duplicaría los diálogos de confirmación que ya existen.
    - Historial o tendencias: no se guarda nada entre recargas, en línea con el enfoque "en vivo y local" del proyecto.
    - Métricas de CPU o RAM **en uso** (las sostiene SPEC-04 por contenedor). Aquí solo interesa la **capacidad total** de la máquina.
    - Información de Swarm, ACKs o nodos: el proyecto es de un solo host local y no gestiona clústeres.

---

## 2. Contrato de Datos (Schemas & Types)

### 2.1 Backend (Pydantic v2) - `app/schemas/system.py`

```python
from pydantic import BaseModel, Field

class SystemInfo(BaseModel):
    server_version: str = Field("", description="Versión del Docker Engine, p. ej. 29.8.1")
    os_name: str = Field("", description="Sistema operativo del host")
    os_type: str = "linux"
    architecture: str = ""
    kernel_version: str = ""
    hostname: str = ""
    ncpu: int = Field(0, description="Núcleos lógicos")
    memory_total: int = Field(0, description="Memoria RAM total en bytes")
    storage_driver: str = Field("", description="Driver de almacenamiento, p. ej. overlayfs")
    docker_root_dir: str = Field("", description="Ruta de la raíz de Docker en el host")
    containers_total: int = 0
    containers_running: int = 0
    containers_stopped: int = 0
    containers_paused: int = 0
    images_total: int = 0

class ResourceUsage(BaseModel):
    """Uso y recuperabilidad de un tipo de recurso."""
    total_count: int = 0
    active_count: int = 0
    total_size: int = Field(0, description="Tamaño total en bytes")
    reclaimable: int = Field(0, description="Bytes que el daemon considera recuperables")

class DiskUsage(BaseModel):
    layers_size: int = Field(0, description="Tamaño de las capas de imagen compartidas")
    images: ResourceUsage
    containers: ResourceUsage
    volumes: ResourceUsage
    build_cache_size: int = 0

class TopConsumer(BaseModel):
    """Mayor consumidor de espacio, para señalar dónde mirar."""
    kind: str = Field(..., description="'image' | 'container' | 'volume'")
    name: str
    size: int = 0
    detail: str = ""

class SystemOverview(BaseModel):
    """Payload único para la franja de resumen y su panel de detalle."""
    info: SystemInfo
    usage: DiskUsage
    top_images: list[TopConsumer] = Field(default_factory=list)
    top_volumes: list[TopConsumer] = Field(default_factory=list)
```

### 2.2 Frontend (TypeScript) - `src/types/system.ts`

```typescript
export interface SystemInfo {
  server_version: string;
  os_name: string;
  os_type: string;
  architecture: string;
  kernel_version: string;
  hostname: string;
  ncpu: number;
  memory_total: number;
  storage_driver: string;
  docker_root_dir: string;
  containers_total: number;
  containers_running: number;
  containers_stopped: number;
  containers_paused: number;
  images_total: number;
}

export interface ResourceUsage {
  total_count: number;
  active_count: number;
  total_size: number;
  reclaimable: number;
}

export interface DiskUsage {
  layers_size: number;
  images: ResourceUsage;
  containers: ResourceUsage;
  volumes: ResourceUsage;
  build_cache_size: number;
}

export interface TopConsumer {
  kind: 'image' | 'container' | 'volume';
  name: string;
  size: number;
  detail: string;
}

export interface SystemOverview {
  info: SystemInfo;
  usage: DiskUsage;
  top_images: TopConsumer[];
  top_volumes: TopConsumer[];
}
```

---

## 3. Mecánica

### 3.1 Las dos fuentes y por qué hacen falta las dos

`/info` describe la **máquina** y el **daemon**; `/system/df` describe el **consumo**. Ninguna cubre la otra y el panel necesita ambas:

| Dato | Fuente |
| :--- | :--- |
| Versión de Docker, OS, kernel, hostname, nº de núcleos, RAM, driver, raíz | `GET /info` |
| Recuentos de contenedores e imágenes | `GET /info` |
| Tamaño de capas, totales y recuperable por tipo | `GET /system/df` |
| Volumen y contenedor que más espacio ocupan | `GET /system/df` → `ImageUsage.Items` / `VolumeUsage.Items` |
| Nombre de los mayores volúmenes | `VolumeUsage.Items[].Name` |
| Tamaño de un volumen | `VolumeUsage.Items[].UsageData.Size` |
| Nombre de las mayores imágenes | `GET /images/json`, resuelto por `ImageUsage.Items[].Id` |

> **Tres trampas de `Items`, comprobadas contra el daemon real:**
>
> - `ImageUsage.Items[]` **no trae `Names`**: solo `Id`, `Size`, `Containers`, `Created` y `Labels`.
>   El nombre se resuelve contra `/images/json` en una llamada adicional. Si la imagen no está en ese
>   listado, o su `RepoTags` es `<none>:<none>`, se muestra el `Id` corto **conservando el prefijo
>   `sha256:`**, para que no se confunda con un nombre.
> - `VolumeUsage.Items[]` **no trae `Size` a nivel de item**: está anidado en `UsageData.Size`.
>   Leerlo en el sitio equivocado devuelve `0`, y el panel muestra 0 MiB mientras el daemon declara
>   cientos de MB recuperables.
> - `ContainerUsage.Items[]` sí trae `Names` y `Size` a nivel de item, sin anidar.

### 3.2 Normalización de `/system/df`

La respuesta del daemon anida el uso bajo claves con sufijo `Usage`, y el tamaño de cada recurso **no** está en el nivel superior de la entrada, sino en `UsageData`:

```text
Images[i]        -> { Id, RepoTags, Size, Containers, ... }        (Size en el nivel superior)
ImageUsage.Items[j]  -> { Id, Containers, ..., UsageData: { Size, RefCount } }
VolumeUsage.Items[j] -> { Name, ..., UsageData: { Size, RefCount } }
ContainerUsage.Items[j] -> { Id, Names, Image, ..., Size, RefCount }
```

Los totales y el recuperable **sí** están en el nivel superior de cada bloque `*Usage`, y son la fuente fiable para la franja de resumen:

```text
ResourceUsage {
  total_count  = <X>Usage.TotalCount
  active_count = <X>Usage.ActiveCount
  total_size   = <X>Usage.TotalSize
  reclaimable  = <X>Usage.Reclaimable
}
```

Para `build_cache_size` se usa `BuildCacheUsage` si es un número, ignorando la lista `BuildCache`; en el host de referencia ambos vienen vacíos porque no hay caché de compilación.

`layers_size` se toma de `LayersSize`, que es el tamaño de las capas compartidas y **no** la suma de las imágenes: contarlas dos veces daría un total inflado. Por eso la suma de imágenes y contenedores se presenta como "espacio de imágenes" y "espacio de contenedores" por separado, y `layers_size` solo como referencia contextual.

### 3.3 Endpoints REST

| Método | Endpoint | Respuesta | Errores |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/system/info` | `200 OK` (`SystemInfo`) | `503` daemon no disponible |
| `GET` | `/api/v1/system/df` | `200 OK` (`DiskUsage`) | `503` daemon no disponible |
| `GET` | `/api/v1/system/overview` | `200 OK` (`SystemOverview`) | `503` daemon no disponible |

Se ofrecen los tres porque la franja de resumen necesita lo esencial de forma rápida, el panel de detalle necesita el desglose, y `overview` evita que el cliente haga dos viajes para la vista completa. `overview` se construye en el backend para que el frontend no tenga que duplicar la lógica de normalización.

### 3.4 Superficie de usuario

- **Franja de resumen**: una fila compacta, siempre visible, con Docker + versión, SO, nº de núcleos, RAM total y el espacio total en disco. Si el daemon no responde, la franja lo dice explícitamente en lugar de mostrar ceros, porque "0 imágenes" y "no pude preguntar" son cosas muy distintas.
- **Panel de detalle**: al desplegar la franja, una tabla con total / en uso / recuperable por tipo (imágenes, contenedores, volúmenes, caché de build), las mayores imágenes y los mayores volúmenes, y la ruta de la raíz de Docker.
- **Enlaces a la limpieza**: cada cifra recuperable enlaza a la pestaña correspondiente (Imágenes o Volúmenes). Esta spec **no** ejecuta la limpieza, solo lleva allí. El enlace **solo cambia de pestaña**: no pre-filtra ni amplía los filtros de esas vistas.
- **Porcentaje recuperable**: cada cifra recuperable se acompaña de su porcentaje sobre el total de ese mismo tipo de recurso, para que se entienda de un vistazo si el problema es grave ("1 GB de 5 GB") o marginal ("1 MB de 20 GB"). El porcentaje se calcula en el frontend a partir de `reclaimable` y `total_size`, que el backend ya entrega; no requiere cambios de contrato.
- Los datos se solicitan al montar y se pueden refrescar con un botón, sin sondeo automático: el consumo en disco cambia despacio y no justifica un temporizador. El botón de refresco **también aparece en el estado de error**, para que un fallo al cargar sea recuperable sin recargar la página. Refrescar no vacía la franja: la deja visible con el botón en estado de carga, en lugar de sustituirla por un mensaje de espera.
- `SystemDetailPanel` **recibe el resumen por prop** desde `SystemSummaryBar` y no vuelve a pedirlo: abrir y cerrar el panel no genera tráfico al daemon.

### 3.5 Notas de aiodocker 0.27.0 (verificadas)

- `aiodocker.system` **solo** expone `info()`. `df` no existe como método, así que se obtiene con `docker._query_json("system/df")`. SPEC-09 reutiliza el primitivo `SystemService.fetch_disk_usage()` que introduce SPEC-08, de modo que ambas specs comparten una única forma de leer el `df`.
- `/info` tiene 58 campos en el host de referencia; la mayoría son irrelevantes para un panel. Se selectionan explícitamente los del contrato, para que la respuesta no dependa de la versión del daemon.
- `BuildCache` es una lista y `BuildCacheUsage` un entero. Se usa el entero y se ignora la lista.

---

## 4. Criterios de Aceptación (Gherkin en Español)

```gherkin
# language: es
Característica: Resumen del host y consumo de disco
  Como desarrollador de software
  Quiero ver de un vistazo la máquina donde corro Docker y cuánto disco consume
  Para saber por qué se llena el disco y cuánto espacio puedo recuperar

  Antecedentes:
    Dado que el servidor backend de DockPilot está en ejecución
    Y la conexión al socket de Docker está establecida

  Escenario: La franja de resumen muestra la máquina
    Dado que el daemon responde con la versión "29.8.1" y 12 núcleos
    Cuando el usuario carga el panel
    Entonces el sistema responde con código HTTP 200 a "GET /api/v1/system/info"
    Y la franja muestra la versión de Docker
    Y la franja muestra el número de núcleos
    Y la franja muestra la memoria RAM total formateada

  Escenario: Desglose de consumo por tipo de recurso
    Dado que el host tiene imágenes, contenedores y volúmenes
    Cuando el usuario solicita "GET /api/v1/system/df"
    Entonces la respuesta incluye el total, el tamaño y el recuperable de cada tipo
    Y el tamaño de las capas se informa aparte para no contarlo dos veces

  Escenario: Vista completa en una sola llamada
    Dado que el usuario despliega el panel de detalle
    Cuando el frontend solicita "GET /api/v1/system/overview"
    Entonces la respuesta incluye la información de la máquina y el consumo a la vez
    Y lista las imágenes y los volúmenes que más espacio ocupan

  Escenario: Espacio recuperable señalizado
    Dado que el daemon reporta 4.22 GB de imágenes recuperables
    Cuando el usuario consulta el resumen
    Y el total de imágenes ocupado es 5.1 GB
    Entonces la vista calcula el porcentaje recuperable
    Y ofrece un enlace a la vista de imágenes para actuar sobre él

  Escenario: Daemon no disponible
    Dado que el daemon de Docker no responde
    Cuando el usuario carga el panel
    Entonces el sistema responde con código 503 en los endpoints de sistema
    Y la franja indica explícitamente que no se pudo conectar
    Y no muestra ceros como si fueran valores reales

  Escenario: Caché de compilación ausente
    Dado que el host no tiene caché de compilación
    Cuando el usuario consulta el resumen
    Entonces el espacio de caché de compilación se informa como 0
    Y el resto del desglose se calcula con normalidad
```

---

## 5. Plan de Pruebas Automatizadas

### Backend (`pytest` + `pytest-asyncio`)
- `tests/test_system.py`:
  - `test_system_info_maps_expected_fields`: verifica el mapeo de los campos de `/info` al contrato.
  - `test_system_info_missing_optional_fields`: un `/info` con campos ausentes no rompe el mapeo.
  - `test_disk_usage_normalizes_usage_blocks`: extrae total, active, total_size y reclaimable de `ImageUsage`/`VolumeUsage`/`ContainerUsage`.
  - `test_disk_usage_layers_size_is_not_added_to_images`: comprueba que `layers_size` no se suma al total de imágenes.
  - `test_build_cache_size_reads_numeric_field`: usa `BuildCacheUsage` e ignora la lista `BuildCache`.
  - `test_overview_top_consumers_sorted_by_size`: las mayores imágenes y volúmenes vienen ordenadas.
  - `test_system_endpoints_daemon_unavailable`: 503 cuando el daemon falla.
  - `test_overview_is_consistent_with_separate_endpoints`: `overview` concuerda con `info` y `df` solicitados por separado.

### Frontend (`vitest` + `@testing-library/react`)
- `tests/components/SystemSummaryBar.test.tsx`: muestra versión, núcleos y RAM; formatea el espacio; y cuando la API falla muestra un estado de "no conectado" en lugar de ceros. Además: el botón de refresco vuelve a pedir el resumen, y **el estado de error también lo ofrece**, porque sin él un fallo de red al cargar deja la franja bloqueada hasta recargar la página a mano.
- `tests/components/SystemDetailPanel.test.tsx`: desglose por tipo, porcentaje recuperable, mayores consumidores y los enlaces a las vistas de Imágenes y Volúmenes.
- `tests/services/systemApi.test.ts`: los tres endpoints y la propagación del mensaje de error.

> **Alcance de los enlaces a la limpieza:** el enlace **solo cambia de pestaña** (§3.4: "enlaza a la pestaña correspondiente"). No pre-selecciona el filtro "no usadas" ni añade filtros nuevos: `ImagesView` no tiene filtro de no-usadas y crearlo sería functionality de SPEC-07, fuera del alcance de esta spec.

### Definición de porcentaje recuperable

El porcentaje se calcula sobre el **total del propio tipo**, nunca sobre la suma de todos:

```text
porcentaje = 100 * <X>.reclaimable / <X>.total_size
```

Si `total_size` es `0` (daemon recién arrancado, o un tipo sin nada) el porcentaje es `0.0%` y **no** se divide: una división por cero en el panel produciría `Infinity` o `NaN` en pantalla.

### Verificación manual
- [x] Contrastar las cifras del panel con `docker system df` en una terminal: verificado contra el
  daemon real, los agregados y los mayores consumidores coinciden.
- [x] Comprobar que el porcentaje recuperable refleja la realidad tras limpiar imágenes no usadas. **Hecho en SPEC-21, y salió con un matiz que esta spec noiba a prever: el `df` y lo que da el botón no son lo mismo.** El `df` cuenta como recuperable toda imagen sin uso (**con y sin etiqueta**): 4,31 GB en el host de referencia, mientras que la limpieza segura da 769 MiB. Los dos números son correctos y no se pueden reproducir uno desde el otro, porque `SharedSize` sale como `-1` y las capas compartidas no se pueden descontar (SPEC-21 §4.2). El cálculo del porcentaje ya estaba cubierto por tests unitarios con total `0` y con total normal.

---

## 6. Plan de Tareas (Tasks)

- [x] **Fase 1: Contratos**
  - [x] Crear `backend/app/schemas/system.py` con `SystemInfo`, `ResourceUsage`, `DiskUsage`, `TopConsumer` y `SystemOverview`
  - [x] Crear `frontend/src/types/system.ts` con las interfaces equivalentes campo por campo
- [x] **Fase 2: Tests Primero en Backend (TDD)**
  - [x] Añadir el doble de `system.info()` y de `system/df` a `backend/tests/conftest.py`
  - [x] Crear `backend/tests/test_system.py` reutilizando el primitivo de SPEC-08
  - [x] Ejecutar `pytest -v` y confirmar que falla por implementación ausente (fase roja)
- [x] **Fase 3: Implementación Backend**
  - [x] Implementar `get_system_info` con la selección explícita de campos de `/info`
  - [x] Implementar `get_disk_usage` normalizando los bloques `*Usage` y `BuildCacheUsage`
  - [x] Implementar `get_overview` componiendo info, uso y mayores consumidores
  - [x] Registrar los endpoints en `backend/app/api/v1/system.py` e incluirlo en `api/router.py`
  - [x] Ejecutar `pytest -v` y validar aprobación al 100%
- [x] **Fase 4: Tests Primero en Frontend**
  - [x] Crear `frontend/tests/components/SystemSummaryBar.test.tsx`
  - [x] Completar `frontend/tests/components/SystemDetailPanel.test.tsx` con los casos que faltaban: porcentaje recuperable y enlaces a Imágenes y Volúmenes
  - [x] Crear `frontend/tests/services/systemApi.test.ts`
  - [x] Añadir a `frontend/tests/components/SystemSummaryBar.test.tsx` el caso del botón de refresco y del reintento desde el estado de error
  - [x] Ejecutar `vitest` y confirmar que los casos nuevos fallan por implementación ausente (fase roja)
- [x] **Fase 5: Implementación Frontend** *(las tres primeras tareas ya se hicieron en la entrega original)*
  - [x] Añadir `getSystemInfo`, `getDiskUsage` y `getSystemOverview` a `frontend/src/services/dockerApi.ts`
  - [x] Crear `frontend/src/hooks/useSystemOverview.ts` con la carga y el refresco manual
  - [x] Implementar `frontend/src/components/system/SystemSummaryBar.tsx` con el estado "no conectado"
  - [x] Implementar `frontend/src/components/system/SystemDetailPanel.tsx` con el desglose
  - [x] Mostrar el porcentaje recuperable junto a los bytes en cada bloque de uso, con total `0` tratado como `0.0%`
  - [x] Convertir las cifras recuperables de Imágenes y Volúmenes en enlaces que cambian de pestaña, cableando `onNavigateTab` desde `App.tsx`
  - [x] Añadir el botón de refresco a la franja, también en el estado de error, sin vaciar la franja mientras se recarga
  - [x] Pasar `overview` por prop a `SystemDetailPanel` para que no repita la llamada al daemon
  - [x] Unificar la lógica de carga de `useSystemOverview` en un único sitio y separar `refreshing` de `loading`
- [x] **Fase 5bis: Corrección de defecto lateral**
  - [x] Definir `--color-elevated-hover` en `frontend/src/index.css`: la clase `hover:bg-elevated-hover` se usa en 8 sitios pero el token no existía, así que Tailwind no la generaba y ninguno de esos hovers hacía nada
- [x] **Fase 6: Verificación y Quality Gates**
  - [x] Ejecutar y aprobar la suite backend (`make backend-test`) y el lint (`make backend-lint`)
  - [x] Ejecutar y aprobar la suite frontend (`pnpm run test`, `pnpm run lint`, `pnpm run build`)
  - [x] Contrastar las cifras del panel con `docker system df` en una terminal
  - [x] Actualizar `agent.md` (árboles, `specs/09-system-overview.md`) y marcar las tareas como completadas (`[x]`)
