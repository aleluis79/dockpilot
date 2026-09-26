# SPEC-08: Gestión de Volúmenes Docker

## 1. Contexto y Objetivos
- **Problema**: SPEC-03 permite montar volúmenes al crear un contenedor, pero DockPilot no ofrece **ninguna** forma de verlos, inspeccionarlos ni liberarlos. Docker no tiene ningún otro mecanismo de descubrimiento para ellos, así que un volumen creado desde el panel es un punto ciego: si el contenedor que lo usaba se elimina, el volumen queda ahí ocupando espacio sin que nada indique su nombre ni su contenido. En el host de referencia esto ya ha ocurrido: de 15 volúmenes, **6 tienen nombre hash anónimo** (40%) y solo 1 sigue en uso, lo que representa unos 460 MB irrecuperables a simple vista.
- **Objetivo**: Incorporar la gestión de volúmenes como cuarta pestaña del panel: inventario con nombre, driver, punto de montaje, tamaño y número de contenedores que lo usan; detalle con etiquetas y opciones; borrado individual con protección frente a volúmenes en uso; y limpieza de los volúmenes no utilizados (*dangling*), que es donde está el espacio realmente recuperable.
- **Alcance**:
  - Incluye:
    - Enriquecimiento del listado con `size` y `ref_count`, obtained de `/system/df` porque `/volumes` no los trae.
    - Endpoint REST `GET /api/v1/volumes`, `GET /api/v1/volumes/{name}` y `DELETE /api/v1/volumes/{name}`.
    - Endpoint REST `POST /api/v1/volumes/prune` para eliminar los volúmenes no utilizados en bloque.
    - Cuarta pestaña `Volúmenes` en el panel, con contador de espacio recuperable.
    - Modal de detalle con metadatos, etiquetas, opciones y contenedores que lo usan.
    - Diálogo de borrado que exige confirmación explícita y explica la irreversibilidad.
  - No incluye (en esta spec):
    - **Explorar el contenido** de un volumen (navegar sus archivos o descargar un backup). Requeriría montar un volumen auxiliar y es un alcance considerable por sí solo.
    - Crear volúmenes desde la interfaz. Docker los crea implícitamente al montar; crearlos a mano sin un contenedor que los use solo genera basura.
    - Redimensionar volúmenes (`docker volume update`), que requiere que el driver lo soporte y no es habitual en el driver `local`.
    - `prune` de imágenes o de la caché de build, aunque `/system/df` ya facilite los datos. Esas acciones pertenecen a SPEC-07 (imágenes) y a una spec de sistema posterior.

---

## 2. Contrato de Datos (Schemas & Types)

### 2.1 Backend (Pydantic v2) - `app/schemas/volume.py`

```python
from typing import Any, Optional
from pydantic import BaseModel, Field

class VolumeSummary(BaseModel):
    name: str = Field(..., description="Nombre del volumen; 64 hex indica uno anónimo")
    driver: str = "local"
    mountpoint: str = Field("", description="Ruta en el host de los datos")
    scope: str = "local"
    created_at: str = Field("", description="Fecha de creación en ISO 8601")
    size: int = Field(0, description="Tamaño en bytes; 0 si el daemon no lo informa")
    ref_count: int = Field(0, description="Contenedores que usan el volumen; 0 = eliminable")
    is_anonymous: bool = Field(False, description="True si el nombre es un hash de 64 hex")
    labels: dict[str, str] = Field(default_factory=dict)

class VolumeDetail(VolumeSummary):
    options: dict[str, Any] = Field(default_factory=dict)
    containers: list[str] = Field(default_factory=list, description="Nombres de los contenedores que lo usan")

class VolumePruneResult(BaseModel):
    deleted: list[str] = Field(default_factory=list)
    bytes_reclaimed: int = Field(0, description="Espacio recuperado en bytes")
    message: str

class VolumeDeleteResponse(BaseModel):
    name: str
    deleted: bool
    message: str
```

### 2.2 Frontend (TypeScript) - `src/types/volume.ts`

