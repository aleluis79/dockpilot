# SPEC-20: Explorar y copiar ficheros de un contenedor

## 1. Contexto y Objetivos
- **Problema**: El panel da una terminal dentro del contenedor (SPEC-05), pero para sacar un log o meter una configuración hace falta acordarse de `docker cp` y de la sintaxis de rutas con dos puntos. La molestia es real y cotidiana: "bájame este log", "ponle este cert a este contenedor". Hoy la única forma es abrir una terminal al lado.
- **Objetivo**: Poder **listar** los ficheros de un contenedor y **copiarlos en las dos direcciones** —del host al contenedor y del contenedor al host— desde el panel, **sin que el backend escriba nunca en el disco del usuario**.
- **Alcance**:
  - Incluye:
    - Listado de un directorio del contenedor, con nombre, tipo y tamaño.
    - **Contenedor → local**, como descarga del navegador. El backend devuelve el fichero y el navegador lo guarda donde quiera el usuario.
    - **Local → contenedor**, con el selector nativo del navegador: el fichero viaja por su *contenido*, nunca por su ruta.
    - Aviso con confirmación cuando el contenedor está en marcha, porque escribir encima de lo que hay es la parte que más duele de la operación.
    - Tope de tamaño en las dos direcciones, con el motivo explicado en vez de un error genérico.
  - No incluye (en esta spec):
    - **Copiar a una ruta del host elegida por el usuario.** Es la única variante que hace que el backend escriba en el disco, y el principio del panel —"no escribe en el disco del usuario", repetido en SPEC-12, SPEC-13 y SPEC-15— lo prohíbe. Si algún día se quiere, es otro spec y tiene que reutilizar el confinamiento de SPEC-14 §3.2.
    - **Editar un fichero dentro del contenedor.** Descargar, editar en el panel y volver a subir son tres operaciones; esta spec hace las dos últimas pero no las encadena en un editor.
    - **Copiar entre dos contenedores.** Se puede componer (bajar y subir) y no merece un endpoint propio.
    - **Navegar por los montajes del host en general.** Lo que se ve es lo que el contenedor ve; si tiene un `-v /etc:/algo`, se verá `/etc`. No es un fallo, es la frontera (§3.2).
    - **Arrastrar y soltar.** Requiere que el `drop` lea ficheros del disco del usuario, que es justo lo que se quiere evitar.
    - **Symlinks.** Al leer, Docker devuelve el enlace y no su destino; no se siguen, y copiar uno no copia lo que apunta (§3.5).

---

## 2. Contrato de Datos (Schemas & Types)

### 2.1 Backend (Pydantic v2) — `app/schemas/filesystem.py` (nuevo)

```python
class FileKind(str, Enum):
    FILE = "file"
    DIR = "dir"
    SYMLINK = "symlink"
    OTHER = "other"   # socket, fifo, device: no se navega ni se copia


class ContainerEntry(BaseModel):
    name: str
    kind: FileKind
    size: int = 0
    symlink_target: str | None = None


class ListDirectoryResult(BaseModel):
    container_id: str
    path: str
    parent: str | None = Field(
        None, description="Directorio padre, o None si ya se está en la raíz"
    )
    entries: list[ContainerEntry] = Field(default_factory=list)
    truncated: bool = False
```

### 2.2 Lo que se midió, y por qué el listado no usa el archive

`GET /containers/{id}/archive` sobre un **directorio** devuelve el árbol entero recursivo, **con el contenido de los ficheros**. Navegar así no es un listado, es una descarga por cada directorio que se abre:

| Ruta | Tamaño descargado | Miembros | Tiempo |
| :--- | ---: | ---: | ---: |
| `/etc` | 601 KiB | 424 | 0.16 s |
| `/usr/share/nginx` | 4.5 KiB | 4 | 0.00 s |
| `/usr/lib` | **51 MB** | 177 | **2.36 s** |

Abrir `/usr/lib` para ver 177 nombres costaría 51 MB. Por eso **el listado va por `exec`** y el archive se usa sólo para transferir.

### 2.3 El formato de `ls`, y su límite

