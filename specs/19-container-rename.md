# SPEC-19: Renombrar un contenedor

## 1. Contexto y Objetivos
- **Problema**: Un contenedor se llama como se llamó cuando se creó, y a veces ese nombre ya no describe lo que hace. `mi-nginx` que hoy sirve una API, el `web` de un compose que se renombró a mano en el terminal, el contenedor de una prueba que se quedó con el nombre del script que lo levantó. El panel muestra el nombre pero **no deja cambiarlo**, así que la única salida es abrir una terminal. Y el nombre no es cosmético: en una red personalizada es el **nombre DNS** del contenedor, así que un nombre malo se propaga a todo lo que lo resuelve.
- **Objetivo**: Poder renombrar un contenedor desde su detalle, con una validación que no deje pasar nombres que el panel luego no puede representar, y avisando cuando el rename rompe algo que el usuario no ve.
- **Alcance**:
  - Incluye:
    - Acción de renombrado en el detalle del contenedor, con el nombre actual y el nuevo a la vista.
    - Validación **antes** de enviar: patrón, longitud y **unicidad contra todo el daemon**, no sólo dentro del proyecto.
    - `409` (nombre ya en uso) traducido a un mensaje que diga qué contenedor lo ocupa.
    - Aviso cuando el contenedor está en una red personalizada, porque el rename rompe a quien resuelve el nombre viejo.
    - El nombre disponible para el autocompletado, porque el panel ya tiene los contenedores listados.
  - No incluye (en esta spec):
    - **Renombrar por lote** ni renombrar un proyecto compose entero. Son flujos distintos: uno opera sobre contenedores, el otro sobre un archivo YAML que el panel ni siquiera abre (SPEC-12).
    - **Renombrar volúmenes, redes o imágenes.** Los volúmenes tienen su propia restricción (los montados no se pueden renombrar) y las redes tienen un límite de 63 caracteres que los contenedores no tienen. Es un spec por recurso.
    - **Editar el `docker-compose.yml` para renombrar.** El nombre de un contenedor de compose lo pone el archivo; renombrar el contenedor es una desviación que composeTolera pero no es la fuente de verdad. Arreglar el archivo es cosa del editor de compose, que no existe.
    - **Revertir un renombrado.** No hay historial de nombres que revertir: `Name` es un valor actual, no una lista. Guardar el anterior en el panel sería estado sin destino, porque un "deshacer" tras recargar no tiene sentido.

---

## 2. Contrato de Datos (Schemas & Types)

### 2.1 Backend (Pydantic v2) — `app/schemas/container.py`

```python
class RenameContainerRequest(BaseModel):
    name: str = Field(..., description="Nombre nuevo del contenedor")


class RenameContainerResponse(BaseModel):
    id: str
    old_name: str
    new_name: str
    message: str
```

La respuesta devuelve `old_name` porque el panel necesita **sustituir el nombre en todas partes** donde aparece tras la acción, y sin el anterior no puede hacerlo de forma fiable.

### 2.2 Frontend (TypeScript) — `src/types/docker.ts`

```typescript
export interface RenameContainerRequest {
  name: string;
}

export interface RenameContainerResponse {
  id: string;
  old_name: string;
  new_name: string;
  message: string;
}
```

### 2.3 Las reglas, medidas

Todo lo de esta tabla se obtuvo probando contra el daemon 29.8.1, no de la documentación:

| Regla | Valor | Error del daemon |
| :--- | :--- | :--- |
| Patrón | `^[a-zA-Z0-9][a-zA-Z0-9_.-]+$` | `400` |
| Longitud mínima | **2 caracteres** | `400` |
| Unicidad | **Todo el daemon**, no por proyecto | `409` |
| Vacío | — | `400` |
| Igual al actual | — | `400` |
| Longitud máxima | **El daemon no impone ninguna** | acepta 300 |

Tres consecuencias que no son obvias y que justifican validar en el panel:

1. **El mínimo es 2, no 1.** El validador de redes que ya tiene el proyecto (`network_service.NAME_PATTERN`) usa `*` y por tanto **acepta un solo carácter**; Docker los rechaza. No se puede reutilizar tal cual: comparte el patrón pero no la aridad.
2. **La unicidad es global.** No se puede llamar `web` si cualquier otro contenedor del host, de cualquier proyecto, ya se llama así. Comprobado: `docker rename x mi-nginx` → `409` diciendo qué contenedor lo ocupa.
3. **No hay límite de longitud.** Las redes sí capan a 63 (`MAX_NAME_LENGTH`); los contenedores no: el daemon aceptó 300 caracteres. Pero un nombre no puede ser una etiqueta DNS válida si supera 63, así que un nombre así **rompe la resolución** en cuanto el contenedor se toca una red personalizada. El panel pone su propio tope, y lo explica.

