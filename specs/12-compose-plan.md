# SPEC-12: Lectura y Previsualización de Archivos Compose

## 1. Contexto y Objetivos
- **Problema**: SPEC-11 inventaría los proyectos compose que ya están en marcha, pero no dice qué hay dentro de un proyecto ni qué pasaría si se arrancara. El usuario tiene el archivo en su máquina y el panel no lo lee. Peor: hoy la única forma de saber qué va a crear un compose file es ejecutar `docker compose up` a ciegas, y `up` crea contenedores, descarga imágenes y reserva puertos. No hay forma de inspeccionar el archivo antes de comprometerse. En el host de referencia hay 4 archivos compose en `~/proyectos` y ninguno es visible desde el panel.
- **Objetivo**: Permitir elegir un archivo compose del host, ver su contenido, validarlo y recibir el plan **resuelto** de lo que crearía —servicios, puertos, montajes, redes y volúmenes— sin ejecutar nada contra el daemon.
- **Alcance**:
  - Incluye:
    - Endpoint REST `POST /api/v1/compose/plan` que recibe una ruta absoluta (y opcionalmente un contenido editado) y devuelve el plan resuelto.
    - Lectura del archivo desde el host, con límites de tamaño y validación de que sea un archivo legible.
    - Resolución con `docker compose config --format json`, que es el único modo de que el plan coincida con lo que hará `up`.
    - Superficie de usuario con selector de ruta, editor de texto y una vista de plan que separa lo que ya existe de lo que se crearía.
    - Los avisos del propio compose (`stderr` con código de salida `0`) mostrados como advertencias, no como errores.
  - No incluye (en esta spec):
    - **Ejecutar cualquier acción.** Ni `up`, ni `down`, ni `pull`. Esta spec no muta el host en ningún caso: es la última antes de que SPEC-13 introduzca la escritura.
    - **Construir imágenes.** `build` se reconoce para marcar el servicio, pero no se ejecuta.
    - **Editar y guardar el archivo en disco.** El editor sirve para probar un cambio y ver el plan que produce; guardar es del usuario en su terminal. Un panel que reescribe un archivo compose del host es un riesgo que no compra nada aquí.
    - **Gestionar varios archivos con `-f` a la vez.** Se acepta un archivo. Combinar overlays es un caso mayor.
    - **Descubrir archivos compose en el disco.** No se lista el sistema de archivos. SPEC-11 lo deja explícitamente fuera y el usuario conoce su propia ruta.
    - Secretos: los valores de `environment` se **cuentan**, no se devuelven.

---

## 2. Contrato de Datos (Schemas & Types)

### 2.1 Backend (Pydantic v2) - `app/schemas/compose.py`

Se amplía el fichero de SPEC-11. Estas clases son nuevas y no tocan las de aquella.