`ls` no tiene formato de salida estable entre imágenes: el de alpine es busybox y no coincide con el de GNU. El que sí es fiable en ambos es **`ls -1A`**: un nombre por línea, con los ocultos incluidos (`-A`) y sin `.` ni `..`.

Comprobado que `ls -1A` **respeta los espacios del nombre**, incluidos los dobles:

```text
$ ls -1A /datos
con espacios
doble  espacio.txt
sub
uno.txt
.oculto          ← con -A; con -1 a secas desaparece
```

Para tipo y tamaño hace falta `ls -laA`, y ahí hay una trampa. Este spec daba por hecho que un nombre con dos espacios (`doble  espacio.txt`) se partiría en dos entradas y que habría que renunciar a su tamaño. **Es falso, y al implementarlo se vio por qué**: la línea entera no se parte por columnas; se separa la FECHA con `split(None, 3)` —tres campos, cueste lo que cueste el relleno del día— y la cola es el nombre con sus espacios intactos. Comprobado contra el daemon con un fichero llamado `dos  espacios.txt`: sale entero y con su tamaño correcto.

La trampa que sí es real es otra: `ls` rellena el día a dos caracteres (`Jan  1  1970`), así que partir por espacios dobles **parte la fecha** y desplaza el nombre una columna. Y el riesgo residual —una entrada de `ls -1A` sin línea correspondiente en `ls -laA`— se resuelve con `size=0`, que la UI pinta como «—» y nunca como «0 B», porque un tamaño inventado es peor que uno ausente.

No se busca ninguna escapatoria a `find -printf`: es de GNU y no existe en busybox, que es justamente lo que hay que soportar.

### 2.4 Tamaño

El daemon **no impone tope** en ninguno de los dos sentidos: se escribieron ficheros de 5, 50 y 120 MB sin resistencia. El límite lo pone el panel, y por los dos lados:

| Sentido | Tope | Motivo |
| :--- | ---: | --- |
| Host → contenedor | 16 MiB | Viaja por WebSocket y por memoria del navegador |
| Contenedor → host | 64 MiB | Es una descarga; el navegador va justo con más |

Los topes son del panel y se pueden cambiar en `config.py`. No son un límite de Docker, así que hay que decidirlos aquí y decirlos en la UI cuando se alcanzan.

---

## 3. Mecánica

### 3.1 La frontera real: el namespace del contenedor

Lo medido en las dos direcciones, y define hasta dónde llega esta spec:

| Operación | ¿Sale del contenedor? |
| :--- | :--- |
| `PUT` a `/datos` con `-v /tmp/x:/datos` | **Sí** — apareció en el host, como root |
| `GET` de `/datos/dato.txt` con el mismo bind mount | **Sí** — devolvió el fichero del host |
| `GET` de `/datos/../../etc/hostname` | **No** — devolvió el del contenedor |
| `GET` de `/datos/raiz/etc/passwd` con `raiz -> /` | **No** — devolvió el `/etc/passwd` del contenedor |

Traducción: **los `..` y los symlinks se resuelven dentro del namespace del contenedor**, y no hay traversal. La frontera es exactamente el filesystem del contenedor **incluidos sus montajes**, que es el mismo límite que tiene `docker exec`.

Esto importa porque **el panel ya da un shell completo dentro del contenedor** (SPEC-05). Ese shell puede leer y escribir lo mismo hoy. Así que esta spec **no añade privilegio**: cambia la ergonomía de "escribo un comando" a "navego ficheros", y eso sí es una diferencia cualitativa —sin comandos, se acaba viendo lo que hay montado—, pero no es una escalada.

### 3.2 Por qué el backend no toca el disco en ninguno de los dos sentidos

Es lo que hace esta spec compatible con el principio del panel, y es consecuencia de cómo funciona el navegador:

- **`<input type="file">` entrega el contenido, no la ruta.** El navegador lee el fichero del usuario y lo manda; el backend recibe bytes y nunca ve `/home/alejandro/...`. SPEC-14 §3.1 documenta esto por el motivo *opuesto* —que `docker compose` sí necesita una ruta real porque corre en el backend—, y aquí esa necesidad no aparece.
- **La descarga la hace el navegador.** El backend devuelve el fichero y el cliente lo guarda con un Blob, así que el usuario elige dónde y el backend no escribe nada.

