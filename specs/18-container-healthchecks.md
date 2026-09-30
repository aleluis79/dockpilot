# SPEC-18: Healthchecks de contenedor

## 1. Contexto y Objetivos
- **Problema**: Docker tiene un sistema de healthchecks de primera clase y el panel lo ignora por completo: no aparece en el listado, ni en el detalle, ni como filtro. Para quien usa el panel, un contenedor `running` con su healthcheck en `unhealthy` es **indistinguible de uno sano**, y esa es exactamente la información que hace falta para decidir qué reiniciar. `Status` lo delata un poco —`"Up 13 seconds (unhealthy)"`— pero sólo como texto dentro de una cadenatranslatecida en `State`, que el panel ya expone como dato crudo y la UI no interpreta. Un contenedor puede llevar horas en `unhealthy` con la píldora verde al lado del nombre.
  - Comprobado contra el daemon de referencia (29.8.1, cuatro contenedores): **tres de cuatro no declaran healthcheck** y uno en `starting`. El caso que motiva la spec no es raro, pero tampoco es todos, y el caso mayoritario es "no healthcheck": por eso esta spec tiene que ser silenciosa para el que no lo tiene, y no hacer de la salud el estado principal de un contenedor.
- **Objetivo**: Mostrar la salud de un contenedor cuando existe, decir **por qué** no está sano, y poder filtrar por los que están mal, sinCalls extra al daemon y sin que un contenedor sin healthcheck se vuelva más ruidoso que hoy.
- **Alcance**:
  - Incluye:
    - `health` y `failing_streak` en el **listado**, sin llamadas adicionales: el daemon ya los trae en `GET /containers/json`.
    - En el **detalle**, el historial de las últimas sondas con su salida, que es lo que responde a "por qué".
    - Un filtro **Con problemas** que use el filtro `health` del propio daemon.
    - La salud en la píldora de estado y en la tabla, **sin restar protagonismo al estado de ejecución**.
    - Los comandos de healthcheck declarados en la imagen, para saber qué se está midiendo.
  - No incluye (en esta spec):
    - **Definir, editar o lanzar sondas desde el panel.** Un healthcheck se declara en el Dockerfile o en el compose, y su semántica (`interval`, `retries`, `start_period`) pertenece ahí. Este panel ni siquiera abre ficheros de compose (SPEC-14 §1), así que ofrecerlo aquí sería la mitad de una función.
    - **Reintentar la sonda.** El panel no tiene una sonda que reintentar: la ejecuta el daemon, según los parámetros declarados. Ofrecer un botón "reintentar" sería mandar una petición que el daemon no expone.
    - **Actuar sobre un `unhealthy`.** Ninguna acción de SPEC-01 se bloquea ni se sugiere por la salud. `restart` sigue siendo la decisión del usuario, con el mismo criterio de siempre.
    - **Histórico de cambios de salud.** Un contenedor pasó por `starting → healthy → unhealthy` y el panel sólo conoce el estado de ahora. Eso es una serie temporal, y es SPEC-17.
    - **El `Log` completo de las sondas.** El daemon guarda las últimas 5; se muestran esas, que es todo lo que hay.
    - **Healthchecks de imágenes** (`HEALTHCHECK` en el `Dockerfile`). Se lee lo que el contenedor declara en ejecución, que es lo que el panel puede observar.

---

## 2. Contrato de Datos (Schemas & Types)

### 2.1 Backend (Pydantic v2) — `app/schemas/container.py`

El healthcheck vive en **dos** sitios del daemon y no se pueden confundir:

```python
class HealthSummary(BaseModel):
    """Salud del contenedor, o el hecho de que no tenga healthcheck.

    Es un objeto y no un `str` porque "no healthcheck" no es un estado más: es
    la ausencia del dato, y confundida con `"none"` haría que un contenedor sin
    sonda pareciera evaluado y saliendo bien.
    """
    status: Literal["healthy", "unhealthy", "starting", "none"]
    failing_streak: int = 0


class HealthProbe(BaseModel):
    """Una sonda ya ejecutada por el daemon."""
    started_at: str = Field("", description="Inicio en ISO-8601")
    finished_at: str = Field("", description="Fin en ISO-8601")
    exit_code: int = 0
    output: str = Field("", description="Salida de la sonda, vacía si no dijo nada")


class HealthDetail(HealthSummary):
    """Salud con el porqué. Solo en el detalle, que es donde hay `inspect`."""
    log: list[HealthProbe] = Field(default_factory=list)
    test: list[str] = Field(
        default_factory=list,
        description="Config.Healthcheck.Test de la imagen; vacía si no hay healthcheck",
    )
```