El tope que se propone es **63**, el mismo que usan las redes y el de una etiqueta DNS. No es arbitrario: es el punto en el que el nombre deja de poder ser un nombre de host.

### 2.4 Qué NO cambia

Comprobado, y es lo que hace la función barata:

- **El ID no cambia.** El panel identifica contenedores por id en todas las rutas (`/containers/{id}/logs`, `/stats`, `/terminal`), así que ninguna WebSocket abierta se rompe y ningún enlace queda colgado.
- **El estado no cambia.** Un contenedor parado sigue parado tras el rename.
- **Los volúmenes no se tocan.** No hay recreate, así que no hay ni volúmenes anónimos que perder ni datos en riesgo.

---

## 3. Mecánica

### 3.1 Dónde vive la entrada

**En el detalle del contenedor**, no en la tabla. La tabla es de sólo lectura para nombres: un renombrado desde la fila es un clic de más que se puede pulsar por error, y el nombre no es un dato que se vaya a cambiar de un vistazo. El detalle es donde ya viven `delete`, y es donde el nombre aparece con contexto.

El botón queda junto a los datos generales del detalle, con el nombre actual a la vista.

### 3.2 La validación es triple, y en ese orden

1. **Patrón y longitud**, contra el regex del punto 2.3 y el tope de 63. Instantáneo, en el cliente, para no hacer un viaje por algo que ya sabemos.
2. **No vacío y distinto del actual.** El daemon devuelve `400` para los dos, pero se puede comprobar en el cliente con un mensaje mejor y sin latencia.
3. **Unicidad**, contra la lista de contenedores que el panel **ya tiene cargada**. No hace falta una llamada al daemon para saber que `web` ya existe: el inventario lo sabe. Esto es lo que hace que la acción se sienta instantánea, y sólo el `409` del daemon es la comprobación definitiva —porque entre la carga del inventario y el clic puede haber otro actor—.

El paso 3 es una **optimización, no una garantía**: el `409` del daemon sigue siendo la verdad y hay que tratarlo.

### 3.3 El aviso de DNS: cuándo y por qué

En una red personalizada el nombre **es** el nombre DNS. Comprobado:

```text
ANTES:    172.19.0.2  dockpilot-rename
DESPUÉS:  172.19.0.2  nombre-nuevo
          dockpilot-rename  → NO RESUELVE
```

Así que el rename rompe a quien resolvía el nombre viejo —otro contenedor, un proxy, un healthcheck con `--link`— de forma **inmediata y silenciosa**.

En la red `bridge` por defecto **no hay DNS entre contenedores**, así que el aviso no aplica y se omitiría.

Cómo se distingue, sin llamadas extra: `HostConfig.NetworkMode` es `bridge` en la red por defecto y el **nombre de la red** en las propias. Ya viene en el `inspect` que el detalle pide; sólo falta exponerlo.

- Si `NetworkMode` es `bridge` o `default` → nada que avisar.
- Si es cualquier otra cosa → el diálogo dice que el nombre viejo dejará de resolver, y por qué.

### 3.4 Compose no se bloquea

**Comprobado, y es contraintuitivo.** Compose identifica sus contenedores por **etiquetas**, no por nombre. Montado un proyecto de prueba y renombrado el contenedor:

```text
docker compose ps   -> web-renombrado          (lo sigue viendo)
docker compose up -d -> Container web-renombrado Running   (idempotente)
docker compose down  -> lo para, lo borra y limpia la red
```

Y también con `container_name:` explícito en el YAML: compose lo encuentra igual.

Por tanto **no hay que bloquear nada por compose**, que era la restricción que se iba a proponer antes de comprobarlo. Lo único que hay que hacer es **no propagar el nombre nuevo a la etiqueta del proyecto**, porque `com.docker.compose.*` describe el archivo y no lo que el panel acaba de hacer.

### 3.5 Un `409` legible

El daemon devuelve esto:

```text
Conflict. The container name "/mi-nginx" is already in use by container
"a4d168477d28...". You have to remove (or rename) that container to be able
to reuse that name.
```

Traducirlo a "Ya existe un contenedor llamado `mi-nginx`" es mucho mejor que soltar el texto del daemon, que incluye ids que el usuario no ve nunca. El `detail` del `409` lleva un mensaje propio y el nombre en conflicto va en un campo, para que la UI pueda emphasizedolo.