```python
from typing import Literal, Optional
from pydantic import BaseModel, Field

# --- Petición ---

class ComposePlanRequest(BaseModel):
    path: str = Field(
        ...,
        description="Ruta absoluta de un archivo compose. Debe existir y ser legible.",
    )
    content: Optional[str] = Field(
        None,
        description="Contenido a validar en lugar del del disco. No se escribe en disco.",
    )
    project_name: Optional[str] = Field(
        None,
        description="Nombre de proyecto (-p). Si se omite, compose lo deduce del directorio.",
    )

# --- Plan ---

class PlannedPort(BaseModel):
    """Puerto publicado por un servicio.

    `published` es una CADENA en la salida de compose, no un entero: un rango
    como "8000-8010:8000" llega como texto y no como número.
    """
    target: int = 0
    published: Optional[str] = None
    protocol: str = "tcp"
    mode: str = "ingress"

class PlannedMount(BaseModel):
    """Montaje en forma larga, que es como compose los normaliza."""
    type: str = Field("volume", description="'volume' | 'bind' | 'tmpfs' | 'npipe'")
    source: str = Field("", description="Nombre lógico del volumen o ruta del bind")
    target: str = ""
    read_only: bool = False

class PlannedService(BaseModel):
    """Un servicio del plan.

    Todos los campos derivados de secciones opcionales son opcionales: la
    salida de `config` omite por completo `build`, `depends_on` y `profiles`
    cuando el servicio no las declara.
    """
    name: str
    image: Optional[str] = None
    build: bool = Field(False, description="El servicio declara una sección build")
    container_name: Optional[str] = None
    command: Optional[str] = None
    entrypoint: Optional[str] = None
    restart: Optional[str] = None
    ports: list[PlannedPort] = Field(default_factory=list)
    mounts: list[PlannedMount] = Field(default_factory=list)
    networks: list[str] = Field(
        default_factory=list, description="Claves lógicas; compose las devuelve como mapa"
    )
    depends_on: list[str] = Field(default_factory=list)
    profiles: list[str] = Field(default_factory=list)
    environment_count: int = Field(
        0, description="Cuántas variables declara. Los valores no se devuelven."
    )

class PlannedNetwork(BaseModel):
    """Red del plan. `external=True` significa que compose no la va a crear."""
    logical_name: str
    name: str = Field(..., description="Nombre real, ya prefijado con el proyecto")
    driver: str = "bridge"
    external: bool = False

class PlannedVolume(BaseModel):
    logical_name: str
    name: str = Field(..., description="Nombre real, ya prefijado con el proyecto")
    driver: str = "local"
    external: bool = False

class ComposePlan(BaseModel):
    """Configuración resuelta: lo que compose haría, sin haberlo hecho."""
    project_name: str
    source_path: str
    services: list[PlannedService] = Field(default_factory=list)
    networks: list[PlannedNetwork] = Field(default_factory=list)
    volumes: list[PlannedVolume] = Field(default_factory=list)
    warnings: list[str] = Field(
        default_factory=list,
        description="stderr de compose con código 0: validado pero con avisos",
    )
    resolved_by: Literal["docker-compose-cli"] = "docker-compose-cli"
```

### 2.2 Errores

`POST /api/v1/compose/plan` responde con `422` y el detalle de FastAPI para cuerpo inválido. El resto de errores llevan un `detail` legible en español, con el código de la tabla de §3.5.

### 2.3 Frontend (TypeScript) - `src/types/compose.ts`

```typescript
export interface ComposePlanRequest {
  path: string;
  content?: string | null;
  project_name?: string | null;
}

export interface PlannedPort {
  target: number;
  published: string | null;
  protocol: string;
  mode: string;
}

export interface PlannedMount {
  type: string;
  source: string;
  target: string;
  read_only: boolean;
}

export interface PlannedService {
  name: string;
  image: string | null;
  build: boolean;
  container_name: string | null;
  command: string | null;
  entrypoint: string | null;
  restart: string | null;
  ports: PlannedPort[];
  mounts: PlannedMount[];
  networks: string[];
  depends_on: string[];
  profiles: string[];
  environment_count: number;
}

export interface PlannedNetwork {
  logical_name: string;
  name: string;
  driver: string;
  external: boolean;
}

export interface PlannedVolume {
  logical_name: string;
  name: string;
  driver: string;
  external: boolean;
}

export interface ComposePlan {
  project_name: string;
  source_path: string;
  services: PlannedService[];
  networks: PlannedNetwork[];
  volumes: PlannedVolume[];
  warnings: string[];
  resolved_by: 'docker-compose-cli';
}
```

---

## 3. Mecánica

### 3.1 Por qué el preview llama al CLI y no parsea el YAML

Esta es la decisión que sostiene la spec, así que conviene dejarla escrita con su motivo.

La alternativa era leer el YAML con PyYAML y resolverlo en Python. Se descartó por un motivo concreto: **la utilidad de un preview es ser fiel.** Si el preview lo produce un parser propio y ese parser no replica la interpolación de variables, la fusión de `extends`, los `profiles`, los `include`, el `env_file` con su precedencia, los `!reset`/`!override` o cualquier detalle del Compose Spec, entonces el preview miente con toda la autoridad de la interfaz. El usuario ve un plan, lo aprueba, y compose hace otra cosa. Eso es peor que no tener preview: un preview que no se puede confiar enseña a dejar de mirar.

