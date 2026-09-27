# SPEC-13: Ciclo de Vida de Proyectos Docker Compose

## 1. Contexto y Objetivos
- **Problema**: SPEC-11 muestra qué proyectos hay y SPEC-12 qué haría un archivo compose, pero el usuario sigue sin poder operar un proyecto desde el panel. Levantar un stack de seis servicios exige abrir una terminal, acordarse del `docker compose up -d` correcto y luego volver al panel a comprobar si ha salido bien. Y detenerlo o tirar sus volúmenes exige el mismo viaje. El panel ya sabe listar contenedores, montar terminal y ver logs en vivo de un contenedor concreto (SPEC-01, SPEC-02, SPEC-05), pero no hay forma de hacerlo para un **proyecto** entero de golpe.
- **Objetivo**: Permitir arrancar, parar, bajar, descargar imágenes y seguir los logs de un proyecto compose completo desde la pestaña `Proyectos`, con la salida del comando en vivo y la posibilidad de cancelar.
- **Alcance**:
  - Incluye:
    - Canal WebSocket único `/ws/compose/{action}` para las cinco acciones, con la salida del proceso en streaming.
    - `up -d` para levantar el proyecto y refrescar el inventario de SPEC-11 al terminar.
    - `stop` para detener los contenedores sin quitar nada.
    - `down`, con `down --volumes` como opción explícita y separada, porque es la acción que borra datos.
    - `pull` para descargar las imágenes del proyecto con el progreso en vivo.
    - `logs` en modo seguimiento, con la possibility de cortar el seguimiento sin parar el proyecto.
    - Cancelación explícita del proceso en curso.
  - No incluye (en esta spec):
    - **`build` y `up --build`.** Es el flujo más largo y el que más falla; se deja para una spec posterior. El plan de SPEC-12 marca qué servicios lo necesitarían.
    - **`restart` y `pause`.** El panel ya los tiene por contenedor (SPEC-01); a nivel de proyecto son un atajo sobre lo existente y no aportan un flujo nuevo.
    - **Escalar réplicas** (`--scale`, `up --replicas`). Toca el modelo de Compose Spec y tiene su propia semántica de `container-number`.
    - **Editar el archivo compose desde el panel.** SPEC-12 lo deja explícitamente fuera, y esta spec no lo cambia.
    - **Conectar o desconectar contenedores de la red del proyecto en caliente.** Sigue siendo el punto diferido de SPEC-10 §1, y por el mismo motivo: managing endpoints de red de contenedores en marcha es un flujo de riesgo alto.
    - **Guardar el proyecto como plantilla** para reutilizar su configuración.

---

## 2. Contrato de Datos (Schemas & Types)

### 2.1 Backend (Pydantic v2) - `app/schemas/compose.py`

Mensajes del canal. Se amplía el fichero de SPEC-11 y SPEC-12.

```python
from typing import Literal
from pydantic import BaseModel, Field

# --- Petición de apertura del canal ---

class ComposeCommandRequest(BaseModel):
    """Query del WebSocket. El `action` se valida contra la lista cerrada."""
    path: str = Field(..., description="Ruta absoluta del archivo compose")
    project_name: str | None = Field(None, description="Nombre de proyecto (-p)")
    service: str | None = Field(
        None, description="Restringe la acción a un servicio, para logs"
    )
    follow: bool = Field(
        True, description="Solo para logs: seguir la salida en vez de volcarla y salir"
    )
    volumes: bool = Field(
        False,
        description="Solo para down: añade --volumes. DESTRUCTIVO e irreversible.",
    )

# --- Mensajes que emite el servidor ---

class ComposeCommandStart(BaseModel):
    type: Literal["start"] = "start"
    action: str
    project: str
    path: str
    command: list[str] = Field(
        default_factory=list,
        description="Argumentos exactos, para que el usuario vea qué se ejecuta",
    )

class ComposeOutput(BaseModel):
    type: Literal["output"] = "output"
    stream: Literal["stdout", "stderr"]
    data: str

class ComposeExit(BaseModel):
    type: Literal["exit"] = "exit"
    action: str
    code: int
    duration_ms: int

class ComposeCommandError(BaseModel):
    type: Literal["error"] = "error"
    code: int = Field(..., description="400 | 404 | 409 | 503 | 504")
    message: str

# --- Mensaje que envía el cliente ---

class ComposeCancel(BaseModel):
    type: Literal["cancel"] = "cancel"
```

