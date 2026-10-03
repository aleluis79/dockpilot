# SPEC-17: Series temporales de métricas

## 1. Contexto y Objetivos

- **Problema**: El panel mide el instante y lo tira. `useDockerStats` acumula 20 puntos en el navegador (`maxHistory = 20`) y se pierden al cerrar el modal; SPEC-16 lo dejó escrito como la razón por la que el panel del host no tiene series, y SPEC-18 difirió a esta spec el historial de salud. El resultado es que el panel no contesta a las dos preguntas que sí tienen respuesta: *¿desde cuándo está así?* y *¿esto es normal o es de ahora?*
  Hay un segundo motivo, más técnico: `network_rx_bytes`, `network_tx_bytes`, `block_read_bytes` y `block_write_bytes` son **contadores acumulados desde el arranque**. Dibujados tal cual son una rampa monótona, y SPEC-16 §1 los dejó fuera de los gráficos por eso. Una tasa no existe hasta que hay **dos** muestras y se sabe cuánto tiempo ha pasado entre las dos: el requisito de "histórico" y el de "tasa" son el mismo trabajo.

- **Objetivo**: Un histórico real de CPU, memoria, red y disco por contenedor, con ventana de tiempo seleccionable, tasa derivada de los contadores y honestidad explícita sobre lo que el panel no sabe.

- **La decisión que esta spec cierra**: SPEC-16 §1 escribió, textualmente, que esta spec "es SPEC-17, y allí habrá que decidir si el buffer vive en el navegador o en el backend". Se decide **en el backend**, con una condición que sin ella la decisión no vale: **un anillo que solo se rellena mientras hay alguien mirando es el buffer del navegador con más pasos**. El motivo real del backend es el **"observar"**: un contenedor fijado se sigue midiendo con el modal cerrado, y su curva sigue ahí cuando se vuelve a abrir. Sin pin, esta spec no valía la pena.

- **Alcance**:
  - Incluye:
    - Anillo de muestras **en el backend**, en memoria, por contenedor, con topes y expulsión por antigüedad.
    - Un **muestreador único** que mide los contenedores observados, con reloj inyectable para los tests.
    - **Observar** (`watch`): fijar un contenedor para que se mida aunque nadie lo mire, y que su estado se vea en el listado sin una llamada por contenedor.
    - El **historial en el mismo canal WebSocket** de métricas ya existente, enviado antes de la primera muestra en vivo.
    - Tasas de red y disco derivadas de los contadores, con **detección de reinicio** para no dibujar una línea a través del salto.
    - Cuatro series en el modal de estadísticas (CPU, memoria, red, disco) con selector de ventana, en SVG y sin librería, con la paleta de `index.css`.
  - No incluye (en esta spec):
    - **Series del host.** SPEC-16 §1 ya lo resolvió y no se toca: `GET /containers/{id}/stats` es por contenedor y su `cpu_percent` va multiplicado por `online_cpus`, así que sumar contenedores y llamarlo "host" mentiría.
    - **Historial de salud** (`starting → healthy → unhealthy`). SPEC-18 lo difirió a esta spec, pero es **otra fuente de datos**: no viene de `/stats` sino de inspeccionar el healthcheck, y meterlo aquí duplica el muestreo. Se queda fuera, y el porqué en §4.10.
    - **Persistencia.** El anillo no sobrevive a reiniciar el backend. Guardarlo de verdad es una base de datos y otra spec.
    - **Comparativas** entre contenedores o entre periodos, ni zoom, ni medias móviles. Cada contenedor tiene su ventana, y sumar dos contenedores no significa nada.
    - **Métricas del host** (CPU del sistema, carga, swaps): `aiodocker.system` sólo expone `info()`.
    - **Exportar la serie** a CSV, ni captura, ni envío a ningún servicio externo.

---

## 2. Contrato de Datos (Schemas & Types)

### 2.1 Backend (Pydantic v2) — `app/schemas/metrics.py` (nuevo)

```python
class MetricSample(BaseModel):
    """Una medición: lo que dijo el daemon, sin interpretar.

    `t` es un epoch en segundos y no una cadena ISO-8601 como el `timestamp` de
    `ContainerStats`. La serie se consume por diferencias, y por diferencias de
    tiempo: un `float` evita parsear 450 cadenas en cada render y no tiene
    ambigüedad de zona horaria.
    """
    t: float
    cpu_percent: float
    memory_percent: float
    network_rx_bytes: int
    network_tx_bytes: int
    block_read_bytes: int
    block_write_bytes: int


class MetricsHistory(BaseModel):
    """La serie de un contenedor, con lo que el panel sabe y lo que no."""
    container_id: str
    container_name: str
    running: bool           # está en marcha ahora; si no, `samples` es lo último que hubo
    observed: bool          # está fijado: el muestreador lo sigue aunque nadie mire
    sampling: bool          # el muestreador lo está midiendo en este momento
    interval_s: float       # periodo con el que se pretende muestrear
    window_s: int           # ventana que abarca el anillo
    truncated: bool = False # el anillo descartó muestras por el tope
    samples: list[MetricSample]
```

`truncated` existe por el mismo motivo que `COMPOSE_BROWSE_MAX`: **un truncado que no se dice es un dato que miente**. Sin él, un anillo lleno de 450 muestras de los últimos 4 minutos parecería el histórico de 15 minutos que la ventana promete.