---

## 4. Criterios de Aceptación (Gherkin en Español)

```gherkin
# language: es
Característica: Renombrar un contenedor
  Como operador que ha mandado el nombre de un contenedor
  quiero corregirlo sin abrir una terminal
  para que el panel deje de mentir sobre lo que hay en el host

  Antecedentes:
    Dado que el daemon de Docker está accesible

  Escenario: Renombrar un contenedor en marcha
    Dado un contenedor en marcha llamado "mi-web"
    Cuando el usuario lo renombra a "api-gateway" desde su detalle
    Entonces la respuesta lleva el nombre anterior y el nuevo
    Y el panel muestra el nombre nuevo
    Y el contenedor conserva su identificador
    Y el contenedor sigue en marcha

  Escenario: Renombrar un contenedor parado
    Dado un contenedor parado llamado "viejo"
    Cuando el usuario lo renombra a "parado-renombrado"
    Entonces el contenedor sigue parado
    Y el nombre del panel es "parado-renombrado"

  Escenario: El botón vive en el detalle, no en la tabla
    Dado la tabla de contenedores
    Cuando el usuario mira una fila
    Entonces no encuentra ninguna acción de renombrado

  Escenario: Nombre con un carácter solo
    Dado un contenedor en marcha
    Cuando el usuario intenta renombrarlo a "x"
    Entonces el panel dice que el nombre necesita al menos dos caracteres
    Y no se llama al daemon

  Escenario: Nombre con caracteres no válidos
    Dado un contenedor en marcha
    Cuando el usuario intenta renombrarlo a "mi web"
    Entonces el panel explica qué caracteres no valen
    Y no se llama al daemon

  Escenario: Nombre demasiado largo
    Dado un contenedor en marcha
    Cuando el usuario intenta renombrarlo a un nombre de 64 caracteres
    Entonces el panel dice que el máximo es 63
    Y explica que un nombre más largo no puede ser un nombre de host

  Escenario: Nombre ya en uso dentro de la lista conocida
    Dado que el inventario ya tiene un contenedor llamado "db"
    Cuando el usuario intenta renombrar otro contenedor a "db"
    Entonces el panel avisa antes de llamar al daemon
    Y el botón queda deshabilitado

  Escenario: El conflicto real lo decide el daemon
    Dado que otro actor crea un contenedor llamado "api-gateway" entre medias
    Cuando el usuario renombra su contenedor a "api-gateway"
    Entonces el panel recibe un conflicto
    Y el mensaje dice qué nombre está ocupado
    Y no muestra el texto interno del daemon con identificadores

  Escenario: Renombrar en una red personalizada avisa de que el nombre viejo deja de resolver
    Dado un contenedor conectado a una red propia
    Cuando el usuario lo renombra
    Entonces el diálogo avisa de que el nombre anterior dejará de resolver
    Y explica que en una red personalizada el nombre es el nombre de red

  Escenario: Renombrar en la red por defecto no avisa de nada
    Dado un contenedor en la red bridge
    Cuando el usuario lo renombra
    Entonces el diálogo no menciona la resolución de nombres
    Porque en la red por defecto no hay nombres entre contenedores

  Escenario: Un contenedor de compose se puede renombrar
    Dado un contenedor con etiquetas de proyecto compose
    Cuando el usuario lo renombra
    Entonces la acción se completa
    Y la etiqueta del proyecto no se modifica
    Y el panel lo sigue mostrando como parte de su proyecto

  Escenario: Renombrar a un nombre que no cambia nada
    Dado un contenedor llamado "igual"
    Cuando el usuario confirma el mismo nombre
    Entonces el panel dice que el nombre no ha cambiado
    Y no se llama al daemon

  Escenario: El fallo del daemon no deja el panel desincronizado
    Dado que el daemon rechaza el renombrado por un motivo inesperado
    Cuando el usuario renombra
    Entonces el panel muestra el error
    Y el nombre que sigue mostrando es el anterior
```

---

## 5. Plan de Pruebas Automatizadas

### Backend (`pytest`)
- `test_renombrar_devuelve_el_nombre_anterior_y_el_nuevo`: el contrato, que es lo que permite al panel sustituir el nombre.
- `test_renombrar_no_cambia_el_id`: el invariante que hace la función barata.
- `test_renombrar_un_contenedor_parado_lo_deja_parado`.
- `test_nombre_con_un_solo_caracter_da_400`: el mínimo de 2, que el validador de redes **no** aplica.
- `test_nombre_con_barra_o_espacio_da_400`.
- `test_nombre_demasiado_largo_da_400`: 64 caracteres, el tope de 63.
- `test_nombre_vacio_da_400`.
- `test_nombre_igual_al_actual_da_400`.
- `test_conflicto_da_409_con_mensaje_propio`: y **sin** el texto del daemon ni sus ids.
- `test_renombrar_un_contenedor_de_compose_no_toca_sus_etiquetas`.