```typescript
export interface VolumeSummary {
  name: string;
  driver: string;
  mountpoint: string;
  scope: string;
  created_at: string;
  size: number;
  ref_count: number;
  is_anonymous: boolean;
  labels: Record<string, string>;
}

export interface VolumeDetail extends VolumeSummary {
  options: Record<string, unknown>;
  containers: string[];
}

export interface VolumePruneResult {
  deleted: string[];
  bytes_reclaimed: number;
  message: string;
}

export interface VolumeDeleteResponse {
  name: string;
  deleted: boolean;
  message: string;
}
```

---

## 3. Mecánica

### 3.1 Obtención del listado y el enriquecimiento

El inventario se construye con **dos fuentes que hay que unir**, porque ninguna trae todos los datos:

| Dato | Fuente |
| :--- | :--- |
| `Name`, `Driver`, `Mountpoint`, `Scope`, `CreatedAt`, `Labels`, `Options` | `GET /volumes` |
| `Size` y `RefCount` | `GET /system/df` → `VolumeUsage.Items[].UsageData` |
| `containers` (qué contenedores lo montan) | `GET /containers?all=true` → `Mounts[]` con `Type: "volume"` |

> **`/volumes/{name}` no incluye ningún campo `Containers`.** Comprobado contra el daemon: sus
> claves son `CreatedAt`, `Driver`, `Labels`, `Mountpoint`, `Name`, `Options` y `Scope`. Los
> nombres de los contenedores hay que sacarlos de los `Mounts` del listado de contenedores, en una
> sola llamada con `all=true` (un contenedor detenido sigue usando el volumen y cuenta para el
> `RefCount`).

```text
volúmenes = GET /volumes                       -> lista de entries
uso       = GET /system/df -> VolumeUsage.Items -> índice por Name
resumen[i] = { ...entry, size: uso[Name].UsageData.Size,
                          ref_count: uso[Name].UsageData.RefCount }
```

Un volumen ausente del índice de `df` se trata con `size = 0` y `ref_count = 0`: es el caso normal cuando el daemon no conoce el tamaño, y no debe romper el listado.

### 3.2 Volúmenes anónimos

Docker nombra los volúmenes creados sin `name` con un hash de 64 caracteres hexadecimales. La detección es puramente léxica y no requiere ninguna llamada:

```
is_anonymous = len(name) == 64 and all(c in "0123456789abcdef" for c in name)
```

Se exponen con `is_anonymous: true` para que la interfaz pueda agruparlos o offerer limpieza, pero **el borrado no se restringe**: el usuario decide.

### 3.3 Endpoints REST