### 2.2 El backend pasa a tener estado (y hay que decirlo)

`MetricsHistory` es el primer dato que el backend **recuerda** entre peticiones. Eso rompe una propiedad que el proyecto repetía: SPEC-16 §1 escribía "el backend es sin estado, sin base de datos y sin buffer", y la ayuda integrada lo dice al usuario en `HelpModal.tsx` ("aquí no se hace"). Los tres sitios se corrigen en esta spec:

| Dónde | Qué dice hoy | Qué dirá |
| :--- | :--- | :--- |
| `specs/16-host-census-dashboard.md` §1 | "no hay histórico porque el backend no tiene buffer" | La exclusión de series temporales sigue valiendo **para el host**; el histórico por contenedor es SPEC-17 y vive en un anillo en memoria |
| `agent.md` §"La paleta de gráfico" | "el backend es sin estado y no tiene buffer" | Añadido: SPEC-17 introduce el primer anillo en memoria, con topes y sin persistencia |
| `frontend/src/components/help/HelpModal.tsx` | "no guarda series de CPU ni de memoria, porque eso necesita acumular muestras en el servidor y aquí no se hace" | "guarda los últimos minutos mientras observas el contenedor" |

### 2.3 Frontend (TypeScript) — `src/types/metrics.ts` (nuevo)

```typescript
export interface MetricSample {
  t: number;
  cpu_percent: number;
  memory_percent: number;
  network_rx_bytes: number;
  network_tx_bytes: number;
  block_read_bytes: number;
  block_write_bytes: number;
}

/** Una tasa derivada entre dos muestras. */
export interface RateSample {
  t: number;
  /** `null` cuando el par no es comparable: es la primera muestra, o el hueco
   *  tras un salto. Nunca 0, porque 0 es una tasa medida. */
  bytes_per_second: number | null;
  /** El salto rompe el trazo: el contador bajó y no se puede unir. */
  broken: boolean;
}

export interface MetricsHistory {
  container_id: string;
  container_name: string;
  running: boolean;
  observed: boolean;
  sampling: boolean;
  interval_s: number;
  window_s: number;
  truncated: boolean;
  samples: MetricSample[];
}

export type RangeSeconds = 60 | 300 | 900;

export type MetricKey = 'cpu_percent' | 'memory_percent' | 'network_rx' | 'network_tx' | 'block_read' | 'block_write';
```

`RateSample.broken` es el contrato del **salto**: es `true` cuando el contador de la segunda muestra es menor que el de la primera. No es un error del panel ni un dato raro: es el contenedor reiniciándose, y el trazo tiene que **partirse ahí** en lugar de dibujar una caída vertical de 40 GB.

### 2.4 Nuevos tokens de gráfico

SPEC-16 declaró ocho tokens `--color-chart-*`. Faltan los cuatro de las tasas, que son magnitudes distintas de las de censo (una imagen o un volumen tienen un color; un flujo de red y otro de disco, no):

```css
/* Tasas (SPEC-17). Mismo criterio que la paleta de SPEC-16: el color significa
   lo mismo en todas las gráficas de la aplicación. */
--color-chart-net-in: ...    /* bytes recibidos por segundo */
--color-chart-net-out: ...   /* bytes transmitidos por segundo */
--color-chart-io-read: ...   /* bytes leídos de bloque por segundo */
--color-chart-io-write: ...  /* bytes escritos de bloque por segundo */
```

`frontend/tests/theme-tokens.test.ts` los exige declarados: en Tailwind v4 una utilidad cuyo color no está en `@theme` no se genera y la clase queda muerta sin avisar.

### 2.5 Configuración nueva — `backend/app/core/config.py`

```python
# Periodo del muestreador (SPEC-17). Medido: `stats(stream=False)` tarda ~1 s y
# el daemon responde en olas de ~1 s, así que 1 s de periodo nunca se cumple y
# cada tic se iría a 2. Con 2 s hay tic dentro de la ola y el coste medido por
# contenedor observado es de una lectura cada 2 s.
METRICS_SAMPLE_INTERVAL_S: float = 2.0

# Muestras por contenedor. 450 a 2 s son 15 minutos, que es la ventana máxima
# que ofrece la interfaz. Es un tope de memoria, no de muestreo.
METRICS_MAX_SAMPLES: int = 450

# Anillos vivos a la vez. Al superarlo se expulsa el más antiguo que no esté
# observado; si todos lo están, observar otro más responde 409. El límite no es
# arbitrario: cada anillo observado cuesta un `stats()` cada 2 s, y doce son
# seis llamadas por segundo al daemon.
METRICS_MAX_TRACKED: int = 12

# Sin actividad ni observación, el anillo se tira. 30 min es más que la ventana
# máxima, así que un anillo al que se vuelve siempre tiene lo que se buscar.
METRICS_TTL_S: int = 1800
```

### 2.6 Lo que se midió en la Fase 1, y por qué este diseño es el que es

Todas las cifras de esta tabla son de este host (Docker 29.8.2, 12 CPU) contra `peluchito` (nginx:alpine). No son estimaciones.