`docker compose config --format json` es el propio compose diciendo "esto es lo que interpreté". Si el preview y el `up` de SPEC-13 salen del mismo binario con el mismo archivo, no pueden discrepar.

El coste es real y hay que aceptarlo: **esta spec introduce el primer `subprocess` del backend.** Hoy `backend/app/` no invoca ningún proceso externo; todo pasa por `aiodocker` contra el socket. A partir de aquí el backend tiene una segunda vía de entrada al sistema, y con ella obligaciones que en §3.6 se detallan.

### 3.2 Forma exacta de la salida de `config`

Verificada contra `docker compose` v5.5.1. La raíz tiene **exactamente cuatro** claves:

```text
{ "name": ..., "networks": {...}, "services": {...}, "volumes": {...} }
```

Y hay cuatro cosas que se leen mal si se toma el JSON tal cual:

1. **`networks` y `volumes` de la raíz son MAPAS, no listas.** La clave es el nombre lógico tal como aparece en el archivo; el valor es el objeto con el nombre **real**:

   ```json
   "networks": { "elastic": { "name": "elasticsearch-local_elastic", "driver": "bridge", "ipam": {} } },
   "volumes":  { "elasticsearch_data": { "name": "elasticsearch-local_elasticsearch_data" } }
   ```

   Por eso `PlannedNetwork` y `PlannedVolume` llevan los dos nombres. Iterarlos como lista da `TypeError`; quedarse solo con la clave muestra `elastic` donde el usuario necesita `elasticsearch-local_elastic`.

2. **`networks` de un servicio también es un mapa**, con valor `null`: `"networks": { "elastic": null }`. Para el plan interesa la lista de claves.

3. **`published` de un puerto es una cadena.** `"ports": [{"mode": "ingress", "target": 9200, "published": "9200", "protocol": "tcp"}]`. Tiparlo como `int` rompe con cualquier rango de puertos, que es un caso normal.

4. **Las secciones opcionales no aparecen.** Un servicio sin `build` no trae la clave `build`; sin `depends_on`, tampoco. El modelo las declara con valor por defecto y la lectura usa `.get()`.

5. **`depends_on` es un mapa, no una lista.** V5.5.1 lo emite como `{"db": {"condition": "service_healthy", "required": true}}`. El modelo expone `depends_on: list[str]`, así que la lectura se queda con las **claves**: al usuario le importa qué servicios espera, no la condición.

6. **`build.context` viene como ruta absoluta**, ya resuelta contra el directorio del archivo. Es lo correcto y no hay que hacer nada, pero conviene saberlo antes de suponer que el context se queda como `.`.

### 3.3 Código de salida 0 no significa "sin avisos"

Comportamiento verificado:

| Situación | Código | `stderr` |
| :--- | :--- | :--- |
| Archivo válido | `0` | vacío, o líneas `level=warning` |
| Variable sin definir | `0` | `time="..." level=warning msg="The \"X\" variable is not set. Defaulting to a blank string."` |
| YAML malformado | `1` | `go-yaml load error in parser (while parsing a flow sequence) at L3.C11-L4.C1: ...` |

El caso de la variable sin definir es la trampa: **compose valida el archivo y aun así sale con `0` escribiendo un aviso en `stderr`.** Un implementation que solo mire el código de salida se come el aviso, y el usuario descubre tarde que su `${DB_PASSWORD}` se resolvió a cadena vacía. Por eso `stderr` se captura **siempre**, también en éxito, y se devuelve en `warnings`.

Los mensajes de `stderr` vienen en formato logrus con prefijo `time=... level=warning msg=...`. Se devuelven **crudos**: traducirlos o reformatearlos es un trabajo que no aporta nada, porque el usuario reconoce el texto de compose —es el mismo que ve en su terminal— y le resulta más familiar que una traducción.

### 3.4 Ejecución del proceso

```text
docker compose --profile '*' -f <ruta> [-p <proyecto>] config --format json
```

