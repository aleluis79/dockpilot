# SPEC-14: Explorador de Archivos Compose

## 1. Contexto y Objetivos
- **Problema**: Previsualizar un compose file exige hoy **copiar la ruta a mano** en un campo de texto. En el host de referencia hay 4 archivos compose y el panel solo conoce 1: `elasticsearch-local` deja su ruta en la etiqueta `config_files` que SPEC-11 ya lee, pero `full-editor`, `sica` y `tickets-app` no están en marcha, no dejan etiquetas y son invisibles para el panel. Es decir, el flujo obliga a teclear `/home/usuario/proyectos/sica/docker-compose.yml` de memoria, y equivocarse de archivo significa previsualizar el proyecto que no es. Un desplegable con lo ya conocido solo resolvería 1 de los 4 casos.
- **Objetivo**: Poder elegir el archivo compose desde el propio panel, navegando el host, y que la ruta se rellene sola. El explorador está **confinado al home del usuario** y solo devuelve **nombres**, nunca contenido de ficheros.
- **Alcance**:
  - Incluye:
    - Endpoint REST `GET /api/v1/compose/browse` que lista los subdirectorios y los ficheros YAML de un directorio.
    - Confinamiento a una raíz configurable, por defecto el home del usuario, comprobado sobre la ruta **resuelta**.
    - Selector en el modal de previsualización, con migas de pan, subida al directorio padre y conteo de entradas truncadas.
    - Los ficheros compose primero, y el resto de `.yml`/`.yaml` después, para que un archivo con nombre poco habitual siga siendo alcanzable.
  - No incluye (en esta spec):
    - **Abrir, previsualizar o editar el contenido de un fichero desde el explorador.** Solo se elige la ruta; leer el archivo sigue siendo cosa de SPEC-12.
    - **Buscar por nombre.** El explorador navega, no busca. `grep` en el terminal sigue siendo más rápido para eso.
    - **Salir de la raíz.** Un `..` en el borde de la raíz no sube, y un enlace simbólico que apunte fuera no se puede abrir. No hay forma de leer directorios fuera del home sin cambiar la configuración del backend. Esto no es solo del explorador: el plan y el ciclo de vida comparten el mismo confinamiento (§3.2), así que tampoco hay forma de *leer, escribir ni arrancar* un compose file fuera del home.
    - **Subir ficheros al host** ni escribirlos. Sigue siendo un panel de un solo operador que no toca el disco.
    - **Montar el proyecto desde el explorador.** Elegir el archivo rellena el campo y deja al usuario en el preview, que es donde vive la previsualización.

---

## 2. Contrato de Datos (Schemas & Types)

### 2.1 Backend (Pydantic v2) - `app/schemas/compose.py`

```python
from typing import Literal
from pydantic import BaseModel, Field

class BrowseEntry(BaseModel):
    """Una entrada del directorio: un subdirectorio o un fichero YAML.

    `es_compose` distingue los que tienen pinta de compose file para ponerlos
    primero, no para filtrarlos: un fichero con nombre poco habitual tiene que
    seguir siendo alcanzable escribiéndolo a mano.
    """
    name: str = Field(..., description="Nombre de la entrada, sin la ruta")
    path: str = Field(..., description="Ruta absoluta de la entrada")
    kind: Literal["dir", "file"] = "file"
    es_compose: bool = Field(False, description="El nombre parece un compose file")
    size: int = 0
    modificado: float = Field(0.0, description="mtime en epoch, para ordenar por fecha")

class BrowseResult(BaseModel):
    """El contenido de un directorio, ya confinado a la raíz."""
    path: str = Field(..., description="Ruta absoluta del directorio listado")
    root: str = Field(..., description="Raíz del confinamiento; los límites de navegación se derivan de aquí")
    parent: str | None = Field(
        None,
        description="Ruta del padre, o None si ya está en la raíz: el botón de subir se deshabilita",
    )
    entries: list[BrowseEntry] = Field(default_factory=list)
    total: int = Field(0, description="Entradas que había, antes de truncar")
    truncado: bool = Field(False, description="True si se ha limitado el número de entradas")
    ocultos: int = Field(
        0,
        description="Entradas omitidas por salir de la raíz a través de un enlace simbólico",
    )
```

