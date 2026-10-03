# SPEC-21: Limpieza de imágenes y contenedores parados

## 1. Contexto y Objetivos

- **Problema**: El panel **mide** el espacio recuperable de imágenes, contenedores y caché de build en el detalle del host, y **sólo puede liberar volúmenes y redes**. Las dos piezas que el propio panel señala como las mayores están fuera de su alcance: `POST /api/v1/images/prune` y `POST /api/v1/containers/prune` no existen. Y `specs/09-system-overview.md` tiene una verificación manual bloqueada desde hace semanas por exactamente esto, con la nota de que «requiere una limpieza real, que es decisión del usuario».

- **Objetivo**: Poder limpiar imágenes y contenedores parados **desde el panel, con el mismo patrón de aviso y confirmación que ya tienen volúmenes y redes**, y con un recuento previo que sea verdad.

- **Alcance**:
  - Incluye:
    - **Previsualización no destructiva** de qué se va a borrar y cuánto se recuperaría, calculada leyendo, no preguntando al prune.
    - Limpieza de imágenes **sin etiqueta** (`dangling`), que es la segura.
    - Limpieza de imágenes **con etiqueta** que no usa ningún contenedor, como **acción aparte** con su propia confirmación y los nombres a la vista.
    - Limpieza de contenedores **parados**, con confirmación y sus nombres a la vista.
    - Los botones en su propia vista, siguiendo el patrón que ya fijó `NetworksView`.
  - No incluye (en esta spec):
    - **La caché de build.** Vive en otro endpoint (`prune_builds`), tiene semántica de antigüedad propia y son ya dos confirmaciones para imágenes: sería una tercera con otro ciclo de vida. Es su propia spec.
    - **`POST /system/prune` del daemon.** Mezcla contenedores, imágenes, redes y caché en una sola llamada cuyo recuento previo **no se puede desglosar**, y esta spec entero consiste en que el recuento sea verdad.
    - **Filtros por etiqueta** para no borrar contenedores de compose (`label=`). Se puede añadir después; el prune del daemon los acepta.
    - **Limpieza desde el panel del host.** Ese panel es de lectura por diseño (SPEC-16) y en sus botones sólo navega. Un botón destructivo ahí lo convertiría en otra cosa.
    - **Deshacer.** No lo hay en Docker, y por eso los diálogos enseñan los nombres y no sólo un número.

---

## 2. Contrato de Datos (Schemas & Types)

### 2.1 Backend (Pydantic v2) — additions en `app/schemas/image.py` y `app/schemas/container.py`

```python
class ImagePrunePreview(BaseModel):
    """Qué se iría con cada nivel de limpieza. Calculado leyendo `/images/json`."""

    # Nivel seguro: sin etiqueta y sin contenedores que la usen.
    dangling_count: int = 0
    dangling_bytes: int = 0
    dangling_ids: list[str] = Field(default_factory=list)
    # Nivel agresivo: con etiqueta, y por tanto volver a descargables.
    tagged_count: int = 0
    tagged_bytes: int = 0
    tagged_refs: list[str] = Field(default_factory=list)
    # Una imagen sin etiqueta **en uso** no es podable. Se cuenta aparte para
    # poder decirlo, en vez de dejar que el usuario la descubra en el diálogo.
    in_use_dangling: int = 0


class ImagePruneResult(BaseModel):
    deleted: list[str] = Field(default_factory=list)
    bytes_reclaimed: int = 0
    message: str


class ContainerPrunePreview(BaseModel):
    stopped_count: int = 0
    stopped_bytes: int = 0
    stopped_names: list[str] = Field(default_factory=list)


class ContainerPruneResult(BaseModel):
    deleted: list[str] = Field(default_factory=list)
    bytes_reclaimed: int = 0
    message: str
```

`bytes` es una **cota superior, no una promesa**: `GET /images/json` trae `Size` por imagen y dos imágenes pueden compartir capas (`SharedSize`). Sumar `Size` dos veces es contar dos veces las mismas capas. Se dice en el diálogo con la palabra **«hasta»**, igual que `PlannedService.bytes_aprox` de SPEC-15 sobreestima a propósito.

### 2.2 Frontend (TypeScript)