- **`--profile '*'` es obligatorio y no es opcional.** `docker compose config` **excluye los servicios que declaran `profiles`** salvo que se activen. Sin el asterisco, un proyecto con un servicio `profiles: [dev]` devuelve un plan con **un servicio menos, sin avisar**, y el usuario cree que el plan es completo cuando le falta la mitad. Es la misma clase de fallo que un preview incompleto en silencio, y por eso el asterisco va siempre, incluso en archivos sin perfiles, donde es inocuo. Verificado contra v5.5.1.
- `asyncio.create_subprocess_exec` con **lista de argumentos**, nunca `shell=True` y nunca con la ruta interpolada en una cadena. Es la diferencia entre pasar un argumento y ejecutar una línea de shell.
- `cwd` = el directorio que contiene el archivo. Es obligatorio: compose resuelve ahí los `env_file` y los `build.context` relativos, y sin `cwd` el resultado depende del directorio desde el que arrancó el servicio.
- `stdin=DEVNULL`. Sin esto, un compose que pregunte algo se queda bloqueado leyendo de la entrada estándar y el preview no termina nunca.
- `stdout=PIPE`, `stderr=PIPE`. No hay un tope de tamaño artificial: `docker compose config` solo resuelve texto, y el `asyncio.wait_for` de §3.5 corta en cualquier caso.
- Se decodifica con `errors="replace"`: un byte inválido en la salida no debe tumbar la respuesta.
- Si viene `content` en la petición, se escribe en un directorio temporal junto al archivo original —para que las rutas relativas del `env_file` sigan resolviendo— y se le pasa con `-f`. El temporal se borra en un `finally`, también si compose falla.

### 3.5 Endpoints REST