| Cosa | Medido | Consecuencia en el diseño |
| :--- | :--- | :--- |
| `stats(stream=False)` | **~1004 ms** | El `gather` del muestreador es obligatorio (§4.2). Secuencial, un tic con 12 observados no llegaría nunca al periodo |
| Lecturas concurrentes | 2 a 12 en la misma ola: **~2005 ms** totales | El daemon no serializa: leer 12 en paralelo cuesta lo mismo que leer 2 |
| `containers.list()` | **16-26 ms** para todos | El estado se pregunta una vez por tic, no una vez por contenedor (§4.5) |
| `show()` de un contenedor | **0,3 ms** | Barato, pero son N llamadas; por eso se prefiere `list()` |
| `stats(stream=False)` de un contenedor **parado** | **`200`**, con `memory_stats {}`, `networks None`, `blkio * None`, CPU a 0 | **No hay `409` que esperar.** El estado hay que preguntarlo (§4.5) |
| `stats(stream=False)` | Devuelve una **lista** de un elemento, no un dict | Hay que tomar `[-1]`, igual que ya hace `StatsService.get_stats()` |
| `system_delta` de `precpu_stats` | ~11,9e9 ns ≈ **1 s** de CPU del sistema en 12 núcleos | El porcentaje de CPU de la lectura de una vez es un promedio de 1 s, y da igual el periodo del muestreo |
| `online_cpus` | 12 | Confirma la fórmula de `calculate_cpu_percent()` y por qué 100 % es **un** núcleo |
| Tamaño de una `MetricSample` | **264 B** → 116 KiB por anillo de 450, **1,4 MiB** para 12 | Los topes de memoria son holgados; el tope que de verdad aprieta es el de llamadas al daemon |

Las dos primeras filas son las que cambian el diseño. Las demás lo confirman.

---

## 3. Contrato de API

### 3.1 Endpoints REST

Tres endpoints nuevos, todos en `app/api/v1/containers.py`. Los tres leen y escriben **el mismo `MetricsStore`**: el REST y el WebSocket son dos puertas al mismo anillo, nunca dos anillos.