`ContainerSummary` gana `health: HealthSummary = Field(default_factory=HealthSummary)`.

`ContainerDetail` **no** añade un campo paralelo: **re-declara** `health` con el tipo `HealthDetail`, y el handler lo rellena desde `State.Health`, que trae `Log`. Es el mismo campo con más detalle, porque "la salud" no son dos cosas.

La re-declaración **no es opcional**, y salta a la vista: Pydantic recorta el valor al tipo del campo en el padre, así que sin ella un `HealthDetail` entero se serializaría como `HealthSummary` y `log` y `test` desaparecerían de la respuesta **sin dar ningún error**. Pydantic no avisa: simplemente cumple el tipo que le dieron. Lo detectó `test_la_api_expone_la_salud_en_listado_y_detalle`, que falla con `KeyError: 'log'`.

### 2.2 El dato crudo, medido contra el daemon

Las tres formas reales, comprobadas en 29.8.1. Lo que se lee de dónde:

| Dónde | Sin healthcheck | Con healthcheck |
| :--- | :--- | :--- |
| `containers/json` → `Health` | `{"Status": "none", "FailingStreak": 0}` | `{"Status": "healthy", "FailingStreak": 0}` |
| `containers/{id}/json` → `State.Health` | **`null`** (la clave no existe) | `{"Status", "FailingStreak", "Log": [...]}` |
| `containers/{id}/json` → `Config.Healthcheck.Test` | `null` | `["CMD-SHELL", "exit 0"]` |

De ahí salen tres reglas que no son Evidentes y que el doble de test tiene que reproducir:

1. **En el listado `"none"` es un valor, no una ausencia.** Es el único sitio donde se puede distinguir "no healthcheck" de "sonda en curso".
2. **En el detalle la ausencia es `None`**, no `"none"`. `State.Health` directamente no existe cuando no hay healthcheck.
3. **El listado NO trae `Log`**, así que un `HealthSummary` del listado no puede llevar historial. Por eso `Log` vive en `HealthDetail` y no en `HealthSummary`.

Y una cuarta, que es una trampa de versión: **`Health` en el listado sólo existe en Docker ≥ 20.10** (API ≥ 1.41). Un daemon más viejo no manda la clave, y el panel tiene que funcionar igual. Se trata como `"none"`, que es la respuesta correcta para un daemon sin healthchecks.

### 2.3 Frontend (TypeScript) — `src/types/docker.ts`

Coincide campo por campo con el backend (regla 5 de `agent.md`):

```typescript
export type HealthStatus = 'healthy' | 'unhealthy' | 'starting' | 'none';

export interface HealthSummary {
  status: HealthStatus;
  failing_streak: number;
}

export interface HealthProbe {
  started_at: string;
  finished_at: string;
  exit_code: number;
  output: string;
}

export interface HealthDetail extends HealthSummary {
  log: HealthProbe[];
  test: string[];
}
```

---

## 3. Mecánica

### 3.1 Por qué el listado no cuesta ni una llamada

`GET /containers/json` ya incluye `Health` con `Status` y `FailingStreak`. Escribirlo es leer un dict que ya se está leyendo para `State` y `Status`; no hay N+1 ni inspect por contenedor.

Esto es lo que hace viable la feature y es una comprobación, no una suposición: se verificó contra el daemon antes de escribir el spec.

### 3.2 El filtro "Con problemas" se aplica en el navegador, como el de estado

**Corrección de una decisión que el spec tenía mal.** La primera redacción de esta sección decía que el filtro lo resolvería el daemon con `filters.health`. Es cierto que funciona —comprobado contra el daemon 29.8.1:

```text
filtro health=unhealthy -> ['/dockpilot-unhealthy']
filtro health=healthy   -> []
```