Con las dos condiciones, esta spec **no rompe** "el panel no escribe en el disco del usuario". Es la diferencia entre esta feature y la de renombrar, donde el panel sí le habla al daemon para cambiar algo fuera.

### 3.3 El listado va por `exec`, no por el archive

Por §2.2. Se ejecuta `ls -1A -- <ruta>` y `ls -laA -- <ruta>` con la ruta **como elemento del argv**, nunca interpolada en una cadena de shell. Dos llamadas, no una por entrada: el detalle de nombre, tipo y tamaño sale de la segunda, con la lista de la primera como verdad para los nombres.

Si la segunda llamada no cuadra con la primera —un nombre con espacios dobles, o una entrada que apareció entre las dos— la entrada se lista **sin tamaño en vez de con un tamaño equivocado**. Mostrar el tamaño del fichero equivocado es peor que no mostrarlo.

### 3.4 Escribir en un contenedor en marcha

Es lo que hace `docker cp` útil y también peligroso:

- El fichero se escribe de golpe, sin transacción. Si se corta a mitad, queda un fichero **truncado**.
- Si el proceso tiene el fichero abierto, puede seguir usando la versión anterior en memoria mientras el disco tiene la nueva. El reinicio siguiente lo destapa.
- Escribir encima de un binario en uso da `text file busy` o deja el contenedor en un estado raro.

Por eso el diálogo **avisa cuando el contenedor está en marcha y pide confirmación**. No lo bloquea —escribir en un contenedor parado es legítimo y a veces es justo lo que se quiere— pero para subir hay que haber leído el aviso.

> **Corrección posterior a la implementación.** Este spec decía «avisa y no lo bloquea», que en la práctica significa *escribe primero y avisa después*. Eso no es un aviso: es una disculpa que el usuario no ha podido leer. La implementación pide un clic de confirmación.

### 3.5 Symlinks: no se siguen, y hay que decirlo

Al leer, el tar que devuelve el archive trae la **entrada del enlace**, no su destino. Copiar `/datos/enlace` baja el enlace, no lo que apunta. Es el comportamiento correcto —seguirlos sería un traversal— pero un usuario que copia un enlace esperando el fichero se lleva una sorpresa, así que la UI lo dice en vez de dejar que lo descubra al abrir.

### 3.6 Dónde vive el botón

En el **detalle** del contenedor, no en la fila de la tabla. La razón de este spec era evitar una quinta acción en una fila que sólo tiene acciones destructivas, pero al implementarlo apareció una mejor: el botón de terminal **sólo sale con el contenedor en marcha**, y a un contenedor **parado** se le pueden subir ficheros —que es justo cuando se le pone una configuración antes de arrancarlo. En la tabla, esa acción no existiría.

---

## 4. Criterios de Aceptación (Gherkin en Español)