| Método | Endpoint | Query | Respuesta | Errores |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/volumes` | — | `200 OK` (`VolumeSummary[]`) | `503` daemon no disponible |
| `GET` | `/api/v1/volumes/{name}` | — | `200 OK` (`VolumeDetail`) | `404` inexistente |
| `DELETE` | `/api/v1/volumes/{name}` | `force` (bool, def. `false`) | `200 OK` (`VolumeDeleteResponse`) | `404` inexistente, `409` en uso |
| `POST` | `/api/v1/volumes/prune` | — | `200 OK` (`VolumePruneResult`) | `503` daemon no disponible |

`GET /{name}` llama a `volumes.get(name).show()` para obtener opciones y etiquetas, y cruza el resultado con `df` para el tamaño.

`DELETE` mapea el `409` del daemon a un `409` propio con un mensaje que nombra los contenedores que lo bloquean. Con `force=true` se acepta la pérdida de datos.

`POST /prune` **solo** elimina volúmenes no utilizados (`dangling`). Nunca toca uno en uso, aunque el usuario lo solicite: es la única protección frente a un borrado accidental masivo.

### 3.4 Superficie de usuario

- Cuarta pestaña `Volúmenes` en el conmutador principal, con contador de volúmenes y espacio **recuperable** (el `Reclaimable` de `VolumeUsage`).
- `VolumesTable`: nombre (con insignia `anónimo` cuando aplica), driver, tamaño con `formatBytes`, fecha y un indicador `En uso (N)` / `Libre`. Ordena por defecto los no usados primero, que son los que le interesan al usuario.
- Filtros: **Todos**, **En uso**, **No usados** y **Anónimos**, más buscador por nombre. Son filtros de cliente sobre el inventario ya cargado.
- `VolumeDetailModal`: metadatos, punto de montaje, etiquetas, opciones y los contenedores que lo usan.
- Borrado: diálogo de confirmación que nombra el volumen, muestra su tamaño y advierte explícitamente de que **los datos no se pueden recuperar**. Para volúmenes anónimos el texto se adapta: no hay nombre legible que mostrar.
- Limpieza: acción separada `Limpiar no usados` en la cabecera, con un diálogo que dice cuántos volúmenes y cuántos bytes se van a recuperar, obtained de `df` antes de actuar.

### 3.5 Notas de aiodocker 0.27.0 (verificadas)

Estas tres particularidades de la librería **rompen** una implementación intuitiva y deben respetarse:

1. **`volumes.list()` no devuelve una lista.** Devuelve el dict completo de la respuesta: `{"Volumes": [...], "Warnings": [...]}`. Iterarlo directamente produce `'str' object has no attribute 'get'`, porque se recorren sus claves. Hay que extraer `data.get("Volumes") or []`.
2. **`DockerVolumes` no tiene método `delete`.** Los métodos del repositorio son `create`, `get`, `list` y `prune`. Para borrar hay que obtener la instancia con `get(name)` y llamar a `DockerVolume.delete(force=...)`, que sí existe.
3. **`system.df` no está expuesto.** `aiodocker.system` solo ofrece `info()`. El consumo de disco se obtiene con `docker._query_json("system/df")`, que es la misma vía que usa el servicio internamente.

`VolumeSize` e `ImageSize` del `df` vienen **anidados** bajo `UsageData`, no en el nivel superior de la entrada.

### 3.6 Dependencia con SPEC-09

El tamaño y el contador de referencias exigen consultar `/system/df`, que también necesita SPEC-09 (Resumen del host). Para no duplicar esa llamada, esta spec introduce el primitivo compartido `SystemService.fetch_disk_usage()` en `app/services/system_service.py`, que devuelve el `df` en bruto, y SPEC-09 construye la vista completa sobre él.

---

## 4. Criterios de Aceptación (Gherkin en Español)

```gherkin
# language: es
Característica: Gestión de volúmenes Docker
  Como desarrollador de software
 Quiero ver, inspeccionar y liberar los volúmenes de mi host
  Para recuperar el espacio que ocupan contenedores que ya no existen

  Antecedentes:
    Dado que el servidor backend de DockPilot está en ejecución
    Y la conexión al socket de Docker está establecida

  Escenario: Inventario de volúmenes con tamaño y uso
    Dado que el host tiene el volumen "datos-app" usado por un contenedor
    Y un volumen "aa342f746404c4a57823f40a9bccdc" sin usar
    Cuando el usuario abre la vista "Volúmenes"
    Entonces el sistema responde con código HTTP 200 al solicitar "GET /api/v1/volumes"
    Y cada volumen informa de "name", "driver", "size" y "ref_count"
    Y "datos-app" informa "ref_count" mayor que 0
    Y el volumen de nombre hash se marca con "is_anonymous" en true
    Y el tamaño se muestra formateado en unidades legibles

  Escenario: Volumen inexistente en el índice de uso
    Dado que el daemon no informa del tamaño de un volumen concreto
    Cuando el usuario lista los volúmenes
    Entonces ese volumen aparece con "size" 0 y "ref_count" 0
    Y el resto del inventario se lista con normalidad

  Escenario: Inspección del detalle de un volumen
    Dado que existe el volumen "datos-app"
    Cuando el usuario solicita "GET /api/v1/volumes/datos-app"
    Entonces el sistema responde con código HTTP 200
    Y la respuesta incluye "mountpoint" y "driver"
    Y la respuesta incluye los contenedores que lo usan en "containers"

  Escenario: Borrado de un volumen no utilizado
    Dado que existe el volumen "temporal" que no usa ningún contenedor
    Cuando el usuario solicita "DELETE /api/v1/volumes/temporal"
    Entonces el sistema responde con código HTTP 200
    Y la respuesta indica "deleted" en true
    Y el volumen deja de aparecer en el inventario

  Escenario: Borrado de un volumen en uso
    Dado que existe el volumen "datos-app" usado por un contenedor en ejecución
    Cuando el usuario solicita "DELETE /api/v1/volumes/datos-app" sin forzar
    Entonces el sistema responde con código HTTP 409
    Y el cuerpo del error indica que el volumen está en uso
    Y el inventario no cambia

  Escenario: Limpieza de volúmenes no utilizados
    Dado que el host tiene volúmenes sin usar y volúmenes en uso
    Cuando el usuario solicita "POST /api/v1/volumes/prune"
    Entonces el sistema responde con código HTTP 200
    Y la respuesta lista los volúmenes eliminados en "deleted"
    Y la respuesta informa los bytes recuperados en "bytes_reclaimed"
    Y ningún volumen en uso ha sido eliminado

  Escenario: Protección frente a un borrado accidental
    Dado que el usuario tiene volúmenes sin usar
    Y el diálogo de limpieza indica cuántos volúmenes y cuántos bytes se van a liberar
    Cuando el usuario cancela la limpieza
    Entonces no se elimina ningún volumen

  Escenario: Discrepancia entre referencias y contenedores listados
    Dado que el daemon informa "ref_count" 1 para un volumen
    Y ningún contenedor del listado lo monta
    Cuando el usuario consulta "GET /api/v1/volumes/{name}"
    Entonces la lista "containers" llega vacía
    Y la interfaz no afirma que el volumen se pueda eliminar sin forzar
    Y explica que la discrepancia obliga a forzar el borrado

  Escenario: Volumen inexistente
    Dado que no existe el volumen "no-existe-este-volumen"
    Cuando el usuario solicita "GET /api/v1/volumes/no-existe-este-volumen"
    Entonces el sistema responde con código HTTP 404
    Y cuando el usuario solicita "DELETE /api/v1/volumes/no-existe-este-volumen"
    Entonces el sistema responde con código HTTP 404