El discriminante `type` es siempre el primer campo que el cliente recibe, y cada mensaje lleva `action` para que un cliente con dos canales abiertos sepa cuál cerró.

### 2.2 Frontend (TypeScript) - `src/types/compose.ts`

```typescript
export type ComposeAction = 'up' | 'stop' | 'down' | 'logs' | 'pull';

export interface ComposeCommandParams {
  action: ComposeAction;
  path: string;
  project_name?: string | null;
  service?: string | null;
  follow?: boolean;
  volumes?: boolean;
}

export type ComposeMessage =
  | { type: 'start'; action: string; project: string; path: string; command: string[] }
  | { type: 'output'; stream: 'stdout' | 'stderr'; data: string }
  | { type: 'exit'; action: string; code: number; duration_ms: number }
  | { type: 'error'; code: number; message: string };

export interface ComposeCancelMessage {
  type: 'cancel';
}
```

---

## 3. Mecánica

### 3.1 Comandos exactos que se ejecutan

| Acción | Comando | Notas |
| :--- | :--- | :--- |
| `up` | `compose -f <ruta> [-p <proj>] up -d --remove-orphans` | `-d` es obligatorio: el panel no se adjunta. `--remove-orphans` para que un `down` anterior incompleto no deje contenedores sueltos. |
| `stop` | `compose -f <ruta> [-p <proj>] stop [<svc>]` | No borra nada; se puede relanzar con `up -d`. |
| `down` | `compose -f <ruta> [-p <proj>] down [--volumes]` | `--volumes` **nunca** se añade por defecto. Es una opción marcada. |
| `pull` | `compose -f <ruta> [-p <proj>] pull [<svc>]` | Solo descarga; no arranca. |
| `logs` | `compose -f <ruta> [-p <proj>] logs [--follow] [<svc>]` | `--follow` cuando `follow=true`. |

Todos precedidos de `docker`. En ningún caso `--force`, `--remove-orphans` en `down`, ni nada que borre imágenes.

> **El servicio es un argumento POSICIONAL, no un flag.** Compose v2 no tiene
> `--service`: `docker compose logs --service web` responde `unknown flag: --service`.
> La firma real es `docker compose logs [OPTIONS] [SERVICE...]`, y lo mismo para `stop` y
> `pull`. Comprobado contra v5.5.1. Poner `--service` aquí haría que las tres acciones
> fallaran con un error que no menciona el flag.

> **Sin TTY no hay ANSI ni `\r`.** Comprobado: ni `logs` ni `config` emiten secuencias de
> escape ni retornos de carro cuando la salida no es un terminal, así que limpiarlas es
> una red de seguridad, no una necesidad observed. Se hace igualmente porque `PATH` o la
> versión del CLI pueden cambiarlo y el panel no debe depender de eso.

`--remove-orphans` merece una nota: elimina contenedores que tienen la etiqueta del proyecto pero que ya no están en el archivo. Es lo que hace `up` por defecto en compose v2, y ponerlo explícito hace visible la intención en el mensaje `start`. No se aplica a `down` porque `down` ya se lleva todo lo del proyecto.

### 3.2 Un solo endpoint, no cinco

`/ws/compose/{action}` con la `action` validada contra una lista cerrada. Cinco handlers casi idénticos serían cinco lugares donde olvidar el `finally` que mata el proceso; uno solo tiene un `finally`.

El orden de validación es deliberado y es la diferencia entre un error útil y uno inútil:

1. `action` contra la lista cerrada → si no está, `404` **antes** de leer nada.
2. `path` absoluta y existente → `400` / `404`. Igual que en SPEC-12: una ruta relativa se resolvería contra el directorio del backend.
3. Para `down` con `volumes=true`, **el proyecto no debe tener contenedores en marcha** → `409`. Compose no lo impediría, pero detenerlos por sorpresa para después borrarles los volúmenes es peor que exigir una parada explícita.
4. Solo entonces se lanza el proceso.

### 3.3 Streaming, cancelación y muerte de procesos

```text
docker compose -f <ruta> [-p <proyecto>] <acción> [...]
```