```gherkin
# language: es
Característica: Explorar y copiar ficheros de un contenedor
  Como operador que administers contenedores desde el panel
  quiero bajar un log y subir una configuración
  para no depender de una terminal al lado

  Antecedentes:
    Dado que el daemon de Docker está accesible

  Escenario: Listar un directorio
    Dado un contenedor con un directorio "datos" que tiene tres entradas
    Cuando el usuario abre el explorador de ficheros
    Entonces ve las tres entradas con su nombre, tipo y tamaño
    Y las entradas vienen ordenadas, con los directorios primero

  Escenario: Entrar y salir de un directorio
    Dado el explorador abierto en un directorio
    Cuando el usuario entra en un subdirectorio
    Entonces ve su contenido
    Y puede volver al padre
    Y en la raíz del contenedor no hay botón de volver

  Escenario: Los ficheros ocultos también se listan
    Dado un directorio con un fichero que empieza por punto
    Cuando el usuario lista ese directorio
    Entonces el fichero oculto aparece
    Porque en un contenedor porque en un contenedor el punto lo pone el usuario, no la herramienta

  Escenario: Un nombre con espacios se muestra entero
    Dado un directorio con un fichero llamado "con espacios" y otro "doble  espacio"
    Cuando el usuario lista el directorio
    Entonces el primero aparece con su nombre completo

  Escenario: Descargar un fichero del contenedor
    Dado un contenedor con un fichero de 2 KB
    Cuando el usuario pulsa descargar
    Entonces el navegador recibe el contenido del fichero
    Y el backend no escribe nada en el disco del host

  Escenario: Subir un fichero al contenedor
    Dado un contenedor y un fichero local cualquiera
    Cuando el usuario elige el fichero y confirma
    Entonces el fichero aparece dentro del contenedor en la ruta elegida
    Y el backend nunca ha preguntado por la ruta local del fichero

  Escenario: Subir un directorio entero
    Dado un usuario que elige una carpeta con tres ficheros
    Cuando confirma la subida
    Entonces los tres ficheros aparecen en el contenedor con su estructura

  Escenario: Escribir en un contenedor en marcha avisa
    Dado un contenedor en marcha
    Cuando el usuario va a subir un fichero
    Entonces se le avisa de que puede sobrescribir lo que haya
    Y se le explica que un proceso puede seguir usando la versión anterior
    Y puede continuar si quiere

  Escenario: Escribir en un contenedor parado no avisa
    Dado un contenedor parado
    Cuando el usuario sube un fichero
    Entonces no aparece ningún aviso

  Escenario: Un fichero demasiado grande se rechaza antes de subirlo
    Dado un fichero de más del tope de subida
    Cuando el usuario lo elige
    Entonces el panel dice cuánto pesa y cuánto se admite
    Y no se sube nada

  Escenario: Descargar algo demasiado grande se rechaza antes de intentarlo
    Dado un fichero de más del tope de descarga
    Cuando el usuario pulsa descargar
    Entonces el panel dice el tamaño y el tope
    Y no se intenta la transferencia

  Escenario: Un symlink se descarga como enlace, y se avisa
    Dado un directorio con un enlace simbólico
    Cuando el usuario lo descarga
    Entonces se le dice que es un enlace y que no se sigue
    Y lo baja como enlace, no como el fichero al que apunta

  Escenario: Subir encima de un fichero existente avisa
    Dado un contenedor con un fichero en la ruta destino
    Cuando el usuario sube otro fichero con el mismo nombre
    Entonces se le pregunta si quiere sobrescribir

  Escenario: Un error del daemon no deja el panel desincronizado
    Dado que el daemon rechaza la operación por un motivo inesperado
    Cuando el usuario sube o descarga
    Entonces el panel muestra el error
    Y el listado sigue siendo el que era

  Escenario: Los puntos suspensivos se resuelven DENTRO del contenedor
    Dado un contenedor con un directorio "datos"
    Cuando el usuario pide listar "datos/../../etc"
    Entonces ve el "etc" del contenedor, no el de fuera
    Y la respuesta no menciona ninguna ruta del host
    Porque el namespace del contenedor es la frontera, no este diálogo
    Y un nombre de fichero con ".." en una subida se rechaza con un 400

  Escenario: El navegador nunca recibe una ruta del host
    Dado cualquier uso de la función
    Cuando se inspecciona lo que el navegador manda
    Entonces sólo hay contenido y un nombre destino
    Y nunca una ruta del disco del usuario
```

---

## 5. Plan de Pruebas Automatizadas

### Backend (`pytest`)
- `test_listar_devuelve_nombre_tipo_y_tamano`.
- `test_listar_ordena_directorios_primero`.
- `test_listar_en_la_raiz_no_ofrece_padre`.
- `test_listar_incluye_los_ocultos`.
- `test_un_nombre_con_espacios_no_se_parte`: el doble devuelve una línea con dos espacios en el nombre y el parser **no** inventa dos entradas.
- `test_un_nombre_con_espacios_dobles_no_da_un_tamano_inventado`: la entrada aparece sin tamaño en vez de con el de otro fichero.
- `test_la_ruta_va_en_el_argv_y_no_en_la_shell`: se comprueba el `cmd` que se pasa a `exec`, no sólo que funcione.
- `test_la_ruta_con_puntos_suspensivos_no_sale_del_contenedor`.
- `test_descargar_devuelve_el_contenido_y_no_escribe_en_el_host`.
- `test_subir_rechaza_un_contenedor_parado` y `test_subir_devuelve_el_contenido_a_la_ruta`.
- `test_el_tope_de_subida_no_deja_pasar_un_fichero_grande`.

