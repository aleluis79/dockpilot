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

#### El confinamiento de las rutas compose: tres entradas, una sola regla (SPEC-14, y SPEC-12/13/15 la consumen)
El explorador de archivos existe porque la ruta había que copiarla a mano, y eso acababa en previsualizar el proyecto equivocado: en el host de referencia hay 4 compose files y el inventario solo conoce 1, porque los otros tres no están en marcha y no dejan etiquetas.

Tres reglas que **no se pueden relajar** sin romper el modelo de seguridad:

1. **El confinamiento se comprueba sobre la ruta ya resuelta.** `Path(path).resolve()` y luego `raiz in objetivo.parents`. Nunca `str.startswith()`: sin separador acepta `/home/alejandro` para una raíz `/home/al`, y con separador rechaza todo cuando la raíz es `/` porque buscaría `//`. Un enlace simbólico a `~/.ssh` colado en el home pasa cualquier comparación de texto, y `resolve()` es lo único que lo para.
2. **Solo el explorador devuelve nombres, tipos y tamaños. Nunca contenido.** Leer el archivo es de `build_plan` (SPEC-12), con su límite de tamaño y su validación. Una segunda vía de lectura sería superficie que nadie pidió.
3. **Sin `path` se devuelve la raíz, y la raíz la dice el backend.** El cliente no puede deducirla: `~` apunta al home del usuario del **backend**, no al del navegador. Si el cliente calculara la raíz por su cuenta, la regla de confinamiento estaría en dos sitios y tarde o temprano discreparían.

**Y la regla aplica a las TRES entradas que aceptan una ruta del cliente, no sólo al explorador:**

| Entrada | Spec | Sin confinamiento |
| :--- | :--- | :--- |
| `GET /api/v1/compose/browse` | SPEC-14 | Enumerar el disco fuera del home |
| `POST /api/v1/compose/plan` | SPEC-12 | **Leer** fuera del home y, con `content`, **escribir** en el directorio del archivo |
| `WS /ws/compose/{action}` | SPEC-13, SPEC-15 | **Arrancar y parar** proyectos fuera del home |

El caso del plan es el que obliga a tomárselo en serio: con `content`, `build_plan` vuelca lo que mandó el cliente en un temporal **junto al archivo original**, porque es lo que hace que los `env_file` y los `build.context` relativos sigan resolviendo. Un `path=/etc/docker-compose.yml` escribía en `/etc`. Y el caso del WebSocket es el que lo hace una puerta real, no decorativa: es lo que arranca proyectos de verdad, y sólo comprobaba que la ruta fuera absoluta y que existiera.

Tres detalles que salen de compartir una sola regla:

- **El confinamiento va antes de `exists()`, `is_file()` y `stat()`.** Ni un solo `stat` fuera de la raíz.
- **`403` antes que `404`, y con el mismo mensaje exista o no el destino.** Distinguirlos convertiría el endpoint en un mapa del disco. Efecto secundario que hay que aceptar: una ruta **inexistente pero dentro de la raíz** da `404`, y una **fuera de la raíz** da `403` exista o no. Los tests usan `tmp_path` como raíz por eso.
- **`_validar_ruta()` devuelve la ruta resuelta, no la recibida.** Así el temporal cae junto al archivo real y no junto al enlace simbólico por el que se entró.

La puerta única al criterio es `compose_service.resolver_ruta_explorador()`; `_validar_ruta()` (SPEC-12) y el handler del WebSocket (SPEC-13) la llaman. Que viva en SPEC-14 y no en SPEC-12 es deliberado: la raíz se define ahí, las otras la consumen. Una regla escrita tres veces acaba siendo tres reglas.

El fixture `archivo` de `backend/tests/conftest.py` ancla `COMPOSE_BROWSE_ROOT` a `tmp_path` por esto: sin eso, cualquier test de SPEC-12 o SPEC-13 con un archivo de `/tmp/pytest-...` recibe `403` antes de llegar al CLI.

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

