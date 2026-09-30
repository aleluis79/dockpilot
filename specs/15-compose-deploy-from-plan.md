# SPEC-15: Desplegar un Compose File desde el Plan

## 1. Contexto y Objetivos
- **Problema**: `up` ya existe y es path-driven (`compose_cli.argumentos_accion` recibe un archivo, y el handler de SPEC-13 valida que la ruta exista y esté dentro de la raíz del explorador), pero **no hay forma de usarlo con un compose file que nunca ha corrido**. El botón `up` de la tabla toma su ruta de `config_files`, que es una etiqueta `com.docker.compose.project.config_files` que compose solo escribe *después* del primer `up`. SPEC-11 §1 ya nombró el hueco: *"Un YAML sin `up` ejecutado no ha creado nada y no deja labels: no hay nada que inventariar"*. SPEC-14 hizo esos archivos alcanzables con el explorador, así que hoy se puede **previsualizar** `sica`, `tickets-app` y `full-editor`, pero no arrancarlos: previsualizar y luego tener que abrir una terminal es exactamente el rodeo que la spec viene a quitar.
- **Objetivo**: Desplegar un compose file directamente desde su plan, reutilizando el panel de acción y los logs que ya usan las filas de la tabla, y sin crear un segundo camino de ejecución.
- **Alcance**:
  - Incluye:
    - Botón **Desplegar** en el plan, que abre el `ComposeActionPanel` existente con `accionInicial: 'up'`.
    - Un diálogo de confirmación **solo cuando el plan tiene servicios con `build:`**, que dice cuántos son y cuánto pesa el contexto.
    - El coste de build estimado en la respuesta del plan, con tope de recorrido.
    - Aviso de **colisión de nombre de proyecto** cuando otro proyecto del host ya usa ese nombre desde otro archivo.
    - Quitar `--remove-orphans` del camino de despliegue desde el plan, y hacer `project_name` obligatorio en el WebSocket.
    - Refresco del inventario al terminar, porque el proyecto recién arrancado ya deja etiquetas y aparece en la tabla.
  - No incluye (en esta spec):
    - **Escribir el archivo del editor.** SPEC-12 no escribe en disco y esta spec tampoco: si hay cambios sin guardar, el despliegue se bloquea. Se despliega el archivo, no lo que hay en pantalla.
    - **`build` como acción propia.** No hay botón "Construir". Compose construye dentro del `up` si la imagen no existe, que es su comportamiento normal.
    - **La sección "No desplegados" de la pestaña Proyectos.** Dar identidad propia a los compose del disco que no están en Docker es la solución coherente, pero necesita decidir persistencia y refresco. Esta spec deja el hueco acotado a un despliegue desde el plan.
    - **`up` sobre un proyecto que ya está en marcha.** Si el nombre ya existe, la fila de la tabla es el sitio natural y esta spec no lo duplica.
    - **`--remove-orphans` en general.** Se sigue usando en el camino del inventario, que es donde se quiere. Aquí es un peligro, y el motivo está en §3.3.

---

## 2. Contrato de Datos (Schemas & Types)

### 2.1 Cambios en `app/schemas/compose.py`

`PlannedService.build` pasa de `bool` a un objeto. El `bool` no servía: no distinguía "construye 2 KB" de "manda 400 MB al daemon".

```python
class PlannedBuild(BaseModel):
    """Lo que va a costar construir este servicio, sin construirlo.

    `bytes_aprox` es una **estimación**: no aplica `.dockerignore`, así que
    normalmente **sobreestima**, y por eso lleva `_aprox` en el nombre. Se
    prefiere sobreestimar a serene falsamente preciso: un número alto hace
    preguntar, uno bajo hace que el `up` tarde 8 minutos sin avisar.
    """
    context: str = Field(..., description="Ruta absoluta del contexto, resuelta contra el archivo")
    bytes_aprox: int = Field(0, description="Bytes del contexto sin aplicar .dockerignore")
    ficheros_aprox: int = Field(0, description="Ficheros contados en el recorrido")
    truncado: bool = Field(False, description="Se alcanzó el tope de ficheros al medir")
    error: str | None = Field(
        None, description="Por qué no se pudo medir: no existe, sin permisos, no es un directorio"
    )
```