### Frontend (`vitest`)
- `test_el_explorador_lista_y_permite_navegar`.
- `test_subir_avisa_si_el_contenedor_esta_en_marcha_y_no_si_esta_parado`.
- `test_el_tope_de_subida_avisa_antes_de_subir`.
- `test_descargar_usa_el_contenido_recibido_y_no_una_ruta`.
- `test_un_symlink_avisa_de_que_no_se_sigue`.

---

## 6. Plan de Tareas (Tasks)

- [x] **Fase 1: Contratos**
  - [x] `FileKind`, `ContainerEntry` y `ListDirectoryResult` en `app/schemas/filesystem.py`
  - [x] `FILES_UPLOAD_MAX_BYTES`, `FILES_DOWNLOAD_MAX_BYTES` y `FILES_LIST_MAX_ENTRIES` en `app/core/config.py`
  - [x] Equivalentes en `src/types/filesystem.ts`
- [x] **Fase 2: Tests primero en backend (TDD)**
  - [x] Los casos de §5 en `tests/test_container_files.py`
  - [x] Fase roja
- [x] **Fase 3: Implementación backend**
  - [x] `_leer_exec()`: ejecuta un argv y devuelve stdout y stderr
  - [x] `_parsear_linea_ls()` con `split(None, 3)` para la fecha, y emparejamiento por nombre con `ls -1A`
  - [x] `list_directory()` con el tope de entradas y `truncated`
  - [x] `download()` por `GET /archive`, con streaming, corte por tope y rechazo de directorios
  - [x] `upload_files()` por `PUT /archive`, validando nombres antes de construir el tar
  - [x] `GET /files`, `GET /files/download` y `POST /files/upload`
  - [x] **Los tres endpoints nunca reciben una ruta del host.** Hay un test sobre el esquema OpenAPI que lo fija
- [x] **Fase 4: Verificación backend**
- [x] **Fase 5: Tests primero en frontend**
- [x] **Fase 6: Implementación frontend**
  - [x] `ContainerFilesModal` en el detalle del contenedor
  - [x] Listado con navegación, descarga por Blob y subida por `<input type="file">` con `webkitdirectory` para carpetas
  - [x] Los avisos: contenedor en marcha (con confirmación), symlink, topes y `size=0` como «—»
- [x] **Fase 7: Verificación y Quality Gates**
  - [x] Comprobar contra el daemon real: listado, subida, descarga, bind mount, `..`, symlink y directorio
  - [x] `agent.md` actualizado

### 6.1 Lo que salió al implementarlo y no estaba previsto

Estas cuatro cosas no estaban en el spec y son la razón de que exista §2.3 revisado:

- [x] **El parser de `ls` NO parte los nombres con espacios dobles.** El spec lo daba por perdido; `split(None, 3)` lo resuelve (§2.3).
- [x] **Sólo cuenta el primer miembro del tar en la descarga.** Buscar «el primer symlink» o «el primer fichero» del árbol devolvía un descendiente: pedir `/usr/lib` daba 200 con el contenido de `libGeoIP.so.1.6.12`. Hay un test con ese caso exacto.
- [x] **Un directorio no se descarga.** `GET /archive` lo devuelve entero y recursivo (52 MB medidos), así que responde 400 con el motivo en vez de empezar a tirar bytes.
- [x] **Un symlink sí se descarga**, y baja como enlace (su contenido es la ruta del destino, que es lo que escribiría `docker cp`). La primera versión lo filtraba con `isfile()` y lo daba por inexistente, dejándolo como la única entrada visible que no hacía nada.

### 6.2 Lo que NO se hizo, a propósito

- [ ] Copiar a una ruta del host elegida por el usuario. Rompería el principio del panel; necesitaría el confinamiento de SPEC-14 §3.2 y sería otro spec.
- [ ] Editar un fichero in-place. Descargar y subir son las dos mitades; encadenarlas con un editor es otra cosa.
- [ ] Descargar un directorio como tar. Descartado por tamaño; quien lo necesite, que use la terminal.