| Método | Endpoint | Cuerpo | Respuesta | Errores |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/api/v1/compose/plan` | `ComposePlanRequest` | `200 OK` (`ComposePlan`) | `400` ruta no absoluta o inválida, `403` ruta fuera de la raíz del explorador, `404` archivo inexistente, `413` demasiado grande, `422` compose no pudo validar el archivo, `503` CLI ausente, `504` compose no terminó a tiempo |

Es `POST` y no `GET` por dos razones: lleva un cuerpo, y la ruta es un parámetro de entrada que no pertenece en una query ni en un log de acceso.

- **Timeout de 10 segundos.** `config` es una operación local de resolución de texto; si tarda más, algo está mal (un `include:` remoto, un contexto colgado) y cortar es mejor que esperar. `asyncio.wait_for` y, al expirar, `proc.kill()` seguido de `await proc.wait()` para no dejar el proceso colgado.
- **`503` si el CLI no está.** `FileNotFoundError` al spawn significa que no hay `docker` en el `PATH` o no hay plugin compose. El mensaje lo dice explícitamente en vez de fingir que el archivo está mal.
- **`400` si la ruta no es absoluta.** Se rechaza antes de tocar el sistema de archivos: una ruta relativa se resolvería contra el directorio de trabajo del backend, que no es el del usuario, y el error aparecería más tarde y más confuso.
- **`403` si la ruta sale de la raíz del explorador**, y se comprueba **antes** que exista. El criterio es el de SPEC-14 §3.2 —`resolve()` y `parents`, no `startswith`— y se comparte con el explorador y con el canal de ciclo de vida: los tres endpoints que aceptan una ruta del cliente aplican la misma regla.

  Este `403` no es decorativo para este endpoint en concreto, y la razón es que **el plan escribe**. Con `content`, §3.4 vuelca lo que mandó el cliente en un temporal junto al archivo original; sin confinamiento, un `path=/etc/docker-compose.yml` con contenido，escribía en `/etc`. Por eso la comprobación va antes de `exists()`, `is_file()` y `stat()`: ni un solo `stat` fuera de la raíz.
- **`413` a partir de 1 MiB** de archivo, o del `content` enviado.

### 3.6 Obligaciones que introduce ejecutar un proceso

No es un detalle de implementación: es el precio de la decisión de §3.1 y por eso queda escrito en la spec.

- **Nunca `shell=True`.** Lista de argumentos, siempre.
- **El `PATH` se reduce explícitamente** a una lista conocida en lugar de heredar el del proceso del backend, para que un `PATH` alterado no convierta un nombre de binario en otra cosa. `docker compose` no necesita nada del entorno del usuario.
- **`COMPOSE_PROJECT_NAME` y `DOCKER_HOST` no se heredan del entorno del backend.** Si el backend_arrancara con alguno de esos definidos, el preview resolvería contra otro daemon o con otro nombre de proyecto del que el usuario cree. Se limpian del entorno que se le pasa al hijo.
- **Sin escritura en disco fuera del temporal.** El `content` editado no se guarda nunca.
- **Proceso terminado siempre.** `finally` con `kill()` + `wait()`, en éxito, en error y en cancelación.
- **La petición es autenticada por ser local.** El panel escucha en `127.0.0.1` y es de un solo operador sin autenticación (modelo de amenaza ya establecido, el mismo que permite a SPEC-03 ejecutar cualquier imagen del registro). Esta spec no amplía ese modelo: leer un archivo que el propio operador indica y mostrarlo en su propio panel.

### 3.7 Superficie de usuario

- **Botón `Plan` en la cabecera de la pestaña `Proyectos`**, que abre un modal con dos zonas: la ruta y el editor de texto a la izquierda, el plan a la derecha.
- **La ruta se escribe a mano.** No hay selector de archivos: el backend no expone el sistema de archivos y no se va a empezar ahora.
- **El editor se precarga con el contenido del archivo**, y `Validar` envía la ruta; `Validar con cambios` envía ruta **y** `content` editado, que es lo que permite probar un ajuste sin salir del panel.
- **El plan separa lo que ya existe de lo que se crearía**: cada red y cada volumen se marca `externa` cuando lo declara, y el plan indica si el nombre real ya existe en el daemon. Un servicio con puerto publicado que chocaría con uno en uso se resalta.
- **Las advertencias van en una franja ámbar encima del plan**, con el texto crudo de compose. Un error de validación va en rojo y **no** se muestra plan: no hay plan si compose no pudo resolver el archivo.
- Ningún botón de acción. Esta spec no ejecuta nada y la interfaz no debe insinuar lo contrario.

### 3.8 Notas de aiodocker 0.27.0 (verificadas)

- La comprobación de existencia de una red o volumen que chocaría en el plan sí usa el Engine API: `docker.networks.list()` y `docker.volumes.list()`. Son llamadas de lectura, sin problema.
- `docker compose` v5.5.1 está instalado en el host de referencia y su salida es la descrita en §3.2. En un host sin CLI, el inventario de SPEC-11 sigue funcionando entero: **esta spec es opcional para el panel**, y su ausencia solo quita el preview.

---

## 4. Criterios de Aceptación (Gherkin en Español)

```gherkin
# language: es
Característica: Lectura y previsualización de archivos Docker Compose
  Como usuario de DockPilot
  Quiero ver qué haría un archivo compose antes de ejecutarlo
  Para no crear contenedores, descargar imágenes ni reservar puertos a ciegas

  Antecedentes:
    Dado que el servidor backend de DockPilot está en ejecución
    Y el binario "docker compose" está disponible en el sistema

  Escenario: El plan describe los servicios del archivo
    Dado que un archivo compose declara los servicios "web" y "db"
    Cuando el usuario envía "POST /api/v1/compose/plan" con la ruta del archivo
    Entonces el sistema responde con código HTTP 200
    Y el plan incluye los dos servicios
    Y el nombre del proyecto viene resuelto por compose

  Escenario: Los puertos se leen como cadena
    Dado que un servicio publica el puerto "9200" sobre el contenedor
    Cuando el usuario pide el plan
    Entonces el plan incluye un puerto con destino 9200 y publicación "9200"
    Y el protocolo es "tcp"

  Escenario: Las redes y los volúmenes mantienen los dos nombres
    Dado que el archivo declara la red "elastic" y el volumen "app_data"
    Y el proyecto se llama "tienda"
    Cuando el usuario pide el plan
    Entonces la red aparece con nombre lógico "elastic" y nombre real "tienda_elastic"
    Y el volumen aparece con nombre lógico "app_data" y nombre real "tienda_app_data"

  Escenario: Un servicio sin secciones opcionales se resuelve igual
    Dado que un servicio no declara "build" ni "depends_on" ni "profiles"
    Cuando el usuario pide el plan
    Entonces el servicio aparece con "build" igual a false
    Y sus listas de dependencias y perfiles vienen vacías

  Escenario: El contenido editado se valida sin tocar el disco
    Dado que un archivo compose es válido
    Y el usuario envía una ruta junto con un contenido modificado
    Cuando el sistema valida el plan
    Entonces el plan refleja el contenido modificado
    Y el archivo original del disco no ha cambiado

  Escenario: Nombre de proyecto explícito
    Dado que el usuario envía un nombre de proyecto "tienda"
    Cuando el sistema valida el plan
    Entonces los nombres reales llevan el prefijo "tienda"

  Escenario: Las variables de entorno se cuentan pero no se devuelven
    Dado que un servicio declara cinco variables de entorno
    Cuando el usuario pide el plan
    Entonces el servicio informa cinco variables de entorno
    Y el plan no incluye sus valores

  Escenario: Un archivo malformado se rechaza con su mensaje
    Dado que el archivo compose no es YAML válido
    Cuando el usuario pide el plan
    Entonces el sistema responde con código 422
    Y el mensaje de error incluye lo que informó compose
    Y la respuesta no incluye ningún plan

  Escenario: Una variable sin definir es un aviso, no un error
    Dado que un archivo compose usa una variable de entorno que no está definida
    Cuando el usuario pide el plan
    Entonces el sistema responde con código HTTP 200
    Y el plan incluye un aviso que menciona la variable
    Y el plan no se considera fallido

  Escenario: Archivo inexistente
    Dado que la ruta indicada no existe en el host
    Cuando el usuario pide el plan
    Entonces el sistema responde con código 404
    Y el cuerpo de la respuesta contiene un mensaje de error descriptivo
    Y la ruta indicada estaba dentro de la raíz del explorador

  Escenario: Ruta relativa rechazada
    Dado que la ruta indicada no es absoluta
    Cuando el usuario pide el plan
    Entonces el sistema responde con código 400
    Y el sistema no ha intentado leer ningún archivo

  Escenario: Ruta fuera de la raíz del explorador
    Dado que la ruta indicada sale de la raíz del explorador
    Y que el archivo existe y es un compose válido
    Cuando el usuario pide el plan con un contenido editado
    Entonces el sistema responde con código 403
    Y el sistema no ha escrito ningún temporal junto a ese archivo
    Y el archivo original conserva su contenido

    El 403 va antes de comprobar que el archivo exista, y por eso un archivo
    inexistente fuera de la raíz también da 403 y no 404: distinguirlos serviría
    para enumerar el disco (SPEC-14 §3.2).

  Escenario: Archivo demasiado grande
    Dado que el archivo supera el tamaño máximo admitido
    Cuando el usuario pide el plan
    Entonces el sistema responde con código 413

  Escenario: El CLI de compose no está instalado
    Dado que el binario "docker" no está disponible en el sistema
    Cuando el usuario pide el plan
    Entonces el sistema responde con código 503
    Y el mensaje explica que falta el CLI de Docker Compose
    Y el inventario de proyectos sigue funcionando

  Escenario: Compose no termina a tiempo
    Dado que la resolución del archivo no termina en el tiempo previsto
    Cuando el usuario pide el plan
    Entonces el sistema responde con código 504
    Y el proceso de compose ha terminado

  Escenario: Ninguna petición modifica el estado del host
    Dado que un archivo compose válido con un servicio que expone un puerto libre
    Cuando el usuario pide el plan
    Entonces el sistema responde con código HTTP 200
    Y no se ha creado ningún contenedor, red ni volumen
    Y el puerto sigue libre