Esa última obligación **no tiene equivalente posible en el exec de la terminal**, y conviene saberlo antes de intentar: el proceso de un `exec` de Docker **no está atado** a la vida de la conexión hijackeada, y Docker **no expone ninguna API para matarlo** (no hay `DELETE /exec/{id}`, y `resize` no mata). Cerrar el stream manda `write_eof()`, y con `/bin/sh` y `tty=False` eso basta porque el shell sale al recibir el EOF; con `tty=True` —o con `?shell=/bin/bash`, que es lo que mandan casi todos los clientes de terminal— no lo ve y sobrevive a cada pestaña cerrada.

`_avisar_si_el_exec_sobrevive()` hace lo único honesto: `Exec.inspect()` y, si `Running` sigue a `True`, un `logger.warning` que lo dice. Preferible a fingir que el cierre lo limpia, y desde luego preferible a un silencio que acumula execs huérfanos en el contenedor sin que nada lo mencione.

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

**Las formas de `/system/df` no son planas**, y adivinar la clave es como `build_cache_size` terminó siempre en 0: `BuildCacheUsage` no es un entero, es un bloque como los demás (`TotalCount`, `ActiveCount`, `TotalSize`, `Reclaimable`, `Items`), así que su tamaño hay que leerlo de `["TotalSize"]`. Lo que sí es un entero de primer nivel es `LayersSize`. Y los volúmenes no traen `Size` ni `RefCount` en el nivel superior: van anidados en cada `Item` bajo `UsageData` (SPEC-08 §3.1).

Cuando el doble de test modele mal una forma, **el test pasa por la razón equivocada** y encima tapa el bug real: el doble tenía `"BuildCacheUsage": 123456789` como entero, `_as_int(dict)` devuelve 0, y la aserción de "vale 123456789" no existía. Cuando se corrige el doble hay que corregir también la aserción, o el 0 vuelve a ser indistinguible de "este host no tiene caché de build".

**Un `0` que significa "no se sé" se propaga como si fuera un dato.** Si una lectura opcional falla y se devuelve un dict vacío, todo contador que se derive de ella sale a cero, y un filtro de "¿cuáles no están en uso?" pasa a listar **todos**, incluidos los que montan contenedores vivos. Es el caso de `VolumeService._usage_index()` cuando `/system/df` no responde: `_usage_index` devuelve `None` (no `{}`), `count_unused` responde **503** en vez de dar una lista que no puede sostener, y el esquema lleva `usage_known: bool` para que la UI pueda decir "el daemon no informó" en vez de "Sin usar". El patrón: **"no lo sé" tiene que ser representable**; si no lo es, acaba viajando como un cero y alguien lo lee como un hecho.

#### Trampa: el `status` de un `DockerError` no es un código HTTP

aiodocker lanza `DockerError(900, "Cannot connect to Docker Engine via ...")` cuando no puede hablar con el daemon. Ese **900 no es un código HTTP**, y pasarlo tal cual a `HTTPException(status_code=e.status)` hace que uvicorn indexe `STATUS_LINE[900]` y reviente con `KeyError`: el cliente recibe **nada**, `curl: (52) Empty reply from server`. No sale un 500 ni un error: no sale respuesta.

Es el fallo más probable de todo el panel —dockerd parado, socket con otros permisos, daemon reiniciando—, así que la regla es: **nunca `status_code=e.status`**. El helper es `docker_error_status()`, en `app/core/docker.py`, y traduce a `503` cualquier cosa que no caiga en `[400, 600)`: el 900 de aiodocker, el 0 de `DockerStreamError`, y los 3xx, que tampoco pueden llevar cuerpo de error.

La comprobación vive en `backend/tests/test_docker_errors.py`, que barre los endpoints reales con el daemon caído y verifica que ninguno devuelve un status que no se pueda servir. Si alguien vuelve a escribir `status_code=e.status`, esa lista se cae.

#### Trampa: `DockerStreamError.status` es `0`, y `0` en el payload engaña

El rechazo del registro al descargar una imagen (repo inexistente, registro privado) llega con **HTTP 200** y un chunk `{"error": ...}` dentro del stream. aiodocker 0.27 lo levanta como `DockerStreamError`, una subclase de `DockerError` que **fija `status=0`** porque para la petición HTTP no hubo fallo. El código real va en `error_detail["code"]`.

Con `code=e.status` el frontend recibía `{"type": "error", "code": 0}`: un `0` en un campo con forma de código HTTP es indistinguible del éxito. `pull_error_code()` en `image_service.py` lee `error_detail["code"]`, y si no está deduce del texto (403/404/429/507), con 502 por defecto porque el registro es un servicio externo.