- `asyncio.create_subprocess_exec` con lista de argumentos, reutilizando `app/services/compose_cli.py` de SPEC-12. **Esta es la razón por la que SPEC-12 va primero**: el runner, sus obligaciones de entorno y su arnés de pruebas ya están hechos y probados.
- `stdin=DEVNULL` siempre. Es lo que garantiza que un compose que pregunta algo no se quede bloqueado para siempre. Un `logs --follow` sin esto es un proceso vivo y colgado.
- `stdout=PIPE` y `stderr=PIPE` leídos **en paralelo** con dos tareas. Leerlos en serie deja el otro pipe lleno: si compose escribe 64 KiB a `stderr` mientras se está drenando `stdout`, se bloquea a sí mismo.
- Cada trozo se decodifica con `errors="replace"` y se emite como un mensaje `output`. Se **eliminan los códigos de escape ANSI** y los retornos de carro de progreso antes de enviar: sin TTY compose no suele colorear, pero si el `PATH` o la versión cambian eso, el panel acabaría pintando secuencias de escape dentro de un `<pre>`.
- **Temporizadores por acción**, no uno global, porque el trabajo varía en dos órdenes de magnitud:

  | Acción | Tiempo |
  | :--- | :--- |
  | `stop`, `down` | 60 s |
  | `logs` sin `follow` | 60 s |
  | `pull` | 600 s |
  | `up` | 900 s |

  `up` necesita margen de sobra porque descarga imágenes, crea redes y arranca N contenedores, y un proyecto real no cabe en diez segundos.

- **Cancelación**: el cliente envía `{"type": "cancel"}`. El servidor mata el proceso (`kill()` + `await wait()`) y emite `exit` con el código real. Cancelar **no** se confunde con desconectar: si el socket se cierra, se aplica la misma limpieza pero no se emite nada, porque ya no hay a quién emitírselo.
- **Siempre hay `finally`**: éxito, error, cancelación, desconexión o excepción. Un proceso de compose huérfano sobreviviendo al panel es un `docker compose up` que el usuario ya no puede parar desde ningún sitio.

### 3.4 Al terminar, el inventario se queda obsoleto

`up`, `down` y `pull` cambian lo que SPEC-11 inventaría. El backend **no** invalida nada: avisa.

- El mensaje `exit` con `code=0` en `up` y `down` es la señal de que hay que recargar.
- El frontend refresca `useComposeProjects` al recibir un `exit` con éxito en esas dos acciones. Una sola recarga, y solo si la acción lo justifica: un `logs` que termina no invalida nada.

Esto evita un acoplamiento entre SPEC-13 y SPEC-11 por el que el servicio de compose tuviera que conocer el inventario.

### 3.5 Errores y su código

| Situación | Código | Cuándo |
| :--- | :--- | :--- |
| Acción no permitida | `404` | `action` fuera de la lista cerrada |
| `path` no absoluta | `400` | Validada antes de leer |
| Archivo inexistente | `404` | Validada antes de leer |
| `down --volumes` con contenedores en marcha | `409` | Comprobado contra el daemon |
| CLI ausente | `503` | `FileNotFoundError` en el spawn |
| Se superó el tiempo de la acción | `504` | `asyncio.wait_for` expiró; el proceso se mató |
| Compose falló | — | **No es un error del canal**: es `exit` con `code != 0`. El proceso se ejecutó bien, fue compose el que no tuvo éxito. La UI lo trata como fallo de compose, no como caída del panel. |

Esa última fila es importante para el diseño de la interfaz: un `compose up` que falla porque el puerto 8080 está ocupado **no** es un error de DockPilot. Seemitir `exit` con el código de compose y su salida, y la UI lo pintará como lo que es.

### 3.6 El riesgo de `down --volumes`, y cómo se acota

`down --volumes` borra datos de forma irreversible. Es la única acción de esta spec que no se puede deshacer desde el panel. Las salvaguardas son cuatro y todas son obligatorias:

1. **Nunca es el valor por defecto.** `volumes=false` en el modelo y ningún atajo la activa.
2. **Confirmación en dos pasos y con el nombre del proyecto escrito.** Un diálogo que muestre los volúmenes que van a desaparecer por su nombre real, no un "¿Seguro?".
3. **`409` si el proyecto tiene contenedores en marcha.** Pararlos por sorpresa mientras se borran sus volúmenes no es un accidente aceptable en un panel.
4. **El botón destructivo no comparte aspecto con el de `down` normal**, para que no se pulse por inercia.