### 2.2 Errores

`GET /api/v1/compose/browse` lleva un único parámetro, `path`:

| Situación | Código | Detalle |
| :--- | :--- | :--- |
| `path` no es absoluta | `400` | Hay que resolverla contra la raíz, igual que en SPEC-12 |
| La ruta resuelta sale de la raíz | `403` | Confinamiento; el mensaje lo dice sin revelar si el destino existe |
| No existe, o no es un directorio | `404` | |
| No se puede leer (permisos) | `403` | `PermissionError` de `os.scandir` |

Un `404` y un `403` se distinguen a propósito: no leer un directorio que existe pero no se puede abrir es información que el usuario ya tiene, y el panel es suyo.

### 2.3 Frontend (TypeScript) - `src/types/compose.ts`

```typescript
export interface BrowseEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  es_compose: boolean;
  size: number;
  modificado: number;
}

export interface BrowseResult {
  path: string;
  root: string;
  parent: string | null;
  entries: BrowseEntry[];
  total: number;
  truncado: boolean;
  ocultos: number;
}
```

---

## 3. Mecánica

### 3.1 Por qué esto no es un `<input type="file">`

Un `<input type="file">` del navegador entrega un `File` **sin ruta del host**: los navegadores lo hacen así a propósito, porque cualquier página podría si no aprender la estructura del disco del usuario. Como el `docker compose` se ejecuta en el **backend**, necesita una ruta real, así que el selector tiene que ser un endpoint propio. No hay versión de cinco líneas de esto.

### 3.2 El confinamiento, y por qué se mide sobre la ruta resuelta

La raíz es `COMPOSE_BROWSE_ROOT`, y por defecto el home del usuario:

```python
COMPOSE_BROWSE_ROOT: str | None = None   # None -> os.path.expanduser("~")
```

Es la misma raíz de la que cuelgan los dos riesgos reales:

1. **`..`**: `~/proyectos/../../etc` sale del home con solo escribirla. Se neutraliza resolviendo antes de comparar.
2. **Enlaces simbólicos**: un `~/.ssh` enlazado desde dentro del home pasa cualquier comparación de texto. Por eso la comparación se hace sobre `Path(...).resolve()` y **no** sobre la cadena recibida.

```python
objetivo = Path(path).resolve()          # resuelve .. y enlaces
raiz = Path(settings.COMPOSE_BROWSE_ROOT).resolve()
dentro = objetivo == raiz or raiz in objetivo.parents
if not dentro:
    raise HTTPException(403, ...)
```

`raiz in objetivo.parents` es la comprobación correcta y evita el fallo clásico de `str.startswith()`, que se comprobó en este host:

```text
raiz='/home/al', objetivo='/home/alejandro/proyectos'
  startswith('/home/al')    -> True    FUGA: acepta /home/alejandro
  startswith('/home/al/')   -> False   (por casualidad, no por diseño)
  raiz in objetivo.parents  -> False   correcto en todos los casos
```

Añadir el separador tampoco es una solución: con `raiz='/'` produce `startswith('//')`, que es *más* restrictivo de lo debido y rompería una raíz en la raíz del sistema. `parents` no tiene ninguno de los dos problemas y además funciona si algún día la raíz fuera un fichero.

**Los directorios cuyo `resolve()` sale de la raíz no se listan**, y su número se devuelve en `ocultos`. Un enlace simbólico a `~/.ssh` desaparece en vez de aparecer y fallar al entrar: más seguro y menos confuso que ofrecer algo que va a ser rechazado.

#### La misma raíz gobierna las tres entradas, no sólo el explorador

El explorador confina **lo que muestra**. Si el confinamiento se quedara aquí, sólo de lectura, seguiría habiendo escritura fuera de la raíz por las otras dos puertas, y el selector sería un adorno: seguirían desapareciendo de la pantalla archivos que el usuario sí puede desplegar.

Las tres entradas que aceptan una ruta del cliente comparten la misma raíz:

| Entrada | Spec | Qué haría sin confinamiento |
| :--- | :--- | :--- |
| `GET /api/v1/compose/browse` | SPEC-14 | Enumerar el disco fuera del home |
| `POST /api/v1/compose/plan` | SPEC-12 | **Leer** un compose file fuera del home, y con `content`, **escribirlo** en su directorio |
| `WS /ws/compose/{action}` | SPEC-13 y SPEC-15 | **Arrancar** un compose file fuera del home |

El caso del plan es el que obliga a tomárselo en serio: `build_plan` no se limita a leer, escribe un temporal con el contenido que mandó el cliente **junto al archivo original**, porque es lo que hace que los `env_file` y los `build.context` relativos sigan resolviendo (SPEC-12 §3.6). Un `path=/etc/docker-compose.yml` con `content` escribía en `/etc`. Por eso el confinamiento va **antes** de `exists()`, de `is_file()` y del `stat()`: ni un solo `stat` fuera de la raíz.

Las tres usan el mismo criterio por el mismo motivo que `parents` en vez de `startswith`: una regla escrita tres veces acaba siendo tres reglas. El helper es `resolver_ruta_explorador()`, y `_validar_ruta()` (SPEC-12) lo llama. Que el confinamiento viva en esta spec y no en SPEC-12 es deliberado: la raíz se define aquí, y las otras dos la consumen.

Un detalle que se gana de paso: SPEC-12 devuelve la ruta **resuelta** en vez de la cadena original, así que el temporal cae junto al archivo real y no junto al enlace simbólico por el que se entró.

#### `403` antes que `404`, y por qué no se distinguen

Fuera de la raíz, la respuesta es `403` **antes** de comprobar si el archivo existe. `403` y `404` comparten mensaje a propósito: distinguirlos convertiría el endpoint en un mapa del disco, porque bastaría con leer los códigos para enumerar qué hay fuera.

Un efecto secundario que hay que aceptar: una ruta **inexistente pero dentro de la raíz** sigue dando `404`, y una **fuera de la raíz** da `403` exista o no. Los tests de SPEC-12 y SPEC-13 usan `tmp_path` como raíz, también por esto y no por descuido.

### 3.3 Qué se devuelve, y qué no

Solo **nombres, tipos y tamaños**. Nunca contenido, y por una razón concreta: el contenido lo sirve SPEC-12 con su validación de tamaño y su lógica de errores, y duplicarlo aquí abriría una segunda vía de lectura de ficheros que nadie ha pedido.

Los directorios se listan siempre. Los ficheros, solo `.yml` y `.yaml`, y ordenados con los de nombre compose primero:

```text
compose.yml, compose.yaml, docker-compose.yml, docker-compose.yaml, *compose*.yml|yaml
```

El orden es porque el objetivo es elegir un compose file rápido, pero **no se filtran**: un archivo llamado `stack.yml` es un compose file perfectamente válido y tiene que ser alcanzable. El orden lo pone `es_compose`, que es el mismo criterio que aplica compose cuando busca ficheros de un directorio.

### 3.4 Límite de entradas

`~/proyectos` del host de referencia tiene 86 entradas. Se devuelven como máximo `COMPOSE_BROWSE_MAX` (500 por defecto) y el resto se comunica con `total` y `truncado`, no truncando en silencio: un listado que parece completo y no lo está es la misma traición que el plan de compose sin `profiles`.

El corte es **por directorios primero**, porque son los que hacen falta para navegar; los ficheros van después.

### 3.5 Endpoints REST