— pero **no es lo que hay que hacer aquí**, y `agent.md` ya explica por qué: el filtro de estado se quitó del servidor a propósito, porque los contadores de las píldoras son un **censo del host** y no un recuento de lo que se está viendo. Pedir al daemon sólo los `unhealthy` haría que `rawContainers` dejara de contener el censo entero, y los contadores de «Todos» y «Activos» bailarían con cada clic.

Así que el filtro de salud va **en el navegador**, junto al de estado, contra la lista completa. El parámetro `?health=` **sí** se expone en la API y **sí** lo resuelve el daemon: es la superficie correcta para quien llame al endpoint directamente, y evita un N+1. Lo que no se hace es atar la vista a esa llamada.

### 3.3 Cómo se muestra, y por qué el estado de ejecución manda

Un contenedor puede estar `exited` y su healthcheck nunca corrió, o `running` y `unhealthy`. Son ejes distintos y no se funden:

- **La píldora sigue siendo el estado de ejecución.** Es lo que el usuario busca escaneando una tabla, y `exited` no es menos importante por tener o no sonda.
- **La salud va al lado, como marca secundaria**: un punto más y un texto corto. `running` + `unhealthy` se lee como "está en marcha y no está bien", que son las dos cosas y en ese orden.
- **Con `start_period` una sonda nueva sale `starting`**, que no es un fallo. Se pinta en el ámbar de `paused`/`restarting`, no en el rojo de `unhealthy`.

`StatusBadge` recibe `health` opcional. **Un contenedor sin healthcheck no cambia un píxel**: ni punto extra, ni texto, ni borde. Es la mayoría, así que no puede pagar el ruido de la minoría.

### 3.4 El detalle responde "por qué", y el listado no

`State.Health.Log` trae las últimas 5 sondas con `ExitCode` y `Output`. Es lo que convierte "está unhealthy" en actionable, y es la razón por la que la feature no se queda en la píldora.

La salida se muestra con `whitespace-pre-wrap` y recortada a 4 KB. **El motivo no es el que parecía**: la primera redacción de esta spec decía que una sonda podía imprimir un volcado de 4 MB. Es falso, y está medido: **el propio daemon recorta la salida de la sonda a 4096 bytes** antes de mandarla. Comprobado con una sonda que intentaba imprimir 3 MB:

```text
$ docker inspect --format '{{json .State.Health.Log}}' <contenedor> | ...
ExitCode: 0 | len(Output): 4099
```

Así que el recorte del panel es **defensa en profundidad**, no la barrera principal: si mañana el daemon deja de recortar, o si el formato de `Log` cambia, el modal sigue sin recibir megabytes. El recorte marca cuántos bytes quitó, para no fingir que la línea termina ahí.

`Config.Healthcheck.Test` se enseña literally (`["CMD-SHELL", "exit 0"]`): saber **qué** se mide es la mitad de entender un `unhealthy`. Una base de datos que "no está sana" y una web que "no está sana" no son el mismo problema.

### 3.5 `starting` no es `unhealthy`, y `none` no es `healthy`

Los cuatro estados significan cosas distintas y la UI no los fusiona:

| Estado | Qué significa | Cómo se pinta |
| :--- | :--- | :--- |
| `healthy` | La última sonda pasó | Verde, discreto |
| `unhealthy` | Se agotaron los reintentos | Rojo, junto al estado |
| `starting` | Dentro del `start_period` | Ámbar: aún no se sabe |
| `none` | No hay healthcheck declarado | **Nada** |

`none` no se muestra porque no es un estado del contenedor: es la ausencia de una función. Un panel que pone "none" al lado de cada contenedor sin sonda está gritando sobre lo que no está mal.

---

## 4. Criterios de Aceptación (Gherkin en Español)