```python
class ProjectCollision(BaseModel):
    """Otro proyecto del host ya ocupa este nombre de proyecto."""
    nombre: str
    config_files: list[str] = Field(default_factory=list)
    mismo_archivo: bool = Field(
        ..., description="True si es el mismo archivo, o sea un reinicio legítimo"
    )
```

Y en `ComposePlan`:

```python
    proyecto_en_uso: ProjectCollision | None = Field(
        None,
        description="Proyecto existente con este nombre, si lo hay. None o same-file: se puede desplegar",
    )
```

### 2.2 Cambios en el WebSocket (`ComposeRequest`)

```python
    project_name: str = Field(..., description="Obligatorio. Ver §3.4: deducirlo del directorio es incorrecto")
    remove_orphans: bool = Field(
        True,
        description="`up --remove-orphans`. False en el camino del plan; ver §3.3",
    )
```

### 2.3 Cambios en `frontend/src/types/compose.ts`

```typescript
export interface PlannedBuild {
  /** Estimación sin `.dockerignore`: normalmente sobreestima. */
  context: string;
  bytes_aprox: number;
  ficheros_aprox: number;
  truncado: boolean;
  error: string | null;
}

export interface ProjectCollision {
  nombre: string;
  config_files: string[];
  mismo_archivo: boolean;
}
```

`PlannedService.build` pasa a `PlannedBuild | null`, y `ComposePlan` gana `proyecto_en_uso: ProjectCollision | null`.

### 2.4 Nuevo ajuste

```python
COMPOSE_BUILD_ESTIMATE_MAX_FILES: int = 20000
```

Tope de ficheros al medir un contexto de build. Se mide en 0,2 s con 19 000 ficheros en el host de referencia, así que el tope está para el caso patológico —un contexto que sea un directorio del home— y no para el uso normal. Al alcanzarlo se marca `truncado` y el tamaño sale **parcial**, nunca inventado.

---

## 3. Mecánica

### 3.1 Por qué el botón no va dentro del cuerpo de solo lectura del plan

El modal de Plan tiene **editor sin guardar** y un botón "Validar con cambios". El panel nunca escribe en disco, por diseño de SPEC-12 §1. Poner "Iniciar" al lado del editor invita a desplegar algo que no es lo que está en pantalla, y no hay forma de distinguirlo mirando el botón.

La solución no es mover el botón lejos, es **separar el momento**: el cuerpo del plan sigue siendo de lectura, y el despliegue es un paso explícito con su propio diálogo. Cuando se pulsa, el plan **se sustituye** por el `ComposeActionPanel`, igual que al pulsar una fila. A partir de ahí la interfaz es la misma que en cualquier despliegue del panel, con su log en vivo y su botón de cancelar.

El botón se llama **Desplegar** y no **Iniciar** a propósito: "iniciar" sugiere algo instantáneo, y con `build:` puede no serlo.

### 3.2 Reutilización, y por qué no hay un segundo camino

`ComposeActionPanel` ya recibe `project`, `path` y `accionInicial`, y ya manda `project_name` explícito. El despliegue desde el plan es:

```tsx
<ComposeActionPanel
  project={plan.project_name}
  path={plan.source_path}
  accionInicial="up"
  removeOrphans={false}
  onClose={cerrar}
/>
```

Ni el WebSocket, ni el runner, ni el hook, ni los logs se tocan. Un despliegue desde el plan y uno desde una fila ejecutan **el mismo código**: si divergieran, el preview y la realidad dejarían de cuadrar, que es exactamente lo que SPEC-12 §3.1 juego para evitar.