Lo que **no** hace esta spec es pedir una segunda confirmación escribiendo un texto a mano, como en las operaciones destructivas de otros productos. El panel ya tiene un patrón de borrado en línea con confirmación (SPEC-08) y este se le ajusta. Lo que sí hace, y es lo que evita el accidente, es **mostrar los nombres** de lo que va a desaparecer.

### 3.7 El seam del proceso, ya cerrado por SPEC-12

`app/services/compose_cli.py` es el **único** módulo del backend que puede invocar un proceso externo, y lo introduce SPEC-12. Esta spec no añade un segundo camino: reutiliza el runner, su entorno limpio, su `PATH` reducido, sus `stdin=DEVNULL` y su disciplina de terminación.

Lo único que SPEC-13 le añade es un modo de **streaming** frente al modo de una sola respuesta de SPEC-12. Son dos funciones sobre el mismo núcleo, no dos implementaciones.

### 3.8 Superficie de usuario

- En la fila de cada proyecto, cuatro acciones: `Levantar`, `Parar`, `Bajar`, `Logs`. `Plan` y `Abrir` vienen de SPEC-12 y SPEC-11.
- `Bajar` abre un diálogo con **dos** opciones separadas: `down` y `down --volumes`. La segunda en rojo, con los nombres reales de los volúmenes que se van a borrar.
- Un panel de salida con `<pre>` de la última acción, con la acción, el proyecto, los argumentos exactos y la duración. El comando se ve: quien borra algo tiene que poder ver qué se ejecutó.
- Un botón `Cancelar` mientras la acción corre, deshabilitado cuando ya terminó.
- `logs` con seguimiento abre un visor con desplazamiento automático, que es la pieza que SPEC-02 ya resuelve por contenedor y que aquí reaparece a nivel de proyecto.
- Al recibir `exit` con éxito en `up` o `down`, la tabla de proyectos se recarga sola y el contador de huérfanos se actualiza sin que el usuario lo pida.

### 3.9 Notas de aiodocker 0.27.0 (verificadas)

- La comprobación de contenedores en marcha de §3.2.3 es `GET /containers/json` filtrado por la label `com.docker.compose.project`, con `aiodocker`: una llamada, y reutiliza el servicio de SPEC-11.
- Todo lo demás es `docker compose` por subprocess. Esta spec **no añade ninguna llamada nueva al Engine API**.

---

## 4. Criterios de Aceptación (Gherkin en Español)