El doble de `tests/conftest.py` levantaba `DockerError(404, ...)`, que es la forma de las versiones antiguas de aiodocker y que la librería ya no produce. **Cuando el doble modela mal la librería, el test pasa por la razón equivocada**: ahora levanta `DockerStreamError` con `error_detail`.

#### Trampa: `receive()` de Starlette no lanza `WebSocketDisconnect`

`receive_json()` no tiene guarda. Un frame de texto que no es JSON lanza `JSONDecodeError` (un `ValueError`), y uno **binario** llega sin la clave `"text"`, así que el `message["text"]` de Starlette es un **`KeyError`**, no un `TypeError`. Si eso escapa del handler del vigía de compose, el `finally` cancela la acción en curso y `ejecutar_accion` la marca como cancelada: un error de protocolo se le comunicaba al usuario como "lo cancelaste tú".

Más subtil todavía: **`receive()` sí devuelve el mensaje de desconexión, no lo lanza**. Solo `receive_text()` lanza `WebSocketDisconnect`. Un vigía que hace `while True: await websocket.receive()` se queda pidiendo un segundo mensaje que no va a llegar, así que hay que mirar `mensaje["type"] == "websocket.disconnect"` a mano.

#### Trampa: un WebSocket que sólo escribe no detecta al cliente que se va

Starlette sólo se entera de una desconexión cuando alguien llama a `receive()`. Un handler que hace `async for` sobre un stream de Docker y solo manda mensajes no lo llama nunca, así que con un contenedor parado o inactivo se queda bloqueado en la lectura **para siempre**, con la conexión hijackeada de aiohttp. Cerrar la vista consumía una conexión del connector por visita, y tras ~100 el connector se agota y **toda** llamada a Docker empieza a fallar.

El patrón es el de SPEC-13: un envío en una tarea, un vigía en `receive()` en otra, `asyncio.wait(FIRST_COMPLETED)` y `gather` en el `finally`. Y el generador de aiodocker necesita `aclosing()`, o su `ClientResponse` no se suelta hasta que pase el finalizador del bucle de eventos.

Del lado del cliente, el cierre con código `1000` es **terminal** y no debe reconectar: es el cierre normal del backend cuando el stream se acaba, y reconectar ahí convertía la vista «Métricas» en un bucle infinito de 0.5 Hz contra el daemon (`stats()` sobre un contenedor parado falla con 409, el backend lo cuenta como fin de stream, cierra con 1000 otra vez…). Solo `4400` y `4404` son terminales por nombre; `1006` y `1011` sí se reintentan, con espera creciente y tope.

#### Trampa: un stream sin fin no lleva plazo

`TIMEOUTS_S["logs"] = 60` se aplicaba a `logs --follow`, que no termina nunca por definición. `asyncio.timeout` lo mataba a los 60 segundos y el cliente recibía un `504` seguido de `exit -1` aunque nada hubiera fallado. `timeout_de(action, follow)` devuelve `None` para ese caso, y `asyncio.timeout(None)` no arma reloj, así que el resto del código no cambia.

Corolario: el **timeout no es una cancelación**. El `finally` del generador lo marcaba como `cancelada` y salía con `codigo=None`, que el handler traducía a `CODIGO_CANCELADO` (-1). El usuario veía "cancelado" sin haber cancelado nada. Hay un código aparte, `CODIGO_TIMEOUT = 124`, el de `timeout(1)`, que es un valor que el proceso real nunca devuelve.

**SPEC-13 reutiliza este runner** y no abre un segundo camino de ejecución. El canal es **uno solo** (`/ws/compose/{action}`, con la acción validada contra una lista cerrada) y no cinco: cinco handlers casi idénticos serían cinco sitios donde olvidar el `finally` que mata el proceso.

#### Trampa: un modal siempre montado conserva su estado entre aperturas

`ContainerDetailModal`, `ImageDetailModal` y `VolumeDetailModal` los tienen sus padres **siempre montados** y sólo hacen `return null` al cerrar. Su `detail` sobrevive a cada ciclo de cerrar y abrir, así que abrir el recurso B tras el A mostraba los datos de A —imagen, estado, puertos, variables, contenedores que lo usan— bajo el nombre y el id de B, hasta que llegaba la respuesta de B.