| Método | Endpoint | Descripción | Body | Respuesta Exitosa | Errores Posibles |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/containers/{id}/metrics` | La serie del contenedor con los metadatos de ventana. **No crea el anillo** si no existe: mirar no es observar | N/A | `200 OK` (`MetricsHistory`, con `samples` vacío si nunca se observó) | `404`, `503` |
| `POST` | `/api/v1/containers/{id}/watch` | Fija el contenedor: el muestreador lo mide aunque nadie lo mire | N/A | `200 OK` (`{container_id, observed: true}`) | `404`, `409` (ya está al tope de observados) |
| `DELETE` | `/api/v1/containers/{id}/watch` | Lo desfija. Su anillo sigue hasta que expire | N/A | `200 OK` (`{container_id, observed: false}`) | `404` |

`GET /api/v1/containers` **no** es un endpoint nuevo, pero su respuesta cambia: `ContainerSummary` gana `observed: bool`. No hay coste de daemon (ver §4.9).

El `503` del `GET /metrics` es el de siempre: `docker_error_status()` traduce a `503` cualquier cosa que no caiga en `[400, 600)`, incluido el `900` de aiodocker cuando el daemon está caído. Ningún endpoint de esta spec escribe `status_code=e.status`.

### 3.2 Canal WebSocket

- **URL**: `/ws/containers/{id}/stats` — **el mismo de siempre**. No hay canal nuevo.
- **Mensaje entrante**: ninguno. Es un canal de solo salida, como ya era.
- **Mensajes salientes**, en este orden:
  1. `{"type": "history", "history": { ... }}` — una vez, justo después del `accept()` y **antes** de la primera muestra en vivo.
  2. `{ ...ContainerStats }` — las muestras en vivo, **sin cambio de contrato**: siguen sin llevar `type`, exactamente como las que envía `ws.py:199` hoy.
- **Cierre / desconexión**:
  - Contenedor inexistente → `4404` (sin cambios).
  - Error del daemon → `1011` (sin cambios).
  - Fin del stream → cierre limpio, que el cliente no reintenta (sin cambios).
  - Desfijar un contenedor **no** cierra el WebSocket: el canal es del modal, el pin es del almacén. Son dos cosas distintas y no se mezclan.

### 3.3 Por qué no hay endpoint de listado de observados

Sería el cuarto endpoint, y no lo hay: `GET /api/v1/containers` ya lleva `observed` en cada fila (§4.9). Un endpoint aparte devolvería el mismo dato que ya viaja en el listado, y obligaría al cliente a cruzarlo para pintar el mismo punto.

---

## 4. Mecánica

### 4.1 Un solo escritor

`MetricsStore.append()` es la **única** función del proyecto que mete una muestra en el anillo, y la llama el muestreador. No la llama el WebSocket: el stream de `StatsService.stream_stats()` sigue llegando al cliente tal cual, sin tocar. La razón es la que agent.md ya escribió para los logs: si uno cuenta por el byte y el otro por el texto, una línea cambia de sitio a mitad de vista. Aquí la misma regla dice que **el anillo y la muestra en vivo no pueden tener dos escritores**, porque acabarían con dos puntos distintos para la misma muestra.

Consecuencia asumida y escrita: con el modal abierto **y** el contenedor observado, el daemon recibe **dos** peticiones por periodo — el `stats(stream=True)` del WebSocket y el `stats(stream=False)` del muestreador. Se acepta: son dos llamadas cada 2 s sobre un contenedor ya observado, y el precio de la duplicación es menor que el de dos anillos.

### 4.2 Un solo muestreador, no uno por contenedor

Una única tarea de asyncio, creada en el `lifespan` de `app/main.py` y cancelada al apagar. Cada tic:

1. Una llamada a `containers.list()` —**una para todos**, no una por contenedor— para saber cuáles están en marcha. Medido: **16-26 ms** con dos contenedores.
2. `asyncio.gather()` de un `stats(stream=False)` por contenedor observado que esté en marcha, cada uno pasado por `calculate_stats()` y un `append()`.
3. Duerme `METRICS_SAMPLE_INTERVAL_S`.

Ni una tarea por contenedor, ni un `create_task` por pin, ni un `asyncio.gather` que haya que cancelar uno a uno: **el coste de esta decisión son unas 40 líneas y una sola lista de cancelación**. Es la diferencia entre SPEC-17 y la clase de bug que agent.md ya documenta dos veces sobre conexiones y tareas huérfanas.

El `gather` **no es una optimización, es obligatorio**, y la Fase 1 lo medido (§2.6): cada `stats(stream=False)` **tarda ~1 segundo**, no milisegundos. Secuencial, un tic con 12 observados duraría 12 s y nunca llegaría al periodo de 2 s; con `gather`, los 12 salen en la misma ola y el tic dura lo que dura una ola.

El reloj es inyectable (`MetricsStore(now=...)`, y un `sleep` inyectable o un `interval=0` en los tests) porque un test que espera 2 s para ver aparecer una muestra es un test lento que además se vuelve intermitente.

Si el tic se cancela mientras hay lecturas en vuelo, `gather` propaga la cancelación a cada una y el `finally` cierra el cliente de Docker: es el mismo cuidado que `compose_cli._matar()` describe SPEC-13, y por el mismo motivo.

### 4.3 Observar: el pin es lo que hace que el buffer valga

`observed` es un **flag en memoria** por contenedor —no un contador de referencias: `POST` lo pone y `DELETE` lo quita, y no hay sesiones que lo referencien—, y se expone por dos endpoints REST. Al fijar un contenedor, el muestreador lo mide aunque no haya ni una conexión abierta. Al desfijarlo, sigue midiéndose mientras su anillo no expire, y luego se tira.

La decisión de **dónde vive el pin** es la misma que la del anillo: en el backend, en memoria. No en `localStorage` del navegador, por dos razones que ya están escritas en el proyecto: el panel es de un solo operador sin sesiones, así que un pin en el navegador significaría "observo lo que observé en *esta* pestaña", y un `GET /containers/{id}/metrics` alcanza igual a todas las pestañas abiertas a la vez. El coste es que **el pin no sobrevive a reiniciar el backend**, y eso se dice en la interfaz (§4.8), no se disimula.

### 4.4 Absolutos, tasas y el reinicio que parte la línea

El anillo guarda **absolutos**, los que dice el daemon, y las tasas se derivan en el cliente (`utils/rates.ts`, función pura). No en el backend, por dos razones:

- Si el backend derivara la tasa, tendría que emparejarla con la muestra anterior **de dentro del anillo**, y una muestra que se pierde —una excepción, un tic que se pasó— dejaría la tasa mal en lugar de simplemente faltar.
- Con absolutos, un hueco es un hueco: el par que cruza el hueco produce una tasa de la media real del intervalo, que es un dato **correcto**, no uno inventado.

`bytes_per_second = Δcontador / Δt`. La tasa se calcula sobre el intervalo **real** entre las dos muestras, no sobre `interval_s`: con 450 puntos a 2 s la diferencia es pequeña, pero si el daemon tarda 9 s en un tic, dividir por 2 daría una tasa 4,5 veces mayor que la real.

Y hay un tercer caso que no es un hueco sino un **salto**: cuando `contador_actual < contador_anterior`, el contenedor se ha reiniciado y los contadores volvieron a cero. Restar daría un número negativo, y tomar el absoluto daría una flecha de 40 GB. `RateSample.broken` marca el punto y el gráfico parte el trazo ahí. Es el mismo motivo por el que SPEC-18 distingue `"none"` de `"healthy"`: la ausencia de dato y el dato de valor cero son cosas distintas y confundirlas produce una gráfica que afirma cosas falsas.

### 4.5 Parado es un hueco, y un cero habría sido un invento

**Medido, y no es lo que se esperaba**: un contenedor parado **no** da `409`. `stats(stream=False)` sobre `full-editor-db` (exited) responde `200` con un frame de aspecto normal cuyas piezas están vacías:

```text
cpu_stats.cpu_usage.total_usage = 0      memory_stats = {}
networks            = None              blkio_stats.* = None
```

Pasado por `calculate_stats()` eso da **todos los ceros**, y dibujados afirmarían "este contenedor no usa CPU ni memoria ni red", que es una afirmación falsa sobre un contenedor que está parado. El `409` es lo que da **`stream=True`** sobre un contenedor parado, no la lectura de una vez.

Por tanto el estado hay que preguntarlo, y hay dos formas de hacerlo, ambas medidas:

| Fuente | Coste | Nota |
| :--- | :--- | :--- |
| `containers.list()` | **16-26 ms** para **todos** los contenedores | Devuelve `State` por contenedor, así que un solo `list()` por tic responde por todos los observados |
| `containers.get(id).show()` | **0,3 ms** por contenedor | Se puede pedir por cada observado, pero son N llamadas |

Se usa **`containers.list()`**: una llamada por tic en lugar de N, y el estado de un contenedor que no está en el listado es que no está en marcha. `StatsService.get_stats()` ya hace la comprobación por `show()` y por eso no se rompe, pero su `empty_stats()` de ceros es justo la respuesta que el anillo no debe guardar.

La regla que se aplica:

- El anillo **no crece** con un contenedor parado. No se añade ni un `0`, y ni siquiera se le pregunta.
- El hueco se ve como hueco: entre dos muestras hay una distancia en `t`, y si es mayor que 2,5 × `interval_s` el cliente parte el trazo (§4.4).
- `MetricsHistory.running` dice si está en marcha ahora, leído del mismo `list()` del tic, en lugar de deducirlo de las muestras.
- Un contenedor que desaparece del `list()` (borrado) tiene su anillo expirado por antigüedad, como cualquier otro (§4.8).

### 4.6 El historial viaja por el mismo canal, y el orden es lo que lo fija

No hay WebSocket nuevo. `/ws/containers/{id}/stats` manda **un** mensaje nuevo justo después del `accept()` y **antes** de la primera muestra:

```json
{"type": "history", "history": { "container_id": "...", "samples": [ ... ], "interval_s": 2.0, ... }}
```

Después, las muestras en vivo de `ContainerStats` siguen llegando **sin cambio de contrato** (mismo `model_dump()` que ya envía `ws.py:199`). La asimetría es deliberada y hay que conocerla: el mensaje de historial se identifica por su `type`, y las muestras en vivo se identifican por **no tenerlo**. La regla para quien añada un tercer tipo de mensaje: si no es una muestra en vivo, lleva `type`. El orden —historial primero, luego muestras— es lo que garantiza que un cliente no pueda tener dos series para el mismo punto, porque en el momento de la primera muestra el anillo ya está en sus manos.

### 4.7 La x del gráfico es tiempo, no índice

`StatsSparkline` coloca el punto *i* en `i / (n - 1)` (`StatsSparkline.tsx:35`), lo cual sólo es cierto si todas las muestras están separadas por lo mismo. Con el anillo no lo están: hay huecos por los que el daemon tardó, por un contenedor parado y por un tic perdido. La abscisa es `(t - t₀) / (t_fin - t₀)`, y una ventana de 5 minutos que se pinta sobre lo que hay parece más corta cuanto más antiguo sea.

### 4.8 Topes, expulsión y lo que el panel no recuerda

| Tope | Valor | Qué hace al superarse |
| :--- | :--- | :--- |
| Muestras por contenedor | 450 (15 min a 2 s) | Se descarta por el frente, y el tramo se marca con `truncated: true` |
| Anillos vivos | 12 | Se expulsa el más viejo **no observado**; si todos lo están, observar otro más responde `409` |
| Antigüedad sin actividad | 30 min | El anillo se tira entero |

Con lo que hay que ser explícito en la interfaz, y no con un número: **reiniciar el backend borra todos los históricos y todos los pines**. La ayuda y el propio modal lo dicen cuando la serie viene vacía; un estado vacío que no explica por qué está vacío se lee como un fallo del panel.

### 4.9 El estado del pin viaja en el listado, sin una llamada por contenedor

`GET /api/v1/containers` añade `observed: bool` a `ContainerSummary`, y sale de **una consulta al diccionario en memoria**, no de una llamada al daemon por contenedor. Es el mismo criterio que SPEC-18 §4.1 (el listado trae la salud sin un `show()` por contenedor, con test que lo verifica) y por eso `observed` en la tabla no cuesta una ida y vuelta: la fila sabe si está observada antes de que se pulse nada.

La otra mitad es el mismo límite de SPEC-18 §4.2: **el pin es un estado de la vista, no del host**. Da igual que se filtre por estado o por salud, el censo entero sigue estando en el listado, y por eso los contadores de las píldoras no bailan.

### 4.10 Por qué el historial de salud no entra aquí

SPEC-18 §1 difirió a SPEC-17 el histórico de transiciones de salud. Sigue diferido, y el motivo es que **no es la misma fuente**: `Health.Log` sale de `GET /containers/{id}/json`, y el muestreador de esta spec mide `/containers/{id}/stats`. Meterlo aquí sería un segundo muestreo, con su propio ritmo, y cada `Log` anterior se conserva cinco entradas y no una serie. Es un anillo pequeño y **separado**, con su propio endpoint, y merece su número.

---

## 5. Criterios de Aceptación (Gherkin en Español)

```gherkin
# language: es
Característica: Series temporales de métricas por contenedor
  Como operador que vigila un contenedor
  quiero ver cómo evolucionan CPU, memoria, red y disco
  para distinguir "siempre ha ido así" de "ahora va mal"

  Antecedentes:
    Dado que el daemon de Docker está accesible

  Escenario: Abrir el modal con historial ya acumulado
    Dado un contenedor observado hace 4 minutos
    Cuando el usuario abre sus métricas
    Entonces ve la serie de los últimos minutos en las cuatro métricas
    Y la serie llega antes que la primera muestra en vivo
    Y la última lectura coincide con el valor que muestra el panel

  Escenario: Un contenedor sin historial lo dice
    Dado un contenedor que nunca se ha observado
    Cuando el usuario abre sus métricas
    Entonces ve "Sin historial todavía" y una explicación de cómo acumularlo
    Y no ve una línea plana que parezca un dato

  Escenario: Observar un contenedor sigue midiéndolo con el modal cerrado
    Dado un contenedor en marcha
    Cuando el usuario lo observa
    Y cierra el modal y espera dos minutos
    Y vuelve a abrir sus métricas
    Entonces la serie cubre los dos minutos en los que nadie la miraba

  Escenario: Dejar de observar
    Dado un contenedor observado
    Cuando el usuario deja de observarlo
    Y cierra el modal
    Entonces el muestreador deja de llamar al daemon para ese contenedor

  Escenario: Un contenedor parado no inventa ceros
    Dado un contenedor observado que se detiene
    Cuando pasan unos segundos
    Entonces su serie no crece con muestras a cero
    Y el hueco se ve como un hueco, con la línea partida
    Y el modal dice que el contenedor está parado

  Escenario: El reinicio parte la línea en lugar de dibujar una caída
    Dado un contenedor observado cuyo contador de red sube
    Y el contenedor se reinicia, de modo que el contador vuelve a cero
    Cuando el usuario mira la serie de red
    Entonces la línea está partida en ese punto
    Y no aparece una caída vertical ni una tasa negativa

  Escenario: La ventana elegida se respeta en el tiempo
    Dado un contenedor con 10 minutos de historial
    Cuando el usuario elige la ventana de 1 minuto
    Entonces la serie solo cubre el último minuto
    Y el eje del tiempo se espacia por el tiempo real, no por el número de puntos

  Escenario: Las tasas son el promedio del intervalo, no del periodo nominal
    Dado dos muestras separadas 8 segundos porque el daemon tardó
    Cuando se calcula la tasa entre ellas
    Entonces divide el contador por 8
    Y no por el periodo nominal del muestreo

  Escenario: La serie se acota y se dice
    Dado un contenedor observado durante más de la ventana máxima
    Cuando el usuario pide su historial
    Entonces recibe como mucho el tope de muestras
    Y la respuesta indica que el histórico está truncado

  Escenario: Hay un límite de contenedores observados
    Dado que ya se observan todos los contenedores que el panel admite
    Cuando el usuario intenta observar otro más
    Entonces el sistema responde que hay un límite y cuál es

  Escenario: El pin se ve sin pedir nada extra
    Dado un contenedor observado y otro que no
    Cuando el usuario abre la tabla de contenedores
    Entonces el observado aparece marcado como observado
    Y pedir el listado no ha hecho una llamada por contenedor al daemon

  Escenario: El daemon se cae y el panel no se cae
    Dado un contenedor observado
    Y el daemon deja de responder
    Cuando el panel recibe el error de conexión
    Entonces el muestreador avisa por log y sigue vivo
    Y el modal sigue mostrando la última serie conocida
    Y el backend no intenta servir un código de estado inválido

  Escenario: El anillo sobrevive a recargar la página
    Dado un contenedor observado con historial acumulado
    Cuando el usuario recarga el navegador
    Y vuelve a abrir sus métricas
    Entonces la serie sigue ahí, porque no vivía en el navegador

  Escenario: Vaciar el panel es una decisión, no un olvido
    Dado que el backend se reinició y ya no hay anillos
    Cuando el usuario abre unas métricas
    Entonces la interfaz dice que el histórico no sobrevive a un reinicio del panel
    Y ofrece observar para empezar de nuevo