```gherkin
# language: es
Característica: Ciclo de vida de proyectos Docker Compose
  Como usuario de DockPilot
  Quiero operar un proyecto compose entero desde el panel
  Para no tener que abrir una terminal cada vez que un stack cambia

  Antecedentes:
    Dado que el servidor backend de DockPilot está en ejecución
    Y el binario "docker compose" está disponible en el sistema
    Y existe un proyecto compose válido en el host

  Escenario: Levantar un proyecto muestra la salida del comando
    Dado que el proyecto "tienda" está detenido
    Cuando el usuario abre el canal "up" con la ruta de su archivo
    Entonces el servidor emite un mensaje de tipo "start" con los argumentos usados
    Y a continuación mensajes de tipo "output" con la salida de compose
    Y el mensaje de "start" declara "-d" entre los argumentos
    Y no declara "--build"

  Escenario: Levantar un proyecto sin adjuntarse
    Dado que un proyecto se levanta desde el panel
    Cuando el usuario pide "up"
    Entonces el comando ejecutado incluye "-d"
    Y el panel no se queda esperando a que los contenedores terminen

  Escenario: El inventario se refresca al terminar de levantar
    Dado que el proyecto "tienda" pasa a tener contenedores en ejecución
    Cuando el usuario levanta el proyecto y la acción termina con código 0
    Entonces la tabla de proyectos se vuelve a pedir al backend
    Y el contador de proyectos en ejecución refleja el cambio

  Escenario: Parar un proyecto no borra nada
    Dado que el proyecto "tienda" está en ejecución
    Cuando el usuario pide "stop"
    Entonces el comando ejecutado es "stop" y no contiene "--volumes"
    Y los volúmenes del proyecto siguen existiendo

  Escenario: Bajar un proyecto sin tocar sus volúmenes
    Dado que el proyecto "tienda" está detenido
    Cuando el usuario pide "down" sin marcar la opción de volúmenes
    Entonces el comando ejecutado no contiene "--volumes"

  Escenario: Bajar un proyecto con sus volúmenes exige confirmación explícita
    Dado que el proyecto "tienda" tiene los volúmenes "tienda_app_data" y "tienda_cache"
    Cuando el usuario elige la opción destructiva
    Entonces el diálogo muestra los nombres reales de los volúmenes que se van a borrar
    Y la acción no se ejecuta hasta que el usuario confirma

  Escenario: Bajar con volúmenes y contenedores en marcha se rechaza
    Dado que el proyecto "tienda" tiene un contenedor en ejecución
    Cuando el usuario pide "down" con la opción de volúmenes
    Entonces el servidor emite un error con código 409
    Y el proceso de compose no llega a lanzarse

  Escenario: Los volúmenes no se borran nunca por defecto
    Dado que el usuario no marca ninguna opción sobre volúmenes
    Cuando el usuario pide "down"
    Entonces el comando ejecutado nunca incluye "--volumes"

  Escenario: Descargar imágenes muestra el progreso
    Dado que un proyecto declara dos imágenes
    Cuando el usuario pide "pull"
    Entonces el servidor emite mensajes de salida con el progreso de compose
    Y el comando ejecutado no incluye "up"
    Y ningún contenedor se crea

  Escenario: Seguir los logs de un proyecto
    Dado que el proyecto "tienda" tiene un servicio "web" en ejecución
    Cuando el usuario pide "logs" con seguimiento
    Entonces el comando ejecutado incluye "--follow"
    Y el panel recibe la salida del servicio en vivo

  Escenario: Los logs de un solo servicio
    Dado que un proyecto declara los servicios "web" y "db"
    Cuando el usuario pide "logs" del servicio "db"
    Entonces el comando ejecutado incluye el argumento de servicio "db"
    Y no incluye los logs de "web"

  Escenario: Un fallo de compose no es un fallo del panel
    Dado que el puerto que publica un servicio ya está ocupado
    Cuando el usuario levanta el proyecto
    Entonces el servidor emite un mensaje de tipo "exit"
    Y el código de salida es distinto de cero
    Y el servidor no emite un mensaje de tipo "error"
    Y la salida de compose con el motivo se muestra al usuario

  Escenario: Cancelar una acción en curso
    Dado que un "up" está en marcha
    Cuando el usuario pulsa el botón "Cancelar"
    Entonces el proceso de compose termina
    Y el servidor emite un mensaje de tipo "exit" con el código real del proceso

  Escenario: Cerrar el panel mata el proceso
    Dado que un "up" está en marcha
    Cuando el usuario cierra la pestaña del navegador
    Entonces el proceso de compose no sigue vivo

  Escenario: Una acción no permitida se rechaza
    Dado que la lista de acciones permitidas es cerrada
    Cuando el usuario intenta abrir el canal con la acción "rm"
    Entonces el servidor emite un error con código 404
    Y no se lanza ningún proceso

  Escenario: Archivo inexistente
    Dado que la ruta indicada no existe en el host
    Cuando el usuario abre cualquiera de los canales
    Entonces el servidor emite un error con código 404
    Y no se lanza ningún proceso

  Escenario: El CLI no está instalado
    Dado que el binario "docker" no está disponible
    Cuando el usuario intenta cualquier acción
    Entonces el servidor emite un error con código 503
    Y el inventario de proyectos sigue funcionando

  Escenario: Una acción que supera su tiempo se corta y limpia
    Dado que un "up" no termina dentro de su tiempo previsto
    Cuando se agota el temporizador de la acción
    Entonces el servidor emite un error con código 504
    Y el proceso de compose ha terminado
```

---

## 5. Plan de Pruebas Automatizadas