```

---

## 5. Plan de Pruebas Automatizadas

### Backend (`pytest` + `pytest-asyncio`)
- `tests/test_compose_plan.py`:
  - `test_plan_lista_servicios_resueltos`: `services` del mapa raíz se convierten en lista de `PlannedService`.
  - `test_plan_lee_published_como_cadena`: `"published": "8000-8010"` no revienta al tiparlo.
  - `test_plan_mantiene_nombre_logico_y_real_de_redes_y_volumenes`: la clave del mapa es el lógico y `name` es el real.
  - `test_plan_tolera_servicios_sin_secciones_opcionales`: ausencia de `build`, `depends_on` y `profiles`.
  - `test_plan_lee_networks_de_servicio_como_mapa`: `{"elastic": null}` produce `["elastic"]`.
  - `test_plan_cuenta_variables_sin_devolver_valores`: `environment_count` correcto y ningún valor en el payload.
  - `test_warnings_con_codigo_de_salida_cero`: `stderr` con `level=warning` y salida `0` → `warnings` poblado, código 200.
  - `test_error_de_validacion_con_codigo_distinto_de_cero`: salida `1` → 422 con el stderr de compose y sin plan.
  - `test_ruta_no_absoluta_devuelve_400`: se rechaza antes de leer el sistema de archivos.
  - `test_archivo_inexistente_devuelve_404`: con la ruta **dentro** de la raíz del explorador (`tmp_path`), porque fuera da 403 antes.
  - `test_una_ruta_fuera_de_la_raiz_da_403`: ni el CLI se lanza.
  - `test_el_contenido_editado_no_se_escribe_fuera_de_la_raiz`: con `content`, el archivo de fuera conserva su contenido y no aparece ningún temporal.
  - `test_archivo_demasiado_grande_devuelve_413`.
  - `test_cli_ausente_devuelve_503`: `FileNotFoundError` del spawn.
  - `test_timeout_devuelve_504_y_termina_el_proceso`: el proceso queda terminado, no colgado.
  - `test_contenido_editado_no_escribe_en_disco`: el archivo original conserva su contenido tras validar.
  - `test_temporal_se_borra_todavia_si_falla`.
  - `test_entorno_del_hijo_limpia_compose_project_name_y_docker_host`: el hijo no hereda esas variables.
  - `test_no_se_usa_shell_true`: el comando se invoca con lista de argumentos.

- `tests/test_compose_cli.py` (unitario del runner, sin CLI real):
  - `test_devuelve_stdout_stderr_y_codigo`.
  - `test_limita_la_lectura_por_tiempo`.
  - `test_mata_el_proceso_al_cancelar`.

- El doble de compose en `tests/conftest.py` sustituye el punto de inyección del proceso, **no** el binario: los tests no ejecutan `docker compose`. Un test de humo marcado como integración sí lo ejecuta contra el archivo real de `~/proyectos/elasticsearch-local` y se salta si el CLI no está.

### Frontend (`vitest` + `@testing-library/react`)
- `tests/components/compose/ComposePlanModal.test.tsx`: la ruta se envía en la petición; `Validar con cambios` envía también `content`; el plan se pinta con servicios, puertos, montajes, redes y volúmenes; las advertencias van en su propia franja; un 422 muestra el error y **no** muestra plan.
- `tests/components/compose/PlannedServiceCard.test.tsx`: marca los servicios con `build`, muestra los puertos con protocolo y las redes como nombres lógicos.
- `tests/components/compose/ComposeEditor.test.tsx`: precarga el contenido del archivo, refleja la edición y no la persiste.
- `tests/services/composeApi.test.ts`: `planCompose` envía el cuerpo correcto y propaga el mensaje de error.

### Verificación manual
- [x] Validar el archivo real `~/proyectos/elasticsearch-local/docker-compose.yml` y contrastar el plan
  con `docker compose -f <archivo> config --format json` en una terminal: deben coincidir servicios,
  puertos y pares nombre lógico → nombre real.
- [x] Editar el contenido para dejar una variable sin definir y comprobar que sale un aviso en ámbar y
  **no** un error.
- [x] Comprobar con `docker ps` y `docker network ls` que tras pedir el plan no ha cambiado nada.

> Ejecutado contra el daemon real durante la implementación. El plan resolvió los dos
> servicios, los puertos llegaron como cadena (`published='9200'`), `redes=['elastic']`
> salió de leer el mapa de `networks` por sus claves, y la red y el volumen reales
> salieron con `exists=True` porque en ese host ya existen. El contenido editado con una
> variable sin definir devolvió el aviso `level=warning` intacto, el `sha256` del archivo
> antes y después fue idéntico, y no quedó ningún temporal `dockpilot-compose-*`.

> **Corrección durante la implementación**: se añadió `--profile '*'` a los argumentos,
> tras comprobar contra el CLI real que `docker compose config` **excluye los servicios
> que declaran `profiles`**. Sin el asterisco, el plan perdía esos servicios en silencio,
> que es justo la traición que un preview no debe cometer. Documentado en §3.4 y en
> `agent.md`.

---

## 6. Plan de Tareas (Tasks)

- [x] **Fase 1: Contratos**
  - [x] Añadir `ComposePlanRequest`, `PlannedPort`, `PlannedMount`, `PlannedService`, `PlannedNetwork`, `PlannedVolume` y `ComposePlan` a `app/schemas/compose.py`
  - [x] Crear el runner `app/services/compose_cli.py` con el contrato de ejecutar, capturar y terminar el proceso
  - [x] Añadir las interfaces equivalentes a `frontend/src/types/compose.ts`
- [x] **Fase 2: Tests Primero en Backend (TDD)**
  - [x] Añadir a `backend/tests/conftest.py` el doble del punto de inyección del proceso
  - [x] Crear `backend/tests/test_compose_cli.py` con los casos unitarios del runner
  - [x] Crear `backend/tests/test_compose_plan.py` con los casos de la sección 5
  - [x] Ejecutar `pytest -v` y confirmar que falla por implementación ausente (fase roja)
- [x] **Fase 3: Implementación Backend**
  - [x] Implementar la validación de la ruta y los límites de tamaño antes de cualquier lectura
  - [x] Implementar `build_plan` en `app/services/compose_service.py` con la lectura de redes y volúmenes existentes para marcar choques
  - [x] Capturar `stderr` también en éxito y poblar `warnings`
  - [x] Traducir los cuatro errores de proceso a `400`, `404`, `413`, `503` y `504` con mensajes en español
  - [x] Registrar `POST /api/v1/compose/plan` en `app/api/v1/compose.py`
  - [x] Ejecutar `pytest -v` y validar aprobación al 100%
- [x] **Fase 4: Tests Primero en Frontend**
  - [x] Ampliar `frontend/tests/services/composeApi.test.ts` con `planCompose`
  - [x] Crear `frontend/tests/components/compose/ComposePlanModal.test.tsx`, `PlannedServiceCard.test.tsx` y `ComposeEditor.test.tsx`
  - [x] Ejecutar `vitest` y confirmar que los casos nuevos fallan por implementación ausente (fase roja)
- [x] **Fase 5: Implementación Frontend**
  - [x] Añadir `planCompose` a `frontend/src/services/dockerApi.ts`
  - [x] Implementar `ComposePlanModal.tsx` con la ruta, el editor y la zona de plan
  - [x] Implementar `ComposeEditor.tsx` y `PlannedServiceCard.tsx`
  - [x] Añadir el botón `Plan` en la cabecera de la pestaña `Proyectos` y el tratamiento de `503` con un aviso de que el CLI falta
  - [x] Ejecutar `vitest` y validar aprobación al 100%
- [x] **Fase 6: Documentación del nuevo seam**
  - [x] Documentar en `agent.md` que el backend deja de ser cliente puro del Engine API: `app/services/compose_cli.py` es el único módulo que invoca procesos, con su lista de obligaciones de §3.6
  - [x] Marcar en `agent.md` que SPEC-11 no depende del CLI y SPEC-12 sí
- [x] **Fase 7: Verificación y Quality Gates**
  - [x] Ejecutar y aprobar la suite backend (`make backend-test`) y el lint (`make backend-lint`)
  - [x] Ejecutar y aprobar la suite frontend (`pnpm run test`, `pnpm run lint`, `pnpm run build`)
  - [x] Contrastar el plan con `docker compose config` en una terminal
  - [x] Actualizar `agent.md` (árboles, `specs/12-compose-plan.md`) y marcar las tareas como completadas (`[x]`)