```typescript
export interface ImagePrunePreview {
  dangling_count: number;
  dangling_bytes: number;
  dangling_ids: string[];
  tagged_count: number;
  tagged_bytes: number;
  tagged_refs: string[];
  in_use_dangling: number;
}

export interface ImagePruneResult {
  deleted: string[];
  bytes_reclaimed: number;
  message: string;
}

export interface ContainerPrunePreview {
  stopped_count: number;
  stopped_bytes: number;
  stopped_names: string[];
}

export interface ContainerPruneResult {
  deleted: string[];
  bytes_reclaimed: number;
  message: string;
}
```

`deleted`, `bytes_reclaimed` y `message` son **los mismos tres campos** que ya tienen `VolumePruneResult` y `NetworkPruneResult`, y con el mismo nombre. Cuatro endpoints de limpieza con cuatro formas distintas obligarían a ramificar en el cliente para pintar un resultado.

---

## 3. Contrato de API

### 3.1 Endpoints REST

| Método | Endpoint | Descripción | Respuesta | Errores |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/images/prune` | Qué se borraría con cada nivel. **No llama al prune** | `200` `ImagePrunePreview` | `503` |
| `POST` | `/api/v1/images/prune?all=false` | Borra imágenes sin etiqueta y sin uso | `200` `ImagePruneResult` | `503` |
| `POST` | `/api/v1/images/prune?all=true` | Borra además las que tienen etiqueta y no usan contenedores | `200` `ImagePruneResult` | `503` |
| `GET` | `/api/v1/containers/prune` | Contenedores parados y su tamaño | `200` `ContainerPrunePreview` | `503` |
| `POST` | `/api/v1/containers/prune` | Borra los contenedores parados | `200` `ContainerPruneResult` | `503` |

**`all` es un parámetro de query, no del cuerpo, y por defecto `false`.** No es un detalle de forma: es lo que separa el botón seguro del peligroso, y un cuerpo opcional haría que un cliente que no lo manda limpiara de más. Es el mismo criterio que el `?shell=` de la terminal (SPEC-05) y que `?force=` en el borrado.

`POST` acepta `all` como `Query(False, ...)`, de modo que un `POST` a secas —un `curl`, un script— nunca borra una imagen con etiqueta.

El filtro que viaja al daemon es **`{"all": "true"}`**, con la cadena y no el booleano. `clean_filters` de aiodocker envuelve el valor en una lista y lo serializa tal cual, así que `{"all": True}` produce `{"all": [true]}` y el daemon responde `400 invalid filter`. Es el mismo error que tenía el prune de volúmenes (SPEC-08 §5.1), y por eso los dos lo dicen en el código y lo fijan los tests.

### 3.2 El orden de las rutas no es cosmético

`images.py` declara `@router.get("/{image_id}")`. Si `/prune` se declarase **después**, `GET /api/v1/images/prune` se interpretaría como el detalle de una imagen llamada `prune` y devolvería un `404` con un mensaje sobre una imagen que no existe. Hay un test que lo fija, porque es un fallo que no se ve leyendo el router.

`volumes.py` ya tiene el orden correcto (`/prune` antes de `/{name}`), lo cual es exactamente por lo que funciona allí.

### 3.3 WebSocket

Ninguno nuevo. Un prune cambia el inventario, y quien lo refleja es el `onDeleted` que ya llama a `refetch` de contenedores, como hacen `VolumesView` e `ImagesView`.

---

## 4. Mecánica

### 4.1 El preaviso se calcula leyendo, y por eso puede mentir si el daemon no responde

No hay forma de preguntar a Docker «¿qué borraría un prune?» sin borrarlo. El recuento previo sale de `GET /images/json`, que trae por imagen `RepoTags`, `Containers` y `Size`:

```text
podable y sin etiqueta  =  RepoTags vacío  Y  Containers == 0
podable con etiqueta    =  Containers == 0  Y  tiene al menos un RepoTag
sin etiqueta pero en uso = RepoTags vacío  Y  Containers > 0   → NO se puede borrar
```

La tercera línea es la que **no es obvia**, y hay una de verdad en el host de referencia: `1ed1b0e1d765` no tiene ninguna etiqueta y la usa un contenedor. Si el preaviso contara «sin etiqueta» sin mirar `Containers`, prometería borrar algo que el daemon no va a borrar, y el diálogo mentiría justo en el número que el usuario está mirando.

Y si `/images/json` falla, el preaviso **no puede sostener una lista**, así que responde `503` y no una lista vacía. Es el mismo patrón que `VolumeService._usage_index()` de SPEC-08: un fallo de una lectura opcional que devuelve `{}` convierte un filtro de "¿cuáles no están en uso?" en "todos", y el `503` es lo que evita que el botón diga "no hay nada que limpiar" cuando lo que no se sabe es si hay algo.

### 4.1.1 Los bytes: `/images/json` no los da bien y `/containers/json` no los da (medido)

Tres formas, y **ninguna** sirve para prometer una cifra:

| De dónde | Campo | Qué trae de verdad |
| :--- | :--- | :--- |
| `GET /images/json` | `Size` | El tamaño de la imagen. **Sumarlos cuenta dos veces las capas compartidas** |
| `GET /images/json` | `SharedSize` | **`-1`** en el daemon 29.8.2. Inutilizable |
| `GET /containers/json` | `SizeRw` / `SizeRootFs` | **La clave no existe** en el listado: `None` |
| `GET /system/df` → `Containers[]` | `SizeRw`, `Names` | **Sí está**: 131072 y 24576 bytes, con los nombres |

La consecuencia es que **los tamaños de contenedor salen de `/system/df`**, que es una llamada para todos y no una por contenedor. Y que `df` trae además `Labels`, así que el preaviso puede decir de quién es cada contenedor parado —que es justo lo que hace falta para que el usuario reconozca si es suyo antes de perderlo—.

Y ninguna de las dos cifras es una promesa, por lo que en la interfaz se escribe **«hasta»**. En el host de referencia: las seis imágenes con etiqueta suman 3811 MiB y `docker system df` dice 4,31 GB recuperables; la diferencia es el reparto que hace el daemon de las capas compartidas, y sin `SharedSize` no se puede reproducir. Un botón que prometiese una cifra exacta estaría prometiendo algo que el daemon tampoco calcula.

### 4.2 Los bytes del `df` no son los bytes de este botón

Medido en el host de referencia:

| Cifra | Valor | Qué es |
| :--- | :--- | :--- |
| `docker system df` → Images reclaimable | **4,31 GB (85 %)** | Imágenes sin uso, **con y sin etiqueta** |
| Suma de `Size` de las podables sin etiqueta | **806 MB** | La limpieza segura |
| Suma de `Size` de las podables con etiqueta | **~3,9 GB** | La agresiva |

El `df` cuenta como recuperable todo lo que no usa un contenedor, y la acción por defecto **no toca nada de eso que tenga etiqueta**. Poner el `4,31 GB` al lado de un botón que sólo libera `806 MB` sería la versión de esta spec del error que `agent.md` ya cuenta con el 900 de aiodocker: un número con forma de hecho que no es el hecho.

Por eso el botón muestra **su propio** recuento, el del preaviso, y no el del `df`. Los dos pueden convivir: el `df` es el censo del host y el del botón es lo que ese botón haría.

### 4.3 Sin etiqueta no significa «no la quieres»

Es la diferencia entre los dos niveles, y la interfaz tiene que enseñarla:

- **Sin etiqueta (`dangling`)** es casi siempre el resultado de un `build` que dejó capas viejas o de un `pull` de una versión que ya no existe. No hay forma de volver atrás salvo volver a descargarla, y ni siquiera sabes de qué registro.
- **Con etiqueta** es `python:3.12-slim`, `alpine:latest`, `keycloak:latest`. Borrarlas **funciona**, ydoloras: la siguiente vez que alguien la pida hay que volver a descargarla, que es justo lo que se estaba intentando evitar.

Por eso son **dos botones y dos diálogos**, y el segundo enseña los nombres. Un único botón con una casilla de «incluir las que tienen etiqueta» sería más compacto y escondería justo lo que hay que ver antes de confirmarlo.

### 4.4 El prune lo aplica el daemon, no el panel

No hay `force`, y esa es la garantía: `POST /images/prune` **nunca** borra una imagen que use un contenedor, ni siquiera con `all=true`, porque es el daemon quien lo decide. El panel no reimplementa esa comprobación ni debe prometer más de lo que el daemon promete: si entre el preaviso y la confirmación alguien arranca un contenedor con una de esas imágenes, el prune simplemente no la borra y el resultado lo dice con su recuento real.

`POST /containers/prune` borra los **parados**, incluidos los que están `created` y nunca han arrancado. El borrado de un contenedor parado se lleva su **capa de escritura**: si alguien paró un contenedor para mirarlo mañana, el prune se lo come. Por eso el diálogo enseña los **nombres**, no un número, y por eso `deleted` lleva nombres y no ids.

Lo que **no** se inventa: si `/system/df` no responde, el preaviso responde `503` en vez de decir «0 bytes». Es el mismo `usage_known` de SPEC-08 aplicado a otro sitio, y por el mismo motivo: un `0` aquí significaría «no ocupa nada», que es una afirmación sobre el disco del host que el panel no puede sostener.

### 4.5 Lo que el diálogo tiene que decir, y en qué orden

1. **Cuántos** y **hasta cuántos bytes**, con la palabra *hasta*.
2. **Los nombres**, que es lo único que permite reconocer lo que se va.
3. **Qué no se puede recuperar**, si el nivel es el agresivo: las imágenes con etiqueta habrá que volver a descargarlas.
4. Que **las predefinidas y las que estén en uso no se tocan**, porque es la garantía que da el daemon y es la que hace que esto sea aceptable.

Un diálogo que sólo dice «se eliminarán 3 imágenes» obliga a decidir sin información. Los volúmenes ya lo hacen bien (`VolumeDetailModal` enseña nombre, tamaño y si es anónimo) y las redes hacen lo mínimo justo porque lo que borran son redes predefinidas. Una imagen con etiqueta es más información que una red sin usar, así que el diálogo tiene que darla.

### 4.6 Lo que el usuario no ve: las imágenes sin etiqueta no están en la tabla

`ImageService.list_local_images()` tiene un `if clean_tags:` que **excluye las imágenes sin etiqueta** de la tabla. O sea que justo lo que la limpieza por defecto va a borrar —`ae21ea6bfe46` en el host de referencia— **no aparece en ninguna parte del panel**. Eso existe desde SPEC-07 y no lo cambia esta spec, pero conviene saberlo y decirlo en lugar de que el usuario lo descubra solo.

Lo que hace esta spec para que no se note: el diálogo **enumera los ids cortos** de las que se van a borrar, no sólo un número. Con eso la información está delante del usuario aunque la imagen no esté en la lista.

Lo que **no** se hace aquí, y por qué: enseñarlas en la tabla es cambiar **qué significa la tabla de imágenes**, con sus estados vacíos, su botón de borrar por fila y sus tests. Además, un `<none>` en la columna de repositorio es un caso de UI que la tabla actual no sabe pintar, y meterlo dentro de una spec de limpieza dejaría la vista a medio hacer. Es un spec propio.

### 4.7 El `df` y el preaviso no pueden ser el mismo número

Repetido porque es el error más fácil de cometer al implementarlo, y ya está en §4.2: `SystemOverview.usage.images.reclaimable` son los 4,31 GB del host, y el botón de limpieza sin etiqueta da 769 MiB. **Cada botón muestra su preaviso.** Si alguna vez coinciden es casualidad, y por eso el test del diálogo comprueba el número del preaviso y no el del `df`.

1. **Cuántos** y **hasta cuántos bytes**, con la palabra *hasta*.
2. **Los nombres**, que es lo único que permite reconocer lo que se va.
3. **Qué no se puede recuperar**, si el nivel es el agresivo: las imágenes con etiqueta habrá que volver a descargarlas.
4. Que **las predefinidas y las que estén en uso no se tocan**, porque es la garantía que da el daemon y es la que hace que esto sea aceptable.

Un diálogo que sólo dice «se eliminarán 3 imágenes» obliga a decidir sin información. Los volúmenes ya lo hacen bien (`VolumeDetailModal` enseña nombre, tamaño y si es anónimo) y las redes hacen lo mínimo justo porque lo que borran son redes predefinidas. Una imagen con etiqueta es más información que una red sin usar, así que el diálogo tiene que darla.

### 4.8 Los contenedores no tienen vista propia con barra

`VolumesView` y `NetworksView` son componentes con su barra. La tabla de contenedores se renderiza desde `App.tsx`, que ya tiene los filtros por estado y por salud pero **ningún botón de acción**. El botón de limpieza va ahí, en la barra que ya existe, con la misma advertencia visual que `NetworksView` y el mismo diálogo de `role="dialog"`.

Mover los contenedores a una vista propia —que es lo que arreglaría de paso lo que `agent.md` cuenta de `useContainers` viviendo en `App`— es un refactor que no hace falta para esto y que se lleva por delante siete estados de modales.

---

## 5. Criterios de Aceptación (Gherkin en Español)

```gherkin
# language: es
Característica: Limpiar imágenes y contenedores parados
  Como operador que ha accumulated basura en el host
  quiero limpiarla desde el panel viendo antes qué se va
  para no tener que acordarme de.docker system prune en una terminal

  Antecedentes:
    Dado que el daemon de Docker está accesible

  Escenario: El botón enseña lo que su propia limpieza libera
    Dado que el panel dice que hay 4,3 GB recuperables en imágenes
    Cuando se abre el diálogo de limpieza de imágenes sin etiqueta
    Entonces el número que aparece es el de las imágenes sin etiqueta y sin uso
    Y no el total de recuperables del sistema
    Porque el total incluye las que tienen etiqueta y esta limpieza no las toca

  Escenario: Una imagen sin etiqueta pero en uso no se cuenta como podable
    Dado una imagen sin ninguna etiqueta que usa un contenedor
    Cuando se calcula el preaviso de la limpieza
    Entonces no aparece en la lista de las que se van a borrar
    Y el panel dice que hay una sin etiqueta en uso

  Escenario: Los bytes del diálogo son una cota y se dice
    Dado un preaviso con bytes calculados sumando el tamaño de cada imagen
    Cuando se abre el diálogo
    Entonces dice "hasta" delante de los bytes
    Porque dos imágenes pueden compartir capas y la suma las cuenta dos veces

  Escenario: Limpiar sin etiqueta no toca las que la tienen
    Dado que hay imágenes con etiqueta que no usa ningún contenedor
    Cuando el usuario limpia sin etiqueta
    Entonces se borran las imágenes sin etiqueta y sin uso
    Y las que tienen etiqueta siguen ahí

  Escenario: Limpiar con etiqueta exige su propia confirmación
    Dado que hay imágenes con etiqueta sin uso
    Cuando el usuario elige quitarlas también
    Entonces aparece un diálogo distinto con sus nombres
    Y el botón destructivo no comparte aspecto con el de la limpieza sin etiqueta

  Escenario: El diálogo de la limpieza agresiva dice que hay que volver a descargar
    Dado que la limpieza con etiqueta va a borrar "python:3.12-slim"
    Cuando se confirma
    Entonces el panel ha avisado de que esa imagen habrá que volver a descargarla

  Escenario: Un POST a secas nunca borra una imagen con etiqueta
    Dado que hay imágenes con etiqueta sin uso
    Cuando se hace un POST al prune de imágenes sin parámetros
    Entonces sólo se borran las imágenes sin etiqueta

  Escenario: Limpiar contenedores parados enseña sus nombres
    Dado dos contenedores parados
    Cuando el usuario abre el diálogo de limpieza de contenedores
    Entonces ve los nombres de los dos
    Y no sólo un número

  Escenario: Un contenedor parado se borra con su capa de escritura
    Dado un contenedor parado que el usuario guardaba para mañana
    Cuando limpia los contenedores parados
    Entonces el panel lo ha avisado antes de hacerlo

  Escenario: Los preavisos no se calculan con un prune
    Dado un panel recién abierto
    Cuando se piden los dos preavisos
    Entonces ninguna imagen ni contenedor ha sido eliminado
    Porque un prune es una escritura y no se pide una escritura para contar

  Escenario: Si el daemon no responde, el preaviso lo dice en vez de decir que no hay nada
    Dado que el daemon no responde al listar imágenes
    Cuando se pide el preaviso
    Entonces el sistema responde que no puede saberlo
    Y el botón no dice que no hay nada que limpiar

  Escenario: El botón de limpieza no es una imagen
    Dado el panel con la pestaña de imágenes
    Cuando se pide el preaviso de limpieza
    Entonces responde con el preaviso
    Y no con un error de "no existe esa imagen"

  Escenario: Limpiar no rompe el filtro de la tabla
    Dado que hay un filtro de estado activo
    Cuando se limpia
    Entonces los contadores de las píldoras siguen contando todos los contenedores
    Porque los contadores son un censo del host y no un recuento de lo que se ve