Que el mismo código reciba la ruta tiene una consecuencia que conviene dejar escrita: el despliegue desde el plan **no es una puerta trasera al confinamiento**. `plan.source_path` pasa por la misma validación del canal de SPEC-13 que la ruta de una fila —absoluta, dentro de la raíz del explorador, existente—, y un `403` llega como frame de error igual que en cualquier otra acción. Como el plan sólo se pide para rutas ya confinadas (SPEC-12 §3.5), el `source_path` de un plan válido siempre cumple las tres, pero la comprobación no se salta por venir de un plan: es la misma línea de código, y esa es la garantía.

### 3.3 Por qué este camino no lleva `--remove-orphans`

`argumentos_accion` lo lleva hardcodeado desde SPEC-13, y allí tiene sentido: es lo que compose v2 hace por defecto al operar un proyecto que ya es tuyo.

Aquí es distinto. El nombre de proyecto lo decide compose, y en el host de referencia **no siempre coincide con el directorio**:

```text
sica/docker-compose.yml   ->  compose dice 'simp-sica'   |  directorio: 'sica'
```

Si un archivo declara `name:` y otro directorio tiene un proyecto con ese nombre, `--remove-orphans` **borra los contenedores de los servicios que no estén en el archivo nuevo**. Eso es destruir trabajo en marcha desde un botón cuyo rótulo es "Desplegar". Por eso el camino del plan lo apaga, y por eso el aviso de §3.5 no es opcional: sin el flag, seguirían peleándose dos proyectos por el mismo nombre.

### 3.4 `project_name` deja de ser opcional

Hoy el handler cae en `_proyecto_por_defecto`, que **deduce el nombre del directorio**, y eso es incorrecto por construcción: compose lee `name:` del archivo. Con `sica` la deducia da `sica` y compose usa `simp-sica`, así que la comprobación de `409` de SPEC-13 miraría el proyecto equivocado.

No ha pasado nada hasta ahora porque la UI siempre manda `project_name` desde el inventario. Este spec es el camino donde nadie lo manda, así que en vez de arreglar la deducción **se elimina**: las dos únicas fuentes que existen (el inventario y el plan) ya lo saben, porque el plan lo saca del propio `config` de compose. Un `400` explícito es mejor que un nombre adivinado.

### 3.5 Colisión de nombre

El plan consulta el inventario por el mismo `docker` que ya usa para marcar lo que existe, y compara el `project_name` resuelto:

- **Mismo nombre, mismo archivo** → `mismo_archivo: true`. Es un reinicio legítimo: el botón sigue disponible y no avisa.
- **Mismo nombre, otro archivo** → se muestra el aviso con los `config_files` del proyecto que lo ocupa. **El despliegue se bloquea.** Dos archivos compose peleándose por un nombre no se pueden fusionar: los nombres de red y de volumen llevan prefijo del proyecto, y `container_name` —que 3 de los 4 archivos del host declaran— es **global** en Docker, con independencia del proyecto. Bloquear es más honesto que arrancar y que el usuario descubra el conflicto en el `stderr` de compose.
- **Sin colisión** → `None`, y no se dice nada.

### 3.6 El diálogo del build

Solo aparece si algún servicio trae `build:`. Antes de abrir el panel de acción:

- Cuántos servicios se van a construir, nombrados.
- El peso del contexto **sumado una vez por contexto distinto**, porque `tickets-app` declara `build` en `api` y en `web` sobre el mismo `.` y no es dos veces el mismo contexto.
- El peso se formatea con `formatBytes` del panel, que usa unidades binarias: los 440 MB decimales del contexto de `tickets-app` se muestran como **420 MB**. Es la misma regla que el resto del panel, y dos unidades distintas en la misma pantalla harían que 420 y 440 parecieran el mismo número.
- Si algún contexto no se pudo medir, se dice cuál y por qué, en vez de omitirlo.
- Si el recorrido se truncó, se dice que la cifra es **parcial**.