Tres reglas que salen de ahí:

- **Al cambiar el objetivo se limpia el estado**: `setDetail(null)`, `setError(null)` y `setLoading(true)` al principio del efecto, antes de pedir. Un loading que sólo se pone a `false` nunca se ve.
- **`loading` derivado de `detail === null && error === null`** es mejor que un estado aparte, porque no puede desincronizarse del fetcho.
- **Lo mismo para un formulario**: `CreateContainerModal` vive montado, así que imagen, puertos y variables del intento anterior se reenviaban con el botón ya habilitado. Se resetea en un efecto que reacciona a `isOpen === false`, con cuidado de **no** pisar la imagen preestablecida por el padre (`initialImage`), que viene de pulsar "crear desde esta imagen" en la tabla.

`NetworkDetailModal` ya lo hacía bien con `setDetail(null)`, y esa asimetría era la pista.

Relacionado: **un plan o un preview pertenece al archivo que se validó, no al que ahora dice el campo de ruta.** `ComposePlanModal` lo borraba al elegir con el explorador pero no al escribir la ruta a mano, así que validar `/a/dc.yml`, retipear `/b/dc.yml` y pulsar Desplegar ejecutaba `/a` mientras la interfaz anunciaba `/b`. El preview que se ve y lo que se ejecuta no pueden discrepar.

Y **una insignia que ningún llamador puede activar es código muerto**: `ComposeEditor` tenía un badge de "editado" contra un prop `original` que `ComposePlanModal` nunca pasaba, así que la rama era inalcanzable. Se quitó en vez de darle una semántica nueva, porque el editor **nunca carga el contenido del disco** (leerlo aquí abriría una segunda vía de lectura sin límite de tamaño propio, SPEC-14 §3.3) y sin el original no hay contra qué comparar. El aviso de verdad vive en `ComposePlanModal`, junto al botón de desplegar que depende de él.

#### Trampa: aiodocker tira el byte de stream de los logs

Docker multiplexa stdout y stderr en un solo stream con una cabecera de 8 bytes por frame: `>BxxxL`, donde **el primer byte ES el stream** y los cuatro últimos su longitud. aiodocker lo lee con `_, length = struct.unpack(">BxxxL", header)` y **descarta ese byte** (`MultiplexedResult.fetch`), así que con `container.log()` no hay forma de saber de qué stream salió una línea.

La consecuencia era que el stream se adivinaba por el texto: `error` o `fatal` en los primeros caracteres, lo que arrastraba a stderr cualquier línea de stdout que empezara por "Error" y la sacaba del filtro del visor. Endurecer el patrón sólo cambiaba *qué* frases se confundían.

`container_service._stream_demultiplexado()` lee el stream por la vía cruda (`docker._query`) y devuelve `(stream, línea)` con el byte real. El snapshot REST y el WebSocket usan **los dos** el mismo camino, porque si uno contara por el byte y el otro por el texto, una línea cambiaría de stream a mitad de la vista.

Detalles que no son evidentes:

- **El buffer no se reparte por stream.** Si una línea se parte entre un frame de stdout y otro de stderr, es la misma línea; cortarla por stream la trocearía en dos. Se acumula un único buffer y se corta por `\n`.
- **Con `tty=True` no hay cabecera**: sale todo por stdout, y es el caso `raw` de aiodocker. Se detecta por el `Config.Tty` del contenedor.
- **El doble de test tiene que emitir la cabecera de verdad** (`struct.pack(">BxxxL", ...)`). Un doble que devuelve líneas sueltas deja el stream en `None`, todo se marca stdout y los tests pasan sin haber tocado el camino real.

Es la única parte del backend que **no** usa los métodos de `DockerContainer`, a propósito: `MultiplexedResult` descarta el byte y no hay forma de recuperarlo por debajo. El proyecto ya usa primitivas internas de aiodocker en otros sitios (`_query_json` para redes y para `/system/df`), así que no es una excepción nueva.


#### Healthchecks: el dato está en tres sitios y no es el mismo (SPEC-18)

Docker expone la salud del contenedor en **dos** endpoints con **formas distintas**, y confundirlas rompe el panel de tres maneras:

| Dónde | Sin healthcheck | Con healthcheck |
| :--- | :--- | :--- |
| `containers/json` -> `Health` | `{"Status": "none", "FailingStreak": 0}` | `{"Status": "healthy", ...}` |
| `containers/{id}/json` -> `State.Health` | **la clave no existe** | `{Status, FailingStreak, **Log**}` |
| `containers/{id}/json` -> `Config.Healthcheck.Test` | `null` | `["CMD-SHELL", "exit 0"]` |

Tres reglas que salen de esa tabla:

- **En el listado `"none"` es un valor; en el detalle la ausencia es `None`.** No es la misma forma en los dos sitios, y tratarlas igual haría que un contenedor sin sonda pareciera evaluado saliendo bien.
- **El listado trae la salud y el detalle trae el porqué.** `Health` en `containers/json` es lo que permite pintar la píldora **sin ni una llamada extra**: no hay un `show()` por contenedor. Hay un test que lo verifica (`test_el_listado_no_hace_inspect_por_contenedor`) porque el N+1 sería la forma fácil de hacerlo mal.
- **`Health` en el listado sólo existe en Docker >= 20.10.** Un daemon más viejo no manda la clave y el panel tiene que funcionar igual, tratando la ausencia como `"none"`.

Dos cosas más que costaron sangre:

- **`ContainerDetail` re-declara `health` con el tipo estrecho, y no es opcional.** Pydantic recorta el valor al tipo del campo declarado en el padre, así que si `ContainerDetail` no re-declarase, un `HealthDetail` entero se serializaría como `HealthSummary` y `log` y `test` desaparecerían **sin lanzar ningún error**. Es el tipo de bug que un test de contrato por HTTP sí pilla y una prueba unitaria del servicio no.
- **La salida de una sonda ya viene recortada por el daemon, a 4096 bytes.** Medido: una sonda que imprimía 3 MB llega con `len(Output) == 4099`. El recorte del panel es defensa en profundidad, no la barrera principal, y el comentario del código lo dice así para que nadie lo justifique con un motivo falso.

Y la decisión de UI que más se nota: **sin healthcheck no se pinta nada**. De los contenedores del host de referencia, la mayoría no declara sonda, así que un "none" al lado de cada uno sería gritar sobre lo que no está mal. El estado de ejecución (`running`, `exited`) sigue siendo el titular de la píldora y la salud va al lado como marca secundaria: son ejes distintos y un contenedor puede estar parado y sano a la vez.

El filtro de salud va **en el navegador**, no en el daemon, por el mismo motivo que el de estado: los contadores de las píldoras son un censo del host y pedirle al daemon sólo los `unhealthy` los haría bailar. El parámetro `?health=` sí existe en la API porque es la superficie correcta para quien la llame directamente.

#### Renombrar: hay un validador de redes y NO sirve (SPEC-19)

Docker acepta el rename con `POST /containers/{id}/rename`, y es **barato**: no hay recreate, así que el id, el estado y los volúmenes no cambian, y como el panel identifica por id ninguna WebSocket se rompe. Lo que **no** se puede modificar son los puertos: `POST /containers/{id}/update` acepta `PortBindings`, devuelve `{"Warnings": null}` y **no cambia nada**. Si alguna vez se implementa "modificar puertos" con `update`, la UI confirmará un cambio que no ocurrió.

Las reglas del nombre se midieron contra el daemon y son tres, y **el validador de redes no sirve**:

| | Redes | Contenedores |
| :--- | :--- | :--- |
| Patrón | `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$` (`*`) | `^[a-zA-Z0-9][a-zA-Z0-9_.-]+$` (`+`) |
| Mínimo | 1 carácter | **2 caracteres** |
| Longitud máxima | 63 (la impone el daemon) | **el daemon no impone ninguna** (aceptó 300) |

Mismo comienzo, aridad distinta: `network_service.NAME_PATTERN` con `*` **acepta un nombre de un carácter que Docker rechaza**. El de contenedores es propio (`_validar_nombre_contenedor` y `utils/containerName.ts`, que son copia deliberada: el backend valida porque es la frontera, el cliente valida para que sea instantáneo).