| Método | Endpoint | Respuesta | Errores |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/compose/browse?path=<abs>` | `200 OK` (`BrowseResult`) | `400`, `403`, `404` |

Es `GET` y no `POST`: no muta nada, y el `path` va en query como en el resto de endpoints de lectura. El caso más sencillo es la raíz, que es lo que se muestra al abrir el selector por primera vez.

La fila de arriba es la única que expone esta spec, pero el `403` es **el mismo código y el mismo mensaje** en las otras dos entradas con ruta de cliente (§3.2), porque comparten `resolver_ruta_explorador()`:

| Entrada | Errores de ruta | Spec propietaria |
| :--- | :--- | :--- |
| `GET /api/v1/compose/browse` | `400` relativa, `403` fuera de raíz, `404` no existe | SPEC-14 |
| `POST /api/v1/compose/plan` | `400` relativa, **`403` fuera de raíz**, `404` no existe, `413` demasiado grande | SPEC-12 |
| `WS /ws/compose/{action}` | `400` relativa, **`403` fuera de raíz**, `404` no existe, `404` acción no soportada | SPEC-13 |

En el WebSocket el `403` llega como frame `error` con `code: 403`, no como cierre, porque el cliente necesita poder mostrar el motivo junto al resto de la salida de la acción.

### 3.6 Superficie de usuario

- Botón **Seleccionar archivo** junto al campo de ruta, que abre el explorador.
- El explorador arranca en la raíz y muestra **migas de pan** con el camino completo, para no perderse en un árbol de doce niveles.
- **Subir** al padre, deshabilitado en la raíz: es la señal de que ahí termina el confinamiento, y por eso merece verse.
- Las entradas compose van arriba y marcadas; el resto, debajo y atenuadas.
- Al elegir un fichero se rellena el campo de ruta y se cierra el explorador. **No se valida automáticamente**: el preview sigue siendo un paso explícito, porque abrir un archivo y ejecutarlo no es lo mismo.
- Si hay truncado o entradas ocultas, un aviso discreto lo dice. Un directorio del home con 20 000 entradas no es raro, y sorprender al usuario con un listado incompleto sería peor que la lentitud.

---

## 4. Criterios de Aceptación (Gherkin en Español)

```gherkin
# language: es
Característica: Explorador de archivos compose
  Como usuario de DockPilot
  Quiero elegir el archivo compose desde el panel
  Para no tener que copiar rutas a mano y elegir el proyecto equivocado

  Antecedentes:
    Dado que el servidor backend de DockPilot está en ejecución
    Y la raíz del explorador es el home del usuario

  Escenario: Listar el directorio de proyectos
    Dado que el home del usuario tiene un directorio "proyectos" con subdirectorios
    Cuando el usuario abre el explorador de archivos
    Entonces el sistema responde con código HTTP 200 a "GET /api/v1/compose/browse"
    Y la respuesta incluye la raíz del explorador
    Y la respuesta incluye los subdirectorios de "proyectos"

  Escenario: Elegir un archivo rellena la ruta
    Dado que el usuario navega hasta un directorio con un fichero "docker-compose.yml"
    Cuando el usuario pulsa ese fichero
    Entonces el campo de ruta queda con su ruta absoluta
    Y el explorador se cierra
    Y no se ha ejecutado ninguna acción sobre Docker

  Escenario: Los ficheros compose aparecen primero
    Dado que un directorio tiene "docker-compose.yml" y otros ficheros YAML
    Cuando el usuario lista ese directorio
    Entonces el fichero compose aparece antes que los demás
    Y aparece marcado como compose

  Escenario: Un fichero YAML con nombre poco habitual sigue siendo alcanzable
    Dado que un directorio tiene un fichero "stack.yml" y ningún compose
    Cuando el usuario lista ese directorio
    Entonces "stack.yml" aparece en el listado

  Escenario: No se puede salir de la raíz con ".."
    Dado que el usuario está en la raíz del explorador
    Cuando el usuario intenta subir al directorio padre
    Entonces la respuesta indica que no hay directorio padre
    Y la interfaz no habilita el botón de subir

  Escenario: Una ruta con ".." que sale de la raíz se rechaza
    Dado que la raíz del explorador es el home del usuario
    Cuando se solicita listar una ruta que resuelve fuera del home
    Entonces el sistema responde con código 403
    Y no se devuelve el contenido de ese directorio

  Escenario: Un enlace simbólico que sale de la raíz no se lista
    Dado que hay un enlace simbólico dentro del home que apunta fuera de él
    Cuando el usuario lista el directorio que lo contiene
    Entonces esa entrada no aparece en el listado
    Y la respuesta informa de cuántas entradas se han omitido

  Escenario: Un directorio con muchas entradas avisa de que el listado está incompleto
    Dado que un directorio tiene más entradas que el máximo configurado
    Cuando el usuario lo lista
    Entonces la respuesta indica que el listado está truncado
    Y la respuesta indica cuántas entradas había en total

  Escenario: Directorio inexistente
    Dado que la ruta indicada no existe
    Cuando el usuario lista ese directorio
    Entonces el sistema responde con código 404

  Escenario: Directorio sin permiso de lectura
    Dado que el usuario no tiene permiso para leer un directorio
    Cuando el usuario intenta listarlo
    Entonces el sistema responde con código 403
    Y el mensaje explica que no se puede leer

  Escenario: Ruta relativa rechazada
    Dado que la ruta indicada no es absoluta
    Cuando el usuario intenta listarla
    Entonces el sistema responde con código 400
    Y no se ha tocado el sistema de archivos

  Escenario: El explorador nunca devuelve el contenido de un fichero
    Dado que un directorio tiene un fichero compose con secretos en su interior
    Cuando el usuario lista ese directorio
    Entonces la respuesta no incluye el contenido del fichero
    Y solo incluye su nombre, su tamaño y su fecha