```gherkin
# language: es
Característica: Healthchecks de contenedor
  Como operador de un host con contenedores en marcha
  quiero saber si un contenedor está sano
  para no descubrir a las 9 de la mañana, por el aviso de correo, que lleva
  seis horas en unhealthy

  Antecedentes:
    Dado que el daemon de Docker está accesible

  Escenario: Contenedor sano en el listado
    Dado un contenedor "web" en marcha con healthcheck en healthy
    Cuando el panel pide la lista de contenedores
    Entonces la respuesta incluye health.status con valor "healthy"
    Y la fila lo muestra con una marca verde junto al estado

  Escenario: Contenedor unhealthy con su motivo
    Dado un contenedor "db" en marcha con healthcheck en unhealthy
    Cuando el panel pide el detalle de "db"
    Entonces la respuesta incluye health.status con valor "unhealthy"
    Y la respuesta incluye el historial de sondas
    Y cada sonda trae su código de salida y su salida
    Y el detalle muestra los comandos que se están midiendo
    Y el historial se muestra en orden, de la más antigua a la más reciente

  Escenario: Contenedor sin healthcheck no se distingue
    Dado un contenedor "cache" en marcha sin healthcheck declarado
    Cuando el panel pide la lista de contenedores
    Entonces la respuesta incluye health.status con valor "none"
    Y la fila no muestra ninguna marca de salud
    Y el detalle no muestra historial de sondas

  Escenario: Sonda en curso no se muestra como fallo
    Dado un contenedor "api" recién arrancado cuyo start_period no ha vencido
    Cuando el panel pide el detalle de "api"
    Entonces la respuesta incluye health.status con valor "starting"
    Y la marca de salud no es de error

  Escenario: Contador de fallos consecutivos
    Dado un contenedor "db" con tres sondas fallidas seguidas
    Cuando el panel pide el detalle de "db"
    Entonces la respuesta incluye health.failing_streak con valor 3

  Escenario: Filtrar por contenedores con problemas
    Dado tres contenedores, uno unhealthy y dos healthy
    Cuando el panel filtra por "Con problemas"
    Entonces la lista contiene solo el contenedor unhealthy
    Y el contador de la píldora dice 1

  Escenario: Un contenedor parado no cuenta como problema de salud
    Dado un contenedor parado que tuvo healthcheck en unhealthy antes de pararse
    Cuando el panel filtra por "Con problemas"
    Entonces el contenedor no aparece
    Porque el filtro mira la salud, y la salud de un contenedor parado no es
    información sobre la que se pueda actuar desde aquí

  Escenario: Daemon antiguo sin soporte de health
    Dado un daemon que no devuelve la clave Health en el listado
    Cuando el panel pide la lista de contenedores
    Entonces la respuesta incluye health.status con valor "none"
    Y la lista se devuelve con normalidad

  Escenario: La salida de una sonda enorme no rompe el modal
    Dado un contenedor unhealthy cuya última sonda imprime 3 MB
    Cuando el panel pide el detalle del contenedor
    Entonces la respuesta se entrega con la salida recortada
    Y el recorte dice cuántos bytes quitó
    Y el historial completo de sondas sigue ahí

    El daemon ya recorta a 4096 por su cuenta, así que este caso lo ejercita el
    doble de test metiendo una salida enorme a propósito: la barrera principal es
    del daemon y la del panel es la red de seguridad.
```

---

## 5. Plan de Pruebas Automatizadas

### Backend (`pytest`)
- `test_listado_incluye_la_salud_sin_llamadas_extra`: `Health` del listado se proyecta a `HealthSummary`, y se comprueba que **no** se llama a `show()` por contenedor (el N+1 sería la forma fácil de hacerlo mal).
- `test_sin_healthcheck_devuelve_none`: `{"Status": "none"}` en el listado → `"none"`, no `"healthy"`.
- `test_un_daemon_que_no_manda_health_deja_none`.
- `test_detalle_trae_el_historial_de_sondas`: de `State.Health.Log`, en orden, con exit code y output.
- `test_detalle_usa_el_health_del_inspect_y_no_el_del_listado`: el detalle trae `Log`, así que tiene que venir del inspect; si se usara el del listado, el historial saldría vacío.
- `test_sin_healthcheck_el_detalle_no_trae_historial`: `State.Health` ausente → `log == []`.
- `test_el_healthcheck_del_detalle_es_la_de_la_imagen`: `Config.Healthcheck.Test`.
- `test_filtro_de_salud_llega_por_la_api`: se comprueba el `params` enviado, no sólo el resultado.
- `test_el_listado_no_hace_inspect_por_contenedor`: la salud del listado no puede costar N+1.