Y el `MAX_NOMBRE = 63` del panel es **una decisión propia**: los contenedores no tienen tope en el daemon, pero 63 es lo que usa una etiqueta DNS, y un nombre más largo no puede resolver en una red personalizada.

Dos cosas que se creían buenas y no lo eran:

- **`HostConfig.NetworkMode` no sirve para saber si el nombre es un nombre DNS.** Es sólo la red *principal*: un contenedor en `bridge` conectado además a una red propia sigue diciendo `bridge`, que es justo el caso en el que el nombre sí resuelve. Hay que mirar el conjunto de `NetworkSettings.Networks` (`redPropia()` en el cliente).
- **Bloquear contenedores de compose era una restricción inventada.** Compose los identifica por **etiquetas**, no por nombre: `up` sigue idempotente, `down` los borra bien, y también funciona con `container_name:` explícito. Comprobado montando un proyecto de prueba, no de palabra.

El `409` del daemon trae el id del contenedor que ocupa el nombre, que el usuario nunca ve; se traduce a "Ya existe un contenedor llamado 'x'". Y la prevalidación de unicidad compara contra el inventario ya cargado, que sabe los nombres sin llamar al daemon: el `409` sigue siendo la verdad, pero es el caso raro.

#### Trampa: un búfer de stream sin tope no es sólo memoria

El visor de logs de contenedor corta a 2000 entradas. El de compose **no cortaba nada**, y `ComposeLogsViewer` vuelve a trocear el historial entero en cada fragmento: un `logs --follow` de un servicio que parlaba mucho se convertía en O(n²) de CPU además de un heap sin límite.

`utils/buffer.ts` tiene `acumular()`, una función pura que devuelve un array nuevo recortado por el frente. Pura a propósito: si devolviera el mismo array, React lo compararía por identidad y no re-renderizaría aunque los datos cambiasn. **Todas** las ramas de inserción tienen que pasar por ella, incluida la de texto plano: `useDockerLogs` tenía el recorte en la rama JSON y no en la del `catch`, así que cualquier frame que no se supiera parsear crecía sin límite.

El mismo cuidado aplica al `status` de un hook con WebSocket: si se asignan `onmessage` y `onerror` pero **no `onclose`**, una caída de red deja el estado en el valor de "en curso" para siempre. En `useImagePull` eso era el spinner de la descarga girando eternamente con el pie diciendo "cerrar cancela la descarga" y sin error alguno. El `onclose` sólo pisa el estado si la operación **seguía** en curso: un `1000` limpio después de un `done` no es un fallo.

#### Trampa: un hook en `App` no se desmonta al cambiar de pestaña
`useContainers` se llama desde `App`, no desde una vista, así que **vive todo el tiempo que la app**. Solo pedía datos al montarse y al cambiar el filtro de estado, nunca al cambiar de pestaña. El síntoma era desconcertante: desplegar un proyecto desde «Proyectos» dejaba la lista de contenedores obsoleta y los contenedores nuevos no aparecían hasta tocar el filtro, porque eso era lo único que disparaba un refetch.

Las otras vistas no tienen el problema: `VolumesView`, `NetworksView` y `ProjectsView` son componentes que piden sus datos al montarse, así que se recargan al volver a su pestaña.

La regla que se sigue ahora: **un hook que pinte una vista recibe `activo` y refresca al activarse**, saltando la primera vez para no duplicar la carga inicial, y con el `refetch` en un ref para no re-dispararse en cada cambio de filtro.

No se movió el hook a una vista propia a propósito: `App` tiene siete estados de modales de contenedores (detalle, logs, stats, terminal, borrado, alta) que habría que subir o mover, y el arreglo/refresco cubre el bug sin tocar ese refactor.

Y hay una regla fácil de romper en el mismo hook: **el filtro de estado se aplica en el navegador, no en el servidor**. El backend lo admite (`GET /containers?status=...`), pero pedir solo los de un estado hacía que los contadores de las pills bailaran —se calculan sobre la lista completa, así que al elegir «Activos» el contador de «Todos» marcaba el número de activos y los otros dos caían a cero— y convertía cada clic en un filtro en una ida y vuelta al daemon. Los contadores son un censo del host, no un recuento de lo que se está viendo.