```

---

## 5. Plan de Pruebas Automatizadas

### Backend (`pytest` + `pytest-asyncio`)
- `tests/test_compose_browse.py`, con `tmp_path` como raíz de las pruebas para no depender del disco real:
  - `test_lista_directorios_y_ficheros_compose`: devuelve las entradas esperadas de un directorio.
  - `test_ficheros_compose_antes_que_los_demases`: el orden y `es_compose` son correctos.
  - `test_fichero_yaml_no_compose_tambien_aparece`: `stack.yml` sale.
  - `test_sube_al_padre_hasta_la_raiz`: `parent` es correcto y `None` en la raíz.
  - `test_ruta_relativa_devuelve_400`: sin tocar el disco.
  - `test_ruta_que_sale_de_la_raiz_devuelve_403`: `..` y ruta absoluta fuera.
  - `test_raiz_prefijo_de_otra_ruta_no_cuenta`: el caso `/home/al` frente a `/home/alejandro`, que un `startswith` ingenuo aceptaría.
  - `test_enlace_simetrico_fuera_de_la_raiz_se_omite`: se crea un symlink a un directorio externo y no aparece en el listado, con `ocultos` incrementado.
  - `test_trunca_y_lo_dice`: más entradas que el máximo → `truncado=True` y `total` correcto.
  - `test_directorio_inexistente_devuelve_404`.
  - `test_directorio_sin_permiso_devuelve_403`.
  - `test_no_devuelve_el_contenido_de_los_ficheros`: ninguna clave del resultado lleva el texto del fichero.
- El cliente HTTP usa el mismo `mock_docker` de siempre: el explorador **no habla con Docker**, y que el test lo demuestre es parte de su valor.

### Frontend (`vitest` + `@testing-library/react`)
- `tests/components/compose/ComposeFilePicker.test.tsx`:
  - Arranca en la raíz y pide el listado.
  - Muestra las migas de pan con el camino completo.
  - Navegar a un subdirectorio pide el listado de ese directorio.
  - Subir al padre pide el listado del padre, y el botón queda deshabilitado en la raíz.
  - Pulsar un fichero llama a `onSelect` con su ruta y no con la del directorio.
  - Avisa cuando el listado llega truncado, con el total.
  - Avisa de las entradas omitidas por salir de la raíz.
  - Muestra el error del backend (403, 404) sin romperse.
  - **No llama a `onSelect` al abrir**: elegir el fichero y previsualizarlo son pasos separados.
- `tests/components/compose/ComposePlanModal.test.tsx` (ampliar): el botón de seleccionar abre el explorador y lo elegido rellena el campo de ruta.

---

## 6. Plan de Tareas (Tasks)

> Las seis fases quedaron completadas y verificadas contra el disco real.

- [x] **Fase 1: Contratos**
  - [x] Añadir `COMPOSE_BROWSE_ROOT` y `COMPOSE_BROWSE_MAX` a `app/core/config.py`, con el home como valor por defecto
  - [x] Añadir `BrowseEntry` y `BrowseResult` a `app/schemas/compose.py`
  - [x] Añadir `BrowseEntry` y `BrowseResult` a `frontend/src/types/compose.ts`
- [x] **Fase 2: Tests Primero en Backend (TDD)**
  - [x] Crear `backend/tests/test_compose_browse.py` con los casos de la sección 5, usando `tmp_path` como raíz
  - [x] Ejecutar `pytest -v` y confirmar que falla por implementación ausente (fase roja)
- [x] **Fase 3: Implementación Backend**
  - [x] Implementar `_resolver_dentro()` en `app/services/compose_service.py`, resolviendo antes de comparar y usando `parents` en lugar de `startswith` (el nombre es `_resolver_dentro`, no `_confinar`: además de confinar devuelve la ruta ya resuelta, que es lo que necesitan SPEC-12 y SPEC-13)
  - [x] Implementar `browse()` con `os.scandir`, el orden compose primero, la omisión de enlaces fuera de raíz y el truncado
  - [x] Traducir `OSError` a `403` y el directorio inexistente a `404`
  - [x] Registrar `GET /compose/browse` en `app/api/v1/compose.py`
  - [x] Ejecutar `pytest -v` y validar aprobación al 100%
- [x] **Fase 4: Tests Primero en Frontend**
  - [x] Crear `frontend/tests/components/compose/ComposeFilePicker.test.tsx`
  - [x] Ampliar `frontend/tests/components/compose/ComposePlanModal.test.tsx` con el botón y el relleno de la ruta
  - [x] Ejecutar `vitest` y confirmar que los casos nuevos fallan por implementación ausente (fase roja)
- [x] **Fase 5: Implementación Frontend**
  - [x] Añadir `browseComposeFiles` a `frontend/src/services/dockerApi.ts`
  - [x] Implementar `ComposeFilePicker.tsx` con migas de pan, subida al padre y los avisos de truncado y omisión
  - [x] Añadir el botón **Seleccionar archivo** al `ComposePlanModal` y rellenar la ruta al elegir
  - [x] Ejecutar `vitest` y validar aprobación al 100%
- [x] **Fase 6: Verificación y Quality Gates**
  - [x] Ejecutar y aprobar la suite backend (`make backend-test`) y el lint (`make backend-lint`)
  - [x] Ejecutar y aprobar la suite frontend (`pnpm run test`, `pnpm run lint`, `pnpm run build`)
  - [x] Comprobar con el navegador que los 4 compose files del host son alcanzables desde el selector
  - [x] Actualizar `agent.md` (árboles, `specs/14-compose-file-browser.md`) y marcar las tareas como completadas (`[x]`)
- [x] **Fase 7: Extender el confinamiento a las otras dos entradas**
  - [x] Añadir `resolver_ruta_explorador()` como única puerta al criterio, y que `_validar_ruta()` (SPEC-12) lo use en vez de repetirlo
  - [x] Devolver desde `_validar_ruta()` la ruta **resuelta**, para que el temporal de SPEC-12 caiga junto al archivo real y no junto al enlace simbólico
  - [x] Confinar `POST /api/v1/compose/plan` antes de `exists()`/`is_file()`/`stat()`
  - [x] Confinar `WS /ws/compose/{action}` (SPEC-13 y SPEC-15) con el mismo código y mensaje, traduciéndolo a frame `error` con `code: 403`
  - [x] Anclar `COMPOSE_BROWSE_ROOT` a `tmp_path` en el fixture `archivo` de `conftest.py`, compartido por SPEC-12 y SPEC-13
  - [x] Tests: `test_una_ruta_fuera_de_la_raiz_da_403` y `test_el_contenido_editado_no_se_escribe_fuera_de_la_raiz` en `test_compose_plan.py`; `test_una_ruta_fuera_de_la_raiz_no_arranca_nada` en `test_compose_ws.py`
  - [x] Actualizar las tablas de errores de SPEC-12 y SPEC-13, y `agent.md`