```

---

## 6. Plan de Pruebas Automatizadas

### Backend (`pytest`)

- `backend/tests/test_metrics_store.py` — el anillo como estructura:
  - `test_añade_hasta_el_tope`: insertar más de `METRICS_MAX_SAMPLES` deja el tope y `truncated` a `True`.
  - `test_truncated_false_mientras_cabe`: un anillo que no llega al tope no dice que está truncado.
  - `test_descarta_por_el_frente`: la muestra más antigua es la que se va.
  - `test_expulsa_el_mas_viejo_no_observado`: al superar `METRICS_MAX_TRACKED` desaparece el que lleva más tiempo sin actividad.
  - `test_no_expulsa_un_observado_para_hacer_site_a_otro_no_observado`.
  - `test_rechaza_observar_cuando_todo_el_tope_esta_observado`.
  - `test_expulsa_por_antiguedad`: un anillo sin actividad pasa de `METRICS_TTL_S` y desaparece.
  - `test_expulsar_el_anillo_lo_desmarca`: expirar un observado no deja un pin sin anillo.
  - `test_refresco_no_crea_un_anillo`: pedir el historial de un contenedor que no existe en el almacén no lo crea.
- `backend/tests/test_metrics_sampler.py` — el muestreo, con reloj inyectado:
  - `test_mide_un_observado_cada_tic`: un contenedor observado recibe una muestra por periodo.
  - `test_no_mide_lo_que_no_esta_observado`: un contenedor sin pin y sin conexión no se toca.
  - `test_una_llamada_por_contenedor_por_tic`: tres conexiones WebSocket del mismo contenedor no triplican el muestreo.
  - `test_no_añade_muestras_a_un_contenedor_parado`: el `409` del daemon no deja ceros en el anillo.
  - `test_la_muestra_usa_calculate_stats`: los valores del anillo pasan por el normalizador, no por un `dict` crudo.
  - `test_sobrevive_a_docker_error`: un `DockerError(900)` deja el muestreador vivo y sin muestrear ese tic.
  - `test_se_cancela_al_apagar`: apagada la aplicación, la tarea del muestreador termina.
- `backend/tests/test_metrics_api.py` — REST:
  - `test_historial_de_un_contenedor_observado`: `200` con la serie y los metadatos de ventana.
  - `test_historial_de_un_contenedor_inexistente`: `404`.
  - `test_historial_no_crea_anillo`: el `GET` de uno nunca observado responde con `samples` vacío y no lo registra.
  - `test_observar_y_dejar_de_observar`: `POST` y `DELETE` alternan el estado.
  - `test_observar_inexistente`: `404`.
  - `test_observar_cuando_no_cabe`: `409` con el límite en el mensaje.
  - `test_listado_incluye_observed`: `observed` viaja en el listado y no se llama a `/stats` por contenedor (contador de llamadas al doble de `aiodocker`).
- `backend/tests/test_ws_stats_history.py` — el canal:
  - `test_el_historial_llega_antes_de_la_primera_muestra`: orden de mensajes en el WebSocket.
  - `test_el_historial_es_el_del_anillo`: lo que se manda es lo que el `MetricsStore` tiene.
  - `test_la_muestra_en_vivo_no_cambia_de_contrato`: el mensaje de stats en vivo sigue sin `type`.
  - `test_contenedor_inexistente_cierra_con_4404`.

### Frontend (`vitest` + `@testing-library/react`)

- `tests/utils/rates.test.ts` — `utils/rates.ts` como función pura:
  - `test_tasa_entre_dos_muestras`: `(Δcontador / Δt)` con un intervalo dado.
  - `test_divide_por_el_intervalo_real`: con 8 s de separación, no por 2.
  - `test_marca_el_salto_tras_un_reinicio`: `broken` a `true` cuando el contador baja.
  - `test_no_inventa_tasa_con_una_sola_muestra`: con un punto no hay tasa, y no es 0.
  - `test_corta_la_serie_a_la_ventana`: con ventana de 60 s sobre 10 min, sólo devuelve el último minuto.
- `tests/components/MetricChart.test.tsx`:
  - Escucha la abscisa por **tiempo**: con dos huecos desiguales, el punto intermedio no queda en el centro.
  - Dibuja **dos** trazos cuando hay un salto, y ninguno que los una.
  - Estado vacío con su explicación, y sin SVG.
  - Lectura de actual, media y máximo.
  - Colores por token, sin literales.
- `tests/components/StatsModal.test.tsx` (extender):
  - Selector de ventana, con la ventana por defecto en 300 s.
  - Las cuatro series se pintan, y las de red y disco en bytes por segundo.
  - Botón de observar y su reflejo en el estado del botón.
  - "Sin historial todavía" con el contenedor sin observar, y la ventana sugerida.
- `tests/hooks/useDockerStats.test.ts` (extender):
  - El mensaje `type: "history"` puebla `history` y **no** pisa `currentStats`.
  - La muestra posterior sí pisa `currentStats`.
  - Al reconectar, el historial se sustituye por el del servidor y no se concatena.
  - Un `history` con `samples: []` deja el estado vacío, no un error.
- `tests/components/HelpModal.test.tsx` (extender): la sección de datos en vivo ya **no** dice que no hay series.
- `tests/theme-tokens.test.ts`: los cuatro tokens de tasa están declarados y ninguna clase usa una paleta neutra.

---

## 7. Plan de Tareas (Tasks)

- [x] **Fase 1: Medir contra el daemon antes de decidir nada**
  - [x] Medir cuánto mide `stats(stream=False)` y qué ventana de delta de CPU trae `precpu_stats` en el host de referencia. **Hecho: ~1004 ms por lectura, `system_delta` de ~1 s, `online_cpus` 12. Tabla completa en §2.6.**
  - [x] Medir el tamaño de `Health.Log` y confirmar que no da para una serie (justifica §4.10). **Hecho: el daemon conserva 5 entradas, y salen de otro endpoint.**
  - [x] Anotar en §4.2 y §4.5 los números medidos y ajustar los valores de `config.py` si no dan. **Hecho, y cambiaron el diseño: el `gather` pasó a ser obligatorio y el `409` del contenedor parado resultó no existir.**
- [x] **Fase 2: Contratos**
  - [x] `backend/app/schemas/metrics.py` con `MetricSample` y `MetricsHistory`.
  - [x] `observed` en `ContainerSummary` (`app/schemas/container.py`).
  - [x] `frontend/src/types/metrics.ts` con `MetricSample`, `RateSample`, `MetricsHistory`, `RangeSeconds` y `MetricKey`.
  - [x] Los cuatro tokens de tasa en `frontend/src/index.css`, con su par claro y oscuro.
  - [x] Las cuatro settings de `METRICS_*` en `backend/app/core/config.py`.
- [x] **Fase 3: Tests primero en backend (fase roja)**
  - [x] `test_metrics_store.py` completo.
  - [x] `test_metrics_sampler.py` completo, con reloj inyectado.
  - [x] `test_metrics_api.py` completo.
  - [x] `test_ws_stats_history.py` completo.
  - [x] Ejecutar `pytest -v` y confirmar que falla por implementación ausente. **Hecho: los cuatro módulos fallan con `ModuleNotFoundError`.**
- [x] **Fase 4: Implementación backend**
  - [x] `backend/app/services/metrics_store.py`: anillo, topes, expulsión, TTL, pin y reloj inyectable.
  - [x] `backend/app/services/metrics_sampler.py`: una sola tarea, `stats(stream=False)`, sin tocar contenedores parados.
  - [x] `MetricsSampler` arrancado y cancelado en el `lifespan` de `app/main.py`.
  - [x] `POST` y `DELETE /api/v1/containers/{id}/watch`, y `GET /api/v1/containers/{id}/metrics` en `app/api/v1/containers.py`.
  - [x] `observed` en el listado, resuelto contra el almacén en memoria.
  - [x] Mensaje `type: "history"` en el WebSocket de estadísticas, antes de la primera muestra.
  - [x] **Dos desviaciones de la spec, decididas al implementar:** el tope de anillos vive en `_crear()` y no sólo en `observe()` (si no, un `append()` sobre un id nuevo lo esquivaba), y el id se normaliza a corto dentro del propio almacén, para que ningún módulo tenga que recortarlo (§4.1: una regla escrita dos veces acaba siendo dos reglas).
- [x] **Fase 5: Tests primero en frontend (fase roja)**
  - [x] `tests/utils/rates.test.ts` y `tests/components/MetricChart.test.tsx`.
  - [x] Extensiones de `useDockerStats.test.ts` y `StatsModal.test.tsx`.
- [x] **Fase 6: Implementación frontend**
  - [x] `frontend/src/utils/rates.ts`: `tasa()`, `cortar_ventana()` y `segmentos()`, puras y testeadas.
  - [x] `frontend/src/hooks/useDockerStats.ts`: `historial` (el del servidor), `reciente` (el búfer local, antes llamado `history`), `observed` y `running`.
  - [x] `frontend/src/components/stats/MetricChart.tsx`: SVG con eje temporal, roturas y lectura de actual/media/máx.
  - [x] `StatsModal`: selector de ventana, seis series y botón de observar.
  - [x] `ContainersTable`: marca de observado en la fila.
  - [x] **Dos desviaciones al implementar.** `MetricChart` necesita `interval_s` como prop: un hueco es "más de 2,5 intervalos" y sin el intervalo no hay umbral —pasarle `0` parte el trazo en cada punto—. Y el formateador de tasas se fue a `utils/format.ts` como `formatRate`, porque un archivo que exporta un componente y una función rompe el fast refresh y `oxlint` lo avisa.
- [x] **Fase 7: Verificación y quality gates**
  - [x] `pytest -v` en verde. **512 pruebas.**
  - [x] `pnpm run test` en verde, incluido `theme-tokens.test.ts`. **579 pruebas.**
  - [x] `python -m ruff check app tests` sin errores.
  - [x] `pnpm run lint` y `pnpm run build` sin errores.
- [x] **Fase 8: Documentación (los tres sitios de §2.2 y los dos que faltaban)**
  - [x] `specs/16-host-census-dashboard.md` §1: la exclusión de series temporales pasa a ser sólo del host.
  - [x] `agent.md`: la decisión del anillo en memoria, las tres trampas medidas y los módulos nuevos.
  - [x] `HelpModal.tsx`: el texto de "no hay series" y su test.
  - [x] `README.md`: la sección de datos en vivo, la de API (`GET /metrics`, `POST`/`DELETE /watch` y `observed`) y el recuento de endpoints, que decía 28 y ahora son 39.
  - [x] `agent.md` §4: el árbol de `specs/`, que listaba SPEC-16 dos veces y no tenía SPEC-17 ni SPEC-20.

### 7.1 Lo que NO se hace, a propósito

- [ ] Histórico persistente entre reinicios. Es una base de datos, y un panel local sin ella tiene menos superficie que roto.
- [ ] Historial de salud. Es otra fuente y merece su spec (§4.10).
- [ ] Series del host. SPEC-16 §1 ya lo excluyó con un argumento que no ha caducado.
- [ ] Comparar contenedores, zoom y medias móviles. No hay con qué comparar.
- [ ] Reutilizar `StatsSparkline` para el resto. Se queda como está, para las lecturas de un vistazo; el eje por índice es correcto mientras no haya huecos, y en cuanto los hay deja de serlo (§4.7).
- [ ] Notificar cuando un anillo se llene o se expulse. Sería un evento sobre el estado interno de un panel de un solo operador: nadie lo espera y complica el contrato.