#### La paleta de gráfico y el agujero del guard (SPEC-16)
`index.css` tiene diez tokens **neutros** y ocho **semánticos** de gráfico (`--color-chart-running`, `--color-chart-images`, …), con su par claro y oscuro. Sin ellos una barra por categorías sale gris sobre gris.

**El guard de tokens también escanea atributos de SVG.** Antes solo buscaba clases de utilidad en el `className`, así que un `stroke="#3b82f6"` pasaba desapercibido — y no era hipotético: los sparklines de CPU y memoria de `StatsModal` llevaban dos hexos fijos que **no cambiaban con el tema**. Un `div` con `width` porcentual o un `<path stroke>` llevan el color como **atributo de estilo**, no como clase, y por eso hacen falta las dos comprobaciones.

Las gráficas del sistema son census: instantáneas, sin histórico. **No hay series temporales** porque el backend es sin estado y no tiene buffer; y `cpu_percent` va multiplicado por `online_cpus`, así que 100% es *un* núcleo y sin dividir por `NCPU` una gráfica de host daría 1200 %.

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
│   ├── 15-compose-deploy-from-plan.md # Spec: Desplegar un compose file desde el plan (up, coste de build)
│   ├── 16-host-census-dashboard.md  # Spec: Panel de censo del host con barras apiladas
│   ├── 18-container-healthchecks.md  # Spec: Salud del healthcheck en listado, detalle y filtro
│   ├── 19-container-rename.md       # Spec: Renombrar un contenedor desde su detalle
│   └── 16-host-census-dashboard.md # Spec: Dashboard de censo del host (barras, paleta de gráfico)
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
│   │   │   ├── container.py      # HealthSummary/HealthDetail (SPEC-18)
│   │   │   ├── image.py
│   │   │   ├── log.py
│   │   │   ├── network.py
│   │   │   ├── stats.py
│   │   │   ├── system.py
│   │   │   ├── terminal.py
│   │   │   └── volume.py
│   │   ├── services/
│   │   │   ├── compose_cli.py      # ÚNICO módulo que lanza procesos (SPEC-12)
│   │   │   ├── compose_service.py  # Inventario (SPEC-11), build_plan (SPEC-12) y el confinamiento
│   │   │                      # de rutas que comparten browse, plan y ciclo de vida (SPEC-14)
│   │   ├── container_service.py
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
│   │   ├── test_docker_errors.py  # Ningún endpoint devuelve un status que no se pueda servir
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
│   │   │   │   └── charts/      # StackedBar, ConsumerBars (SPEC-16)
│   │   │   ├── compose/           # ProjectsView, ProjectsTable, ProjectDetailModal, ComposeBadge,
│   │   │   │                     # ComposePlanModal, ComposeEditor, ComposeActionPanel,
│   │   │   │                     # ComposeDownDialog, ComposeLogsViewer, ComposeFilePicker,
│   │   │                     # ComposeActionPanel, ComposeDeployDialog
│   │   │   └── help/              # HelpModal
│   │   ├── hooks/                 # useContainers, useDockerLogs, useDockerStats, useTheme, useImagePull,
│   │   │                         # useNetworks, useSystemOverview, useComposeProjects, useComposeCommand
│   │   ├── services/              # dockerApi.ts, wsUrl.ts
│   │   ├── types/                 # docker.ts, log.ts, terminal.ts, stats.ts, theme.ts, image.ts, volume.ts, network.ts, system.ts, compose.ts
│   │   ├── utils/                 # format.ts (formatBytes, formatPercent), compose.ts (rutaDeProyecto),
│   │   │                         # buffer.ts (acumular: búfer acotado para streams),
│   │   │                         # containerName.ts (reglas de nombre de contenedor, SPEC-19)
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
python -m ruff check app tests                   # Lint de código Y de tests (config en backend/pyproject.toml)
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

> **`tests/` entra en el lint, y por una razón concreta.** Se encontró un test que usaba `DockerError` sin importarlo: el `NameError` lo convertía el `except Exception` genérico en un `500`, y la prueba pasaba verde sin haber pasado nunca por la rama de `DockerError` que pretendía ejercitar. Ruff no lo encontró porque `tests/` estaba fuera del target. Un test que pasa por la razón equivocada es peor que un test que falla: parece cobertura y no lo es.

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