Las dos salidas son "Construir y arrancar" y "Cancelar". No se ofrece "arrancar sin construir": `up --no-build` sobre una imagen que no existe falla, y convertir un botón de arranque en un botón que a veces falla es peor que hacerlo lento a propósito.

### 3.7 El editor sin guardar bloquea el despliegue

Si el editor tiene cambios, el botón **Desplegar** está deshabilitado y el motivo se escribe al lado: *"el despliegue usa el archivo del disco, y tienes cambios sin guardar"*. No se ofrece "guardar y desplear" porque el panel no escribe archivos, y ese es un cambio de alcance que pertenece a otra spec.

### 3.8 Después de arrancar

Al terminar el `up` con código 0, el proyecto ya tiene etiquetas y **aparece en la tabla**. El plan refresca el inventario al cerrarse, para que la fila exista sin recargar a mano. Si el `up` falla a mitad —típico cuando el segundo build falla—, el proyecto **igual aparece**, con contenedores, redes y volúmenes a medias. El inventario lo mostrará como lo que es, y `down` es la limpieza. La ayuda lo dice, porque es la parte que más sorprende.

---

## 4. Criterios de Aceptación (Gherkin en Español)

```gherkin
# language: es
Característica: Desplegar un compose file desde el plan
  Como usuario de DockPilot
  Quiero arrancar un compose file que todavía no está en marcha
  Para no tener que abrir una terminal y acordarme de la ruta

  Antecedentes:
    Dado que el servidor backend de DockPilot está en ejecución

  Escenario: Desplegar un archivo que no está en el inventario
    Dado que un compose file válido que nunca ha corrido tiene un plan
    Cuando el usuario pulsa "Desplegar"
    Entonces se ejecuta "docker compose up -d" contra ese archivo
    Y se le manda el nombre de proyecto que ha resuelto compose
    Y el plan se sustituye por el panel de acción con su log en vivo

  Escenario: Un proyecto del inventario se despliega igual
    Dado que un compose file que ya está en el inventario tiene un plan
    Cuando el usuario pulsa "Desplegar"
    Entonces se ejecuta "docker compose up -d" contra ese archivo
    Y el resultado es el mismo que si se hubiera pulsado la fila de la tabla

  Escenario: No se ejecutan acciones al previsualizar
    Dado que un compose file tiene un plan
    Cuando el usuario solo previsualiza
    Entonces no se ha ejecutado ninguna acción de ciclo de vida

  Escenario: El coste del build se avisa antes de construir
    Dado que el plan tiene servicios que declaran "build"
    Cuando el usuario pulsa "Desplegar"
    Entonces se pregunta antes con cuántos servicios se van a construir
    Y se dice el peso del contexto de build
    Y todavía no se ha ejecutado nada

  Escenario: El contexto compartido se cuenta una vez
    Dado que dos servicios declaran "build" sobre el mismo contexto
    Cuando el usuario pide desplegar
    Entonces el peso indicado es el de un solo contexto

  Escenario: Sin build no se pregunta nada
    Dado que ningún servicio del plan declara "build"
    Cuando el usuario pulsa "Desplegar"
    Entonces se abre el panel de acción sin ningún diálogo intermedio

  Escenario: Los cambios sin guardar bloquean el despliegue
    Dado que el editor tiene cambios sin guardar
    Entonces el botón "Desplegar" está deshabilitado
    Y el motivo dice que el despliegue usa el archivo del disco

  Escenario: Este despliegue no borra contenedores huérfanos
    Dado que un compose file se despliega desde el plan
    Entonces la orden no incluye "--remove-orphans"

  Escenario: El despliegue desde una fila sí los borra
    Dado que un proyecto del inventario recibe la acción "up" desde su fila
    Entonces la orden incluye "--remove-orphans"

  Escenario: El nombre de proyecto es obligatorio
    Dado que una acción se lanza sin nombre de proyecto
    Entonces el sistema responde con código 400
    Y no se ejecuta ninguna orden

  Escenario: El nombre de proyecto no se deduce del directorio
    Dado que un compose file declara un nombre de proyecto distinto del directorio
    Y el plan lo ha resuelto
    Cuando el usuario despliega desde el plan
    Entonces la orden lleva el nombre que resolvió compose
    Y no el nombre del directorio

  Escenario: Nombre ocupado por otro archivo bloquea el despliegue
    Dado que ya existe un proyecto con el nombre del plan y usa otro archivo
    Entonces el despliegue está bloqueado
    Y se dice qué proyecto ocupa el nombre y con qué archivo

  Escenario: Nombre ocupado por el mismo archivo no bloquea nada
    Dado que ya existe un proyecto con el nombre del plan y usa ese mismo archivo
    Entonces el despliegue está disponible
    Y no se avisa de ninguna colisión

  Escenario: Un contexto de build ilegible se dice, no se oculta
    Dado que un servicio declara un contexto que no existe
    Cuando el usuario pide desplegar
    Entonces se avisa de que no se pudo medir ese contexto
    Y el peso indicado no incluye ese contexto como si fuera cero

  Escenario: El inventario se refresca al terminar
    Dado que un despliegue desde el plan ha terminado con éxito
    Y el proyecto todavía no aparecía en la tabla
    Cuando el usuario cierra el panel de acción
    Entonces el proyecto aparece en la tabla sin recargar la página

  Escenario: El CLI ausente se avisa sin desplegar
    Dado que no hay CLI de Docker Compose instalado
    Cuando el usuario intenta desplegar desde el plan
    Entonces se avisa de que falta el CLI
    Y no se ha ejecutado ninguna orden
```