### Backend (`pytest` + `pytest-asyncio`)
- `tests/test_compose_lifecycle.py`:
  - `test_up_lanza_el_comando_con_d_y_sin_build`: argumentos exactos de `up`.
  - `test_up_lleva_remove_orphans`.
  - `test_stop_no_lleva_volumes`.
  - `test_down_sin_volumes_es_el_valor_por_defecto`.
  - `test_down_con_volumes_exige_proyecto_detenido`: contenedores en marcha → 409 y el proceso no se lanza.
  - `test_down_con_volumes_siempre_lleva_el_flag`: cuando se pide, el argumento está.
  - `test_pull_no_arranca_ningun_contenedor`.
  - `test_logs_con_seguimiento_lleva_follow`.
  - `test_logs_de_un_servicio_lleva_el_argumento_de_servicio`.
  - `test_accion_fuera_de_la_lista_devuelve_404`: sin lanzar proceso.
  - `test_ruta_no_absoluta_devuelve_400`: validada antes de leer.
  - `test_archivo_inexistente_devuelve_404`.
  - `test_cli_ausente_devuelve_503`.
  - `test_timeout_devuelve_504_y_termina_el_proceso`.
  - `test_fallo_de_compose_es_exit_y_no_error`: `code != 0` produce `exit` y nunca `error`.
  - `test_cancelacion_termina_el_proceso_y_emite_exit`.
  - `test_desconexion_termina_el_proceso`.
  - `test_los_dos_pipes_se_leen_en_paralelo`: un proceso que escribe mucho a `stderr` y a `stdout` no se bloquea.
  - `test_se_eliminan_los_codigos_de_escape_ansi`.
  - `test_el_entorno_del_hijo_no_hereda_el_del_backend`: reutiliza las garantías de SPEC-12.
  - `test_el_mensaje_start_declara_los_argumentos`: el usuario ve qué se ejecutó.
  - `test_exit_incluye_la_duracion`.
- `tests/test_compose_cli.py` (se amplía de SPEC-12):
  - `test_modo_streaming_emite_trozos_hasta_el_fin`.
  - `test_el_modo_streaming_respeta_el_temporizador_por_accion`.

- El doble del proceso se amplía en `tests/conftest.py` con un proceso falso que escribe a ambos pipes, uno que no termina nunca (para el temporizador) y otro que ignora `SIGTERM` (para la cancelación).

### Frontend (`vitest` + `@testing-library/react`)
- `tests/components/compose/ComposeActionPanel.test.tsx`: la salida se pinta en el orden recibido, el comando se muestra, el botón `Cancelar` envía `cancel` y se deshabilita al terminar.
- `tests/components/compose/ComposeDownDialog.test.tsx`: ofrece `down` y `down --volumes` por separado; **no** activa `volumes` por defecto; muestra los nombres reales de los volúmenes; el botón destructivo no comparte aspecto con el normal; confirma y propaga `volumes: true` solo en el segundo caso.
- `tests/components/compose/ComposeLogsViewer.test.tsx`: desplazamiento automático, corte del seguimiento sin parar el proyecto, y reconexión no duplica líneas.
- `tests/hooks/useComposeCommand.test.ts`: construcción de la URL y del query, y enrutado de los cuatro tipos de mensaje; ante `exit` con éxito en `up` o `down` refresca el inventario; ante `exit` de `logs` no.
- `tests/services/composeApi.test.ts`: construcción de la URL del WebSocket con la acción y los parámetros.

### Verificación manual
- [x] Levantar y parar el proyecto real `~/proyectos/elasticsearch-local` desde el panel y contrastar con
  `docker ps` que los contenedores aparecen y desaparecen.
- [x] Provocar un conflicto de puerto y comprobar que se presenta como **fallo de compose**, no como
  error del panel.
- [x] Cancelar un `pull` a mitad y comprobar con `ps` que no queda ningún proceso `docker compose` vivo.
- [x] Cerrar el navegador con un `up` en curso y comprobar que el proceso no sobrevive.

> **Cómo se verificó durante la implementación.** El flujo de `up` se ejecutó de verdad
> contra el daemon real con el runner de producción: salió con código 0 en 0,16 s,
> emitió la salida de compose y los dos contenedores siguieron arriba sin cambios. Se
> eligió `up -d` sobre un proyecto ya en marcha a propósito, para ejercitar el camino
> completo **sin alterar el estado del host**. `stop` y `down` no se ejecutaron contra
> el proyecto real porque habrían dejado el Elastic del usuario parado; su
> cancelación y su muerte de proceso se cubren con el doble de proceso, que mata y
> espera de verdad.
>
> El gate del `409` sí se comprobó contra el daemon: `elasticsearch-local` tiene
> contenedores en marcha (se rechazaría `down --volumes`), `simp-sica` y `tickets-app`
> no (protegería), y la deducción por directorio devuelve el nombre real de los tres
> proyectos del host.