### Frontend (`vitest`)
- `test_la_pildora_no_cambia_sin_healthcheck`: sin `health` o con `"none"`, el marcado es idéntico. Este es el test que protege el requisito de no hacer ruido.
- `test_running_unhealthy_muestra_las_dos_cosas`: el estado sigue visible y la salud va al lado.
- `test_starting_no_se_pinta_como_error`.
- `test_el_detalle_muestra_el_porque`: historial y comando.
- `test_el_filtro_con_problemas_cuadra_con_su_contador`.

---

## 6. Plan de Tareas (Tasks)

> Las siete fases quedaron completadas y verificadas contra el daemon real
> (29.8.1), con un contenedor sano, uno `unhealthy` y uno de salida enorme.

- [x] **Fase 1: Contratos**
  - [x] `HealthSummary`, `HealthProbe` y `HealthDetail` en `app/schemas/container.py`
  - [x] `health` en `ContainerSummary`; `ContainerDetail` **re-declara** el tipo
  - [x] `HealthStatus`, `HealthSummary`, `HealthProbe` y `HealthDetail` en `src/types/docker.ts` (los tipos de contenedor viven ahí, no en un archivo por recurso)
- [x] **Fase 2: Tests primero en backend (TDD)**
  - [x] Los casos de §5 en `tests/test_containers.py`, con el doble emitiendo las tres formas reales de §2.2
  - [x] Ejecutar `pytest` y confirmar que falla por implementación ausente (fase roja: 7 de 8 en rojo)
- [x] **Fase 3: Implementación backend**
  - [x] Proyectar `Health` del listado a `HealthSummary` en `list_containers`, sin inspect
  - [x] Reemplazar por `State.Health` en `get_container`, con `Log` y `Config.Healthcheck.Test`
  - [x] Recortar la salida de cada sonda con el límite de `MAX_SALIDA_SONDA`, sin truncar el historial
  - [x] Filtro `health` en `list_containers` y en `GET /containers` (lo resuelve el daemon; el filtro de la vista va en el navegador, §3.2)
- [x] **Fase 4: Verificación backend**
  - [x] `make backend-test` y `make backend-lint` en verde (411 tests)
- [x] **Fase 5: Tests primero en frontend**
  - [x] Los casos de §5 en `tests/components/`
  - [x] Ejecutar `vitest` y confirmar que los casos nuevos fallan (fase roja: 5 de 10 en `StatusBadge`, 3 de 4 en el detalle)
- [x] **Fase 6: Implementación frontend**
  - [x] `StatusBadge` acepta `health` opcional y **no renderiza nada extra** con `"none"`
  - [x] `ContainerHealthPanel` con estado, contador, comando e historial
  - [x] Marca de salud en `ContainersTable`, con tokens de tema y sin color literal
  - [x] Filtros "Con problemas" y "Con sonda sana" en `App.tsx`, con su contador
- [x] **Fase 7: Verificación y Quality Gates**
  - [x] `make backend-test` (411), `make backend-lint`, `pnpm run test` (492), `pnpm run lint`, `pnpm run build`
  - [x] Comprobado contra el daemon real con un contenedor sano, uno `unhealthy` y uno de salida enorme
  - [x] Actualizado `agent.md` y marcadas las tareas como completadas

### Desvíos y correcciones durante la ejecución

Tres cosas que el spec daba por buenas y **no lo eran**, corregidas aquí en lugar de dejadas:

1. **El filtro de salud va en el navegador, no en el daemon.** §3.2 estaba escrito al revés. Filtrar en el servidor haría que `rawContainers` dejara de ser el censo del host y los contadores de las píldoras bailarían con cada clic, que es exactamente lo que `agent.md` documenta como motivo del filtro por estado. El parámetro `?health=` sigue existiendo en la API porque es la superficie correcta para quien la llame directamente.
2. **La motivation del recorte de salida era falsa.** Se suponía que una sonda podía imprimir 4 MB. Medido: **el daemon recorta a 4096 bytes por su cuenta**. El recorte del panel se queda como defensa en profundidad, con el comentario del código diciendo la verdad.
3. **`ContainerDetail` tenía que re-declarar `health`, no heredarlo.** Pydantic recorta el valor al tipo del campo del padre, así que un `HealthDetail` se serializaba como `HealthSummary` y `log` y `test` desaparecían **sin dar ningún error**.