---

## 5. Plan de Pruebas Automatizadas

### Backend (`pytest`)
- `tests/test_compose_build_estimate.py`:
  - `test_mide_el_contexto_resuelto_contra_el_archivo`: el `context` relativo se resuelve contra el directorio del compose file, que es lo que hace compose.
  - `test_estima_peso_y_numero_de_ficheros`.
  - `test_no_aplica_dockerignore_y_lo_dice`: se monta un contexto con un `.dockerignore` que excluye casi todo y se comprueba que la estimación **no** lo tiene en cuenta, porque es una sobreestimación declarada.
  - `test_contexto_inexistente_devuelve_error_en_vez_de_cero`: `error` informado, `bytes_aprox` 0 y `truncado` False, para que un 0 no se lea como "no pesa".
  - `test_contexto_que_es_un_fichero`: se trata como error, no se cuenta.
  - `test_trunca_al_tope_de_ficheros`: `truncado=True` y el tamaño es parcial.
  - `test_no_sigue_enlaces_simetricos`: un symlink dentro del contexto no se recorre (evita bucles y medir dos veces).
  - `test_permiso_denegado_no_rompe_la_estimacion`: se salta la entrada y sigue.
- `tests/test_compose_up_from_plan.py`:
  - `test_el_plan_expone_el_coste_de_build_por_servicio`.
  - `test_detecta_nombre_ocupado_por_otro_archivo`.
  - `test_no_detecta_colision_con_el_mismo_archivo`.
  - `test_no_detecta_colision_si_el_nombre_esta_libre`.
- `tests/test_compose_ws.py` (ampliar):
  - `test_up_desde_el_plan_no_lleva_remove_orphans` y `test_up_desde_la_fila_si`: los argumentos exactos, comparados.
  - `test_sin_project_name_devuelve_400`, y que **no** se haya lanzado ningún proceso.
  - `test_ya_no_se_deduce_el_nombre_del_directorio`: el mensaje de `down --volumes` nombra el proyecto recibido.

### Frontend (`vitest`)
- `tests/components/compose/ComposeDeployDialog.test.tsx`:
  - No aparece sin `build`.
  - Nombra los servicios con `build` y el peso.
  - Cuenta un contexto compartido una vez.
  - Avisa de los contextos no medidos y del truncado.
  - "Cancelar" no llama a nada.