```

---

## 6. Plan de Pruebas Automatizadas

### Backend (`pytest`)

- `backend/tests/test_image_prune.py`:
  - `test_el_preaviso_no_borra_nada`: el doble cuenta las llamadas a `prune` y afirma que son cero.
  - `test_cuenta_las_sin_etiqueta_sin_uso`.
  - `test_no_cuenta_una_sin_etiqueta_que_esta_en_uso`.
  - `test_cuenta_las_con_etiqueta_sin_uso_en_el_nivel_agresivo`.
  - `test_los_bytes_son_la_suma_de_size_y_se_advierten_de_cota`.
  - `test_preaviso_con_daemon_caido_responde_503`: y no una lista vacía.
  - `test_prune_dangling_no_pasa_all_al_daemon`.
  - `test_prune_all_pasa_el_filtro_al_daemon`.
  - `test_prune_devuelve_los_borrados_y_los_bytes`.
  - `test_prune_sin_nada_que_borrar_lo_dice`.
  - `test_prune_con_docker_error_responde_503`: el `900` traducido, nunca servido.
  - `test_el_prune_no_es_el_detalle_de_una_imagen`: `GET /images/prune` responde el preaviso, no un 404.
- `backend/tests/test_container_prune.py`:
  - `test_el_preaviso_solo_cuenta_parados`.
  - `test_el_preaviso_usa_nombres_y_no_ids`.
  - `test_los_bytes_suman_el_tamaño_de_cada_contenedor`.
  - `test_preaviso_con_daemon_caido_responde_503`.
  - `test_prune_borra_los_parados`.
  - `test_prune_sin_parados_lo_dice`.
  - `test_prune_con_docker_error_responde_503`.
  - `test_el_prune_no_es_el_detalle_de_un_contenedor`.

### Frontend (`vitest` + `@testing-library/react`)

- `tests/services/pruneApi.test.ts`: las cinco llamadas, con su verbo y sus query.
- `tests/components/ImagesView.test.tsx` (extender):
  - El botón dice los bytes del **preaviso**, no los del `df`.
  - El diálogo sin etiqueta no menciona las imágenes con etiqueta.
  - El botón agresivo abre **otro** diálogo, con los nombres, y su aspecto destructivo es distinto del primero.
  - Sin nada que limpiar, el botón está deshabilitado y no dice `0`.
  - Con el preaviso fallando, se dice que no se puede saber, no que no hay nada.
- `tests/components/ContainersToolbar.test.tsx` (nuevo):
  - La píldora cuenta los parados y sus bytes.
  - El diálogo lista los nombres.
  - Al limpiar se avisa de la capa de escritura.
  - La limpieza.refresh del padre.
- `tests/components/App.test.tsx` (extender): los contadores de las píldoras no cambian de valor al limpiar.

---

## 7. Plan de Tareas (Tasks)

- [x] **Fase 1: Medir contra el daemon, sin borrar nada**
  - [x] Confirmar con `/images/json` la forma de `RepoTags`, `Containers` y `Size`, y el caso de una imagen sin etiqueta en uso. **Hecho: `1ed1b0e1d765`, sin etiqueta y con un contenedor usando.**
  - [x] Confirmar que la suma de `Size` es una cota y que `SharedSize` la explica. **Medido: `SharedSize` es `-1` y `/containers/json` no trae `SizeRw`. Los tamaños de contenedor salen de `/system/df`. Ver §4.1.1.**
  - [x] Anotar en §4.1 y §4.2 los números medidos y ajustar la spec si no dan. **Hecho: 1 imagen sin etiqueta (769 MiB), 6 con etiqueta (3811 MiB), 1 sin etiqueta en uso.**
  - [x] **No ejecutar ningún `prune` real.** El `README` lo dice: las operaciones de limpieza son reales y durante el desarrollo se contrasta la lectura, no la escritura.
- [x] **Fase 2: Contratos**
  - [x] `ImagePrunePreview`, `ImagePruneResult` en `app/schemas/image.py`.
  - [x] `ContainerPrunePreview`, `ContainerPruneResult` en `app/schemas/container.py`.
  - [x] Las cuatro interfaces en `frontend/src/types/image.ts` y `types/docker.ts`.
- [x] **Fase 3: Tests primero en backend (fase roja)**
  - [x] `test_image_prune.py` completo.
  - [x] `test_container_prune.py` completo.
  - [x] `pytest` en rojo por implementación ausente. **Hecho: `AttributeError` en los dos servicios.**
- [x] **Fase 4: Implementación backend**
  - [x] `ImageService.preview_prune()` y `ImageService.prune_images(all=...)`.
  - [x] `ContainerService.preview_prune()` y `ContainerService.prune_containers()`.
  - [x] Las cuatro rutas, **declaradas antes que `/{id}`**. Con test de contrato por HTTP en los dos routers.
  - [ ] `pruneImages(all)` y `pruneContainers()` en `dockerApi.ts`.
  - [x] **Tres desviaciones al implementar.** La tercera la encontró el reporte de un bug del prune de volúmenes (SPEC-08 §5.1): el filtro `all` del nivel agresivo iba como **booleano** (`{"all": True}`), y `clean_filters` de aiodocker lo serializa tal cual → `{"all": [true]}` → el daemon responde `400 invalid filter`. Tiene que ser la **cadena** `"true"`. El test lo fijaba con el valor equivocado porque nadie lo había ejecutado contra el daemon.
  - [x] **Dos desviaciones que son del doble de test.** `images.list()` devuelve **dicts planos** y `containers.list()` devuelve objetos con `_container`: son dos formas distintas en la misma librería, y un doble con la forma equivocada hace que `_get_image_dict` caiga en su rama de «no lo sé» y devuelva `{}` **sin dar ningún error**. Y el id de imagen lleva el prefijo `sha256:`, que `_short_id` conserva: son 19 caracteres, no 12.
- [x] **Fase 5: Tests primero en frontend (fase roja)**
  - [x] `tests/services/pruneApi.test.ts`.
  - [x] Extensión de `ImagesView.test.tsx` y `ContainersToolbar.test.tsx`.
- [x] **Fase 6: Implementación frontend**
  - [x] `usePrune` con los dos preavisos, y su error que **no** se convierte en lista vacía.
  - [x] `PruneDialog` compartido por los tres niveles, con los bytes en «hasta».
  - [x] Los dos niveles en `ImagesView`, con sus dos diálogos y `data-nivel` para que el test fije que no comparten aspecto.
  - [x] `ContainersToolbar` con la píldora y el diálogo, en la barra de `App.tsx`.
  - [x] **Un test existente tenía que arreglarse**, y por qué es un aviso: `contarContenedores()` de `tests/App.test.tsx` filtraba por `includes('/containers')`, así que la barra añadió una petición legítima y el contador dio 3 donde el test pregunta por 1. Un contador por prefijo ancho se rompe con cualquier sub-recurso nuevo; ahora excluye `/prune` y lo dice.
- [x] **Fase 7: Verificación y quality gates**
  - [x] `pytest` y `pnpm run test` en verde. **540 y 602.**
  - [x] `ruff`, `oxlint` y `pnpm run build` sin errores.
- [x] **Fase 8: Documentación**
  - [x] `specs/09-system-overview.md`: marcada la verificación manual que esta spec desbloquea, con el contraejemplo de por qué estaba bloqueada.
  - [x] `agent.md`: el orden de las rutas, `df` ≠ preaviso, las dos formas de `list()` y la cota de los bytes.
  - [x] `README.md`: los cuatro endpoints (43 en total) y una sección sobre los tres niveles de limpieza.
  - [x] `HelpModal.tsx`: qué es irreversible ahora y qué está protegido.

### 7.1 Lo que NO se hace, a propósito

- [ ] Limpiar la caché de build. Otra fuente, otro endpoint, otra confirmación (§1).
- [ ] `POST /system/prune`. Un solo botón cuyo recuento no se puede desglosar (§1).
- [ ] Filtro por etiqueta de compose al podar contenedores. El daemon lo acepta; es otro spec.
- [ ] Botón de limpieza en el panel del host. Ese panel es de lectura (§1).
- [ ] Deshacer una limpieza. No existe en Docker; se compensa con enseñar los nombres (§4.6).