```

---

## 5. Plan de Pruebas Automatizadas

### Backend (`pytest` + `pytest-asyncio`)
- `tests/test_volumes.py`:
  - `test_list_volumes_joins_usage`: une `/volumes` con `df` y verifica `size`/`ref_count`.
  - `test_list_volumes_handles_missing_usage_index`: volumen ausente del `df` → `size=0`, `ref_count=0`.
  - `test_anonymous_volume_detection`: hash de 64 hex → `is_anonymous=true`; nombre legible → `false`.
  - `test_volume_detail_success` y `test_volume_detail_not_found`.
  - `test_delete_volume_success` (usando la vía `get().delete()`), `test_delete_volume_conflict` (409 sin force, 200 con force) y `test_delete_volume_not_found`.
  - `test_prune_only_removes_unused`: verifica que un volumen con `ref_count > 0` sobrevive.
  - `test_prune_reports_reclaimed_bytes`.
- `tests/test_system_df.py` (primitivo compartido con SPEC-09):
  - `test_fetch_disk_usage_shape`: devuelve `Images`, `Containers`, `Volumes`, `ImageUsage`, `VolumeUsage`, `ContainerUsage` y `LayersSize`.

### Frontend (`vitest` + `@testing-library/react`)
- `tests/components/VolumesTable.test.tsx`: insignia de volumen anónimo, tamaño formateado, indicador `En uso (N)`, acciones por fila, y estados de carga, vacío y error.
- `tests/components/VolumeDetailModal.test.tsx`: metadatos, punto de montaje, lista de contenedores que lo usan y cierre.
- `tests/components/VolumesView.test.tsx`: filtros (Todos / En uso / No usados / Anónimos), buscador por nombre, contador de espacio recuperable, y confirmación de la limpieza con el recuento de volúmenes y bytes.
- `tests/components/VolumeDeleteDialog.test.tsx`: el diálogo nombra el volumen, muestra su tamaño y advierte de la irreversibilidad; cancelar no borra.

### Verificación manual
- Limpiar de verdad los volúmenes `test_volume_*` del host y comprobar que el espacio recuperable baja.
- Comprobar que el borrado de un volumen en uso ofrece `force` y que el resultado es el esperado.

---

## 6. Plan de Tareas (Tasks)

- [x] **Fase 1: Contratos y primitivo compartido**
  - [x] Crear `backend/app/schemas/volume.py` con `VolumeSummary`, `VolumeDetail`, `VolumePruneResult` y `VolumeDeleteResponse`
  - [x] Crear `frontend/src/types/volume.ts` con las interfaces equivalentes campo por campo
  - [x] Crear `backend/app/services/system_service.py` con `fetch_disk_usage()` (primitivo compartido con SPEC-09)
- [x] **Fase 2: Tests Primero en Backend (TDD)**
  - [x] Añadir `FakeDockerVolumes` a `backend/tests/conftest.py` que emule la respuesta con dict de `volumes.list()` y el `df` con `UsageData`
  - [x] Crear `backend/tests/test_system_df.py`
  - [x] Crear `backend/tests/test_volumes.py`
  - [x] Ejecutar `pytest -v` y confirmar que falla por implementación ausente (fase roja)
- [x] **Fase 3: Implementación Backend**
  - [x] Implementar `list_volumes` uniendo `/volumes` con `df` y detectando anónimos
  - [x] Implementar `get_volume_detail` y `delete_volume` con la vía `get().delete()` y el mapeo de 404/409
  - [x] Obtener `containers` desde los `Mounts` de `GET /containers?all=true`, porque `/volumes/{name}` no expone ese dato
  - [x] Implementar `prune_volumes` limitado a los no usados
  - [x] Registrar los endpoints en `backend/app/api/v1/volumes.py` e incluirlo en `api/router.py`
  - [x] Ejecutar `pytest -v` y validar aprobación al 100%
- [x] **Fase 4: Tests Primero en Frontend**
  - [x] Crear `frontend/tests/components/VolumesTable.test.tsx`
  - [x] Crear `frontend/tests/components/VolumeDetailModal.test.tsx`
  - [x] Crear `frontend/tests/components/VolumesView.test.tsx`
  - [x] Crear `frontend/tests/components/VolumeDeleteDialog.test.tsx`
- [x] **Fase 5: Implementación Frontend**
  - [x] Añadir `getVolumes`, `getVolume`, `deleteVolume` y `pruneVolumes` a `frontend/src/services/dockerApi.ts`
  - [x] Implementar `frontend/src/components/volumes/VolumesTable.tsx` con la insignia de anónimo y el indicador de uso
  - [x] Implementar `frontend/src/components/volumes/VolumeDetailModal.tsx`
  - [x] Implementar `frontend/src/components/volumes/VolumesView.tsx` con filtros, buscador y acción de limpieza
  - [x] Añadir el diálogo de borrado con advertencia de irreversibilidad
  - [x] Añadir la cuarta pestaña `Volúmenes` al conmutador de `frontend/src/App.tsx`
- [x] **Fase 6: Verificación y Quality Gates**
  - [x] Ejecutar y aprobar la suite backend (`make backend-test`) y el lint (`make backend-lint`)
  - [x] Ejecutar y aprobar la suite frontend (`pnpm run test`, `pnpm run lint`, `pnpm run build`)
  - [x] Verificar que los tests de arquitectura de tokens y de overlays siguen pasando
  - [x] Limpiar de verdad los volúmenes de prueba del host y comprobar la caída del espacio recuperable
  - [x] Actualizar `agent.md` (árboles, `specs/08-volumes-management.md`) y marcar las tareas como completadas (`[x]`)