- `tests/components/compose/ComposePlanModal.test.tsx` (ampliar):
  - "Desplegar" abre el panel de acción con el nombre y la ruta del plan.
  - Se deshabilita con cambios sin guardar, con el motivo visible.
  - Con `build`, pasa por el diálogo antes de abrir el panel.
  - Sin `build`, va directo.
  - Colisión con otro archivo: no hay botón de desplegar y se ve el aviso.
  - `removeOrphans={false}` es lo que se manda.

---

## 6. Plan de Tareas (Tasks)

> Las seis fases quedaron completadas y verificadas contra el daemon real.

- [x] **Fase 1: Contratos**
  - [x] `PlannedBuild` y `ProjectCollision` en `app/schemas/compose.py`; `PlannedService.build` pasa a `PlannedBuild | None`; `ComposePlan.proyecto_en_uso`
  - [x] `project_name` obligatorio y `remove_orphans` en `ComposeRequest`
  - [x] `COMPOSE_BUILD_ESTIMATE_MAX_FILES` en `app/core/config.py`
  - [x] Tipos en `frontend/src/types/compose.ts` y `remove_orphans` en la petición del WebSocket
- [x] **Fase 2: Tests Primero en Backend (TDD)**
  - [x] `backend/tests/test_compose_build_estimate.py`
  - [x] `backend/tests/test_compose_up_from_plan.py`
  - [x] Ampliar `backend/tests/test_compose_ws.py` con `remove_orphans` y `project_name` obligatorio
  - [x] Ejecutar `pytest` y confirmar que falla por implementación ausente (fase roja)
- [x] **Fase 3: Implementación Backend**
  - [x] `_estimar_build()` en `compose_service.py`: contexto resuelto contra el archivo, recorrido sin symlinks, con tope, y `error` en vez de 0 mudo
  - [x] `_colision()` reusando `_collect()`: mismo nombre y `config_files` distintos
  - [x] Enganchar ambas cosas en `build_plan` y en `_a_servicio`
  - [x] `remove_orphans` en `compose_cli.argumentos_accion`, con `True` por defecto para no tocar SPEC-13
  - [x] Borrar `_proyecto_por_defecto` y hacer `project_name` obligatorio en `ws.py`
  - [x] Ejecutar `pytest` y validar aprobación al 100%
- [x] **Fase 4: Tests Primero en Frontend**
  - [x] `frontend/tests/components/compose/ComposeDeployDialog.test.tsx`
  - [x] Ampliar `frontend/tests/components/compose/ComposePlanModal.test.tsx`
  - [x] Ejecutar `vitest` y confirmar que los casos nuevos fallan por implementación ausente (fase roja)
- [x] **Fase 5: Implementación Frontend**
  - [x] `remove_orphans` en `useComposeCommand` y en `ComposeActionPanel`
  - [x] `ComposeDeployDialog.tsx` con el coste del build, contextos no medidos y truncado
  - [x] Botón **Desplegar** y resumen previo en `ComposePlanModal`, con bloqueo por cambios sin guardar
  - [x] Bloqueo y aviso de colisión por nombre
  - [x] Refresco del inventario al cerrar el panel de acción
  - [x] Ejecutar `vitest` y validar aprobación al 100%
- [x] **Fase 6: Verificación, Quality Gates y Documentación**
  - [x] Gates backend (`make backend-test`, `make backend-lint`) y frontend (`tsc`, `lint`, `test`, `build`)
  - [x] Probar en el navegador con `tickets-app`, que tiene `build` en dos servicios sobre un contexto compartido
  - [x] Comprobar que un proyecto recién desplegado aparece en la tabla sin recargar
  - [x] Actualizar la ayuda in-app (qué es Desplegar, el aviso de build, la colisión de nombre, la limpieza tras un fallo a medias) y `agent.md`
  - [x] Marcar las tareas como completadas (`[x]`)