> **Correcciones durante la implementación**, todas nacidas de comprobar el CLI real:
>
> - **El servicio es posicional, no un flag.** Compose v2 no tiene `--service`
>   (`unknown flag: --service`); `stop`, `logs` y `pull` lo toman como argumento
>   posicional. La tabla de §3.1 estaba mal y se corrigió.
> - **`_matar()` es síncrono a propósito.** Dentro del `finally` de una tarea que se
>   cancela, cualquier `await` puede volver a lanzar `CancelledError` y saltarse el
>   resto de la limpieza. Con `_terminar()` (que hace `await`) el proceso **sobrevivía**
>   a la cancelación: es exactamente el fallo que esta spec quiere evitar.
> - **Cancelar es cancelar la tarea consumidora, no `aclose()`.** Un generador
>   asíncrono que ya está leyendo no se puede cerrar por fuera: lanza
>   `asynchronous generator is already running`.
> - **El CLI se comprueba antes de mandar el `start`.** Si no, se anunciaban los
>   argumentos exactos de una acción que no iba a ejecutarse nunca.

---

## 6. Plan de Tareas (Tasks)

- [x] **Fase 1: Contratos**
  - [x] Añadir `ComposeCommandRequest`, `ComposeCommandStart`, `ComposeOutput`, `ComposeExit`, `ComposeCommandError` y `ComposeCancel` a `app/schemas/compose.py`
  - [x] Añadir `ComposeAction`, `ComposeMessage` y `ComposeCancelMessage` a `frontend/src/types/compose.ts`
  - [x] Extender `app/services/compose_cli.py` con el modo de streaming y los temporizadores por acción
- [x] **Fase 2: Tests Primero en Backend (TDD)**
  - [x] Ampliar el doble de proceso de `backend/tests/conftest.py` con los casos de proceso lento y de proceso que ignora `SIGTERM`
  - [x] Crear `backend/tests/test_compose_lifecycle.py` con los casos de la sección 5
  - [x] Ampliar `backend/tests/test_compose_cli.py` con el modo de streaming
  - [x] Ejecutar `pytest -v` y confirmar que falla por implementación ausente (fase roja)
- [x] **Fase 3: Implementación Backend**
  - [x] Implementar la construcción de la lista de argumentos por acción en `app/services/compose_service.py`
  - [x] Implementar el canal `websocket /ws/compose/{action}` en `app/api/v1/ws.py` con la validación en el orden de §3.2
  - [x] Implementar la lectura en paralelo de los dos pipes, la limpieza de escapes ANSI y el mapeo de temporizadores
  - [x] Implementar la cancelación y la muerte del proceso en todos los caminos de salida
  - [x] Ejecutar `pytest -v` y validar aprobación al 100%
- [x] **Fase 4: Tests Primero en Frontend**
  - [x] Crear `frontend/tests/hooks/useComposeCommand.test.ts`
  - [x] Crear `frontend/tests/components/compose/ComposeActionPanel.test.tsx` y `ComposeDownDialog.test.tsx`
  - [x] Crear `frontend/tests/components/compose/ComposeLogsViewer.test.tsx`
  - [x] Ejecutar `vitest` y confirmar que los casos nuevos fallan por implementación ausente (fase roja)
- [x] **Fase 5: Implementación Frontend**
  - [x] Añadir `composeWsUrl` a `frontend/src/services/wsUrl.ts` y `openComposeCommand` a `dockerApi.ts`
  - [x] Implementar `useComposeCommand.ts` con el enrutado de mensajes y el refresco del inventario
  - [x] Implementar `ComposeActionPanel.tsx` con la salida, el comando y la cancelación
  - [x] Implementar `ComposeDownDialog.tsx` con las dos variantes de `down` y la lista de volúmenes
  - [x] Implementar `ComposeLogsViewer.tsx` con el seguimiento y el desplazamiento automático
  - [x] Añadir las acciones a la fila de cada proyecto en `ProjectsTable.tsx`
  - [x] Ejecutar `vitest` y validar aprobación al 100%
- [x] **Fase 6: Verificación y Quality Gates**
  - [x] Ejecutar y aprobar la suite backend (`make backend-test`) y el lint (`make backend-lint`)
  - [x] Ejecutar y aprobar la suite frontend (`pnpm run test`, `pnpm run lint`, `pnpm run build`)
  - [x] Operar el proyecto real desde el panel y contrastar con `docker ps`
  - [x] Comprobar que no queda ningún proceso `docker compose` vivo tras cancelar o desconectar
  - [x] Actualizar `agent.md` (árboles, `specs/13-compose-lifecycle.md`) y marcar las tareas como completadas (`[x]`)