### Frontend (`vitest`)
- `test_el_boton_de_renombrar_esta_en_el_detalle_y_no_en_la_tabola`.
- `test_el_nombre_no_valido_no_llama_al_backend`.
- `test_el_nombre_ya_en_el_inventario_avisa_sin_ir_al_daemon`.
- `test_el_detalle_muestra_el_aviso_de_dns_en_red_propia_y_no_en_bridge`.
- `test_el_409_muestra_el_mensaje_propio`.
- `test_tras_renombrar_el_detalle_muestra_el_nombre_nuevo`.

---

## 6. Plan de Tareas (Tasks)

> Las siete fases quedaron completadas y verificadas contra el daemon real
> (29.8.1), con contenedores en marcha y parados, y en `bridge` y en red propia.

- [x] **Fase 1: Contratos**
  - [x] `RenameContainerRequest` y `RenameContainerResponse` en `app/schemas/container.py`
  - [x] Sus equivalentes en `src/types/docker.ts`
- [x] **Fase 2: Tests primero en backend (TDD)**
  - [x] Los casos de §5 en `tests/test_containers.py`
  - [x] Fase roja confirmada: 14 en rojo
- [x] **Fase 3: Implementación backend**
  - [x] `_validar_nombre_contenedor()` propio: el de redes usa `*` y acepta un carácter, Docker exige dos. **No reutilizarlo.**
  - [x] `rename_container()` en el servicio, con el `409` traducido y `docker_error_status()`
  - [x] `POST /containers/{id}/rename` en la API
  - [x] El nombre se lee del `inspect`, no del objeto: `containers.get(id)` deja `_container` con sólo el id
- [x] **Fase 4: Verificación backend** — 429 tests, `make backend-lint` en verde
- [x] **Fase 5: Tests primero en frontend** — fase roja confirmada: 7 en rojo
- [x] **Fase 6: Implementación frontend**
  - [x] `utils/containerName.ts`: reglas y `redPropia()`, la copia cliente de las reglas
  - [x] `renameContainer()` en `dockerApi.ts`
  - [x] `RenameContainerModal` con validación en el cliente y el aviso de DNS condicionado a red propia
  - [x] Botón en el detalle; la tabla queda de sólo lectura para nombres
  - [x] `renameLocal()` en `useContainers`: actualiza el inventario en memoria, sin refetch
- [x] **Fase 7: Verificación y Quality Gates**
  - [x] `make backend-test` (429), `make backend-lint`, `pnpm run test` (508), `pnpm run lint`, `pnpm run build`
  - [x] Comprobado contra el daemon real: en marcha, parado, en red propia y en `bridge`
  - [x] Actualizado `agent.md`

### Desvíos durante la ejecución

**El campo `network_mode` se añadió y se quitó.** El spec lo daba por bueno para
distinguir la red propia de la `bridge` y así poder avisar del DNS. Contra el
daemon, resultó que **miente justo en el caso que debía detectar**:

```text
$ docker inspect --format 'NetworkMode={{.HostConfig.NetworkMode}} ...' <contenedor>
NetworkMode=bridge
NetworkSettings.Networks=bridge dockpilot-sp19-red
```

`NetworkMode` es sólo la red **principal**. Un contenedor en `bridge` conectado
además a una red propia sigue diciendo `bridge`, y en ese caso el nombre **sí** es
un nombre DNS. Por eso no hay campo: el conjunto de redes ya está en
`ContainerDetail.networks`, y de ahí lo deduce `redPropia()` en el cliente.

**Un bug real en el frontend, encontrado por un test.** La cabecera del detalle
mostraba `container.name`, que es un prop y no cambia al renombrar: tras renombrar
seguía enseñando el nombre viejo hasta que el padre refrescara. Ahora hay estado
local `nombre`, que es lo que permite el rename sin refetch.

**Los mensajes de validación nombran el carácter culpable.** La primera versión
decía "solo se permiten letras, dígitos, punto, guion y guion bajo" para todo lo
inválido, y el usuario tenía que buscar cuál de ellos era el suyo. Ahora nombra
el problema: "no puede contener espacios", "no puede contener barras".
