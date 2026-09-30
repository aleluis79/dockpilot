# SPDX-License-Identifier: AGPL-3.0-or-later
"""Ficheros de un contenedor (SPEC-20).

Tres decisiones de este módulo que vienen de mediciones, no de gusto:

**El listado va por `exec`, no por el archive API.** `GET /archive` sobre un
directorio devuelve el árbol entero recursivo *con el contenido de los
ficheros*: abrir `/usr/lib` para ver 177 nombres son 51 MB y 2,4 s. Listar es
un `ls`.

**La ruta viaja en el argv, nunca en una cadena de shell.** `container.exec`
acepta una lista, así que `/datos; rm -rf /` es un argumento de `ls` y no dos
comandos. Con `sh -c` sería lo contrario.

**Ninguna de las dos direcciones toca el disco del host.** Es lo que hace esta
feature compatible con el principio del panel. La subida recibe *contenido* por
multipart (el navegador nunca manda la ruta local) y la descarga la resuelve el
navegador con un Blob. El backend no abre ficheros en ningún momento.
"""

from __future__ import annotations

import io
import re
import tarfile
from collections.abc import Sequence
from typing import Any

import aiodocker
from aiodocker.exceptions import DockerError

from app.core.config import settings
from app.core.docker import docker_error_message, docker_error_status
from app.schemas.filesystem import ContainerEntry, FileKind, ListDirectoryResult

# `ls -la` de busybox y de coreutils coinciden en esto: permisos, número de
# enlaces, usuario, grupo, tamaño, fecha, nombre. Se ancla por la izquierda
# porque la FECHA NO SE PUEDE SEPARAR POR COLUMNAS: `ls` rellena el día a dos
# caracteres, así que el 1 de enero sale "Jan  1  1970" con DOS espacios y
# partir por espacios dobles parte la fecha en tres trozos y desplaza el
# nombre una columna. De ahí el `split(None, 3)` de abajo: tres campos de fecha
# y todo lo que queda es el nombre,-padding o no.
_LINEA_LS = re.compile(r"^(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$")

# Separador entre el enlace y su destino en la salida de `ls -l`.
_SEPARADOR_ENLACE = " -> "

# `ls` imprime esta línea en un directorio vacío. No es una entrada.
_CABECERA_LS = re.compile(r"^total\s+\d+$")


class ArchivoNoEncontrado(Exception):
    """La ruta no existe en el contenedor (o el daemon no la encuentra)."""


class ArchivoDemasiadoGrande(Exception):
    """El fichero supera el tope del panel. Se dice cuál, no "algo va mal"."""

    def __init__(self, tamanho: int, tope: int, direccion: str) -> None:
        self.tamanho = tamanho
        self.tope = tope
        self.direccion = direccion
        super().__init__(
            f"Ese fichero pesa {formatear_bytes(tamanho)} y el máximo para {direccion} es {formatear_bytes(tope)}."
        )


class SubidaInvalida(Exception):
    """El nombre o la forma de lo que se sube no es válido. No se envía nada."""


class ArchivoNoEsFichero(Exception):
    """La ruta es un directorio. Bajar un directorio por el archive son 51 MB."""

    def __init__(self, ruta: str) -> None:
        self.ruta = ruta
        super().__init__(f"«{ruta}» es un directorio, no un fichero. Ábrelo y baja lo que haya dentro.")


def formatear_bytes(bytes_: int) -> str:
    for unidad in ("B", "KiB", "MiB", "GiB"):
        if bytes_ < 1024:
            return f"{bytes_:.1f} {unidad}".replace(".0 ", " ")
        bytes_ /= 1024
    return f"{bytes_:.1f} TiB"


# --- Lectura del listado ------------------------------------------------------


async def _leer_exec(container: Any, argv: Sequence[str]) -> tuple[bytes, str]:
    """Ejecuta `argv` en el contenedor y devuelve `(stdout, stderr)` en texto.

    Sin TTY a propósito: con TTY el daemon no multiplexa pero mete traducción
    de fin de línea, y `ls -1A` es justo el comando cuyo formato se está
    suponiendo. Sin TTY, aiodocker ya entrega el stdout desmultiplexado.

    El argv va como lista, que es lo que impide que la ruta se interprete como
    shell (SPEC-20 §3.3).
    """
    instancia = await container.exec(list(argv), stdout=True, stderr=True, stdin=False, tty=False)
    stream = instancia.start()
    stdout: list[bytes] = []
    stderr: list[bytes] = []
    try:
        while True:
            mensaje = await stream.read_out()
            if mensaje is None:
                break
            if mensaje.stream == 2:
                stderr.append(mensaje.data)
            else:
                stdout.append(mensaje.data)
    finally:
        await stream.close()
    return b"".join(stdout), b"".join(stderr).decode("utf-8", errors="replace")


async def _nombres_reales(container: Any, ruta: str) -> list[str] | None:
    """Los nombres tal cual los devuelve `ls -1A`: un nombre por línea.

    Es la fuente de verdad del listado, porque es la única forma que no parte
    un nombre por columnas y por tanto la única que aguanta los espacios
    (SPEC-20 §2.3).

    `None` significa "esta ruta no existe"; lista vacía significa "existe y está
    vacía", que son cosas distintas y el panel las pinta distinto.
    """
    stdout, stderr = await _leer_exec(container, ["ls", "-1A", "--", ruta])
    if _parece_error_de_ruta(stderr):
        return None
    return [linea for linea in stdout.decode("utf-8", errors="replace").split("\n") if linea]


def _parece_error_de_ruta(stderr: str) -> bool:
    """Distingue "no existe" de "existe y no puedo leerlo".

    Se decide por el texto porque `ls` no devuelve un código uniforme: busybox y
    coreutils usan el 2 para ambos casos y lo cuentan en `stderr`.
    """
    bajo = stderr.lower()
    return any(
        marca in bajo
        for marca in (
            "no such file",
            "not found",
            "cannot open",
            "cannot access",
            "no existe",
        )
    )


def _parsear_linea_ls(linea: str) -> tuple[str, FileKind, int, str | None] | None:
    """`(nombre, tipo, tamaño, destino_del_enlace)` de una línea de `ls -la`.

    `None` para lo que no es una entrada: la cabecera `total 0` y las líneas en
    blanco.

    El nombre es la COLA de la línea, y eso tiene un límite asumido: un nombre
    con dos espacios seguidos se parte (`doble  espacio.txt` -> `doble`). El
    llamante lo corrige emparejando con `ls -1A`; aquí no se puede, porque no se
    sabe dónde acaba la fecha.
    """
    if not linea.strip() or _CABECERA_LS.match(linea.strip()):
        return None
    m = _LINEA_LS.match(linea)
    if m is None:
        return None
    permisos, _enlaces, _usuario, _grupo, tamanho, cola = m.groups()

    tipo = _tipo_de_permisos(permisos[0])
    destino = None
    if tipo is FileKind.SYMLINK and _SEPARADOR_ENLACE in cola:
        cola, destino = cola.rsplit(_SEPARADOR_ENLACE, 1)
        destino = destino.strip()

    # `split(None, 3)`: tres campos de fecha y el resto es el nombre. Es lo que
    # sobrevive al día relleno ("Jan  1  1970"), donde separar por espacios
    # dobles partiría la fecha y desplazaría el nombre.
    partes = cola.split(None, 3)
    if len(partes) != 4:
        return None
    nombre = partes[3]
    return nombre, tipo, int(tamanho), destino


def _tipo_de_permisos(primer_caracter: str) -> FileKind:
    if primer_caracter == "d":
        return FileKind.DIR
    if primer_caracter == "l":
        return FileKind.SYMLINK
    if primer_caracter == "-":
        return FileKind.FILE
    return FileKind.OTHER


def _ruta_padre(ruta: str) -> str | None:
    """El padre, o `None` en la raíz.

    Se normaliza la ruta antes, así que comparar con "/" basta para saber si
    estamos arriba del todo.
    """
    if ruta == "/":
        return None
    padre = ruta.rstrip("/").rsplit("/", 1)[0]
    return padre or "/"


async def list_directory(
    docker: aiodocker.Docker, container_id: str, path: str
) -> ListDirectoryResult:
    """Lista un directorio del contenedor.

    Dos `ls` y no uno: `-1A` para los nombres (que es lo fiable) y `-laA` para el
    tipo y el tamaño (que es lo cómodo). El emparejamiento es por nombre, y lo
    que no empareja se queda SIN tamaño en vez de heredar el de otro fichero: un
    tamaño equivocado es peor que un tamaño ausente (SPEC-20 §3.3).
    """
    ruta = _normalizar_ruta(path)
    container = await docker.containers.get(container_id)

    nombres = await _nombres_reales(container, ruta)
    if nombres is None:
        raise ArchivoNoEncontrado(ruta)

    stdout, stderr = await _leer_exec(container, ["ls", "-laA", "--", ruta])
    metadatos: dict[str, tuple[FileKind, int, str | None]] = {}
    if not _parece_error_de_ruta(stderr):
        for linea in stdout.decode("utf-8", errors="replace").split("\n"):
            parseada = _parsear_linea_ls(linea)
            if parseada is not None:
                nombre, tipo, tamanho, destino = parseada
                metadatos[nombre] = (tipo, tamanho, destino)

    entradas: list[ContainerEntry] = []
    truncado = False
    for nombre in nombres[: settings.FILES_LIST_MAX_ENTRIES]:
        tipo, tamanho, destino = metadatos.get(nombre, (FileKind.FILE, 0, None))
        entradas.append(
            ContainerEntry(
                name=nombre,
                kind=tipo,
                # `0` significa "no medido", no "vacío": un fichero con dos
                # espacios en el nombre no puede medir su tamaño y no hay forma
                # de distinguirlo de un fichero vacío en el contrato. La UI lo
                # pinta como "—" (SPEC-20 §3.3).
                size=tamanho,
                symlink_target=destino,
            )
        )
    if len(nombres) > settings.FILES_LIST_MAX_ENTRIES:
        truncado = True

    # Directorios primero, y dentro de cada grupo por nombre. `ls` ya viene
    # ordenado, pero el emparejamiento por nombre puede desordenarlo.
    entradas.sort(key=lambda e: (0 if e.kind is FileKind.DIR else 1, e.name.lower()))

    return ListDirectoryResult(
        container_id=container_id,
        path=ruta,
        parent=_ruta_padre(ruta),
        entries=entradas,
        truncated=truncado,
    )


# --- Descarga -----------------------------------------------------------------


async def download_file(
    docker: aiodocker.Docker, container_id: str, path: str
) -> tuple[bytes, str]:
    """`(contenido, nombre)` de un fichero del contenedor.

    `GET /archive` devuelve un **TAR con un solo miembro**, no el contenido
    pelado. Sin desenvolverlo, el usuario se baja un tar disfrazado de `.log`,
    así que el tar se abre aquí y se devuelve sólo el contenido.

    El tope se comprueba sobre el tar recibido, no sobre el miembro: es lo que
    se puede medir antes de gastar la memoria, y cortar antes de procesar es el
    punto (§2.4).
    """
    ruta = _normalizar_ruta(path)
    limite = settings.FILES_DOWNLOAD_MAX_BYTES

    bruto = await _leer_archive(docker, container_id, ruta, limite)

    try:
        with tarfile.open(fileobj=io.BytesIO(bruto), mode="r") as tf:
            miembros = tf.getmembers()
            if not miembros:
                raise ArchivoNoEncontrado(ruta)

            if len(bruto) > limite:
                raise ArchivoDemasiadoGrande(len(bruto), limite, "descarga")

            # Sólo importa el PRIMER miembro, y esto no es un detalle: es la
            # entrada de la ruta que se pidió. El tar de un directorio lleva sus
            # hijos detrás, y buscar "el primer symlink" o "el primer fichero"
            # en toda la lista encuentra un descendiente y responde con el
            # contenido de algo que el usuario no pidió. Pasó de verdad: pedir
            # `/usr/lib` devolvía el contenido de `libGeoIP.so.1.6.12`, un symlink
            # que estaba dos niveles más abajo.
            raiz = miembros[0]

            # Un symlink baja como el ENLACE, no como su destino (SPEC-20 §3.5).
            # Medido: el archive responde con un miembro `issym`, `size=0` y
            # `linkname` apuntando al destino. El contenido que devuelve esta
            # función es esa ruta, que es exactamente lo que `docker cp` escribiría
            # al reconstruirlo. Filtrar por `isfile()` —que es lo que hacía la
            # primera versión— lo daba por inexistente.
            if raiz.issym():
                return raiz.linkname.encode("utf-8"), ruta.rsplit("/", 1)[-1] or ruta

            # El directorio se rechaza con su motivo, en vez de devolver el
            # primer hijo: `/usr/lib` son 52 MB de tar para "bajar un fichero".
            if raiz.isdir() or not raiz.isfile():
                raise ArchivoNoEsFichero(ruta)

            contenido = tf.extractfile(raiz).read()
    except tarfile.TarError as exc:
        raise ArchivoNoEncontrado(ruta) from exc

    if len(contenido) > limite:
        raise ArchivoDemasiadoGrande(len(contenido), limite, "descarga")

    return contenido, ruta.rsplit("/", 1)[-1] or ruta


async def _leer_archive(
    docker: aiodocker.Docker, container_id: str, ruta: str, limite: int
) -> bytes:
    """El tar del archive GET, cortado en cuanto pasa del tope.

    Se corta a mitad de lectura a propósito: un fichero de 2 GB no puede
    acumularse en memoria para luego decir que no. El error sale antes de
    terminar de descargar.
    """
    cm = docker._query(
        f"containers/{container_id}/archive",
        method="GET",
        params={"path": ruta},
        headers={"accept-encoding": "identity"},
        timeout=None,
    )
    async with cm as respuesta:
        trozos: list[bytes] = []
        total = 0
        async for trozo in respuesta.content.iter_any():
            total += len(trozo)
            if total > limite:
                raise ArchivoDemasiadoGrande(total, limite, "descarga")
            trozos.append(trozo)
    return b"".join(trozos)


# --- Subida -------------------------------------------------------------------


async def upload_files(
    docker: aiodocker.Docker,
    container_id: str,
    path: str,
    archivos: Sequence[tuple[str, bytes]],
) -> int:
    """Sube ficheros al contenedor. Devuelve cuántos han aterrizado.

    `archivos` son pares `(nombre_relativo, contenido)`. El nombre lo pone el
    NAVEGADOR (con `webkitRelativePath` si es una carpeta) y el contenido es lo
    que el navegador leyó del disco del usuario. El backend nunca ve una ruta
    del host y nunca abre un fichero (§3.2).

    El tar se construye AQUÍ, no en el navegador: así el tar se valida en el
    servidor y no hace falta una librería de tar en el frontend.
    """
    if not archivos:
        raise SubidaInvalida("No hay ningún fichero que subir.")

    destino = _normalizar_ruta(path)
    total = 0
    for nombre_relativo, contenido in archivos:
        _validar_nombre(nombre_relativo)
        total += len(contenido)
        if total > settings.FILES_UPLOAD_MAX_BYTES:
            raise ArchivoDemasiadoGrande(
                total, settings.FILES_UPLOAD_MAX_BYTES, "subida"
            )

    tar = _construir_tar(archivos)

    cm = docker._query(
        f"containers/{container_id}/archive",
        method="PUT",
        params={"path": destino, "noOverwriteDirNonDir": False},
        data=tar,
        headers={"content-type": "application/x-tar"},
    )
    try:
        async with cm:
            pass
    except DockerError as exc:
        _traducir_error_de_subida(exc)

    return len(archivos)


def _construir_tar(archivos: Sequence[tuple[str, bytes]]) -> bytes:
    """Empaqueta los ficheros en un tar en memoria.

    Se conserva la ruta relativa tal cual (con sus subdirectorios) y se fija un
    modo neutro: el daemon reescribe los permisos según su MASK y el usuario no
    ha pedido nada sobre ellos.
    """
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as tf:
        for nombre_relativo, contenido in archivos:
            limpio = _limpiar_nombre(nombre_relativo)
            info = tarfile.TarInfo(limpio)
            info.size = len(contenido)
            info.mode = 0o644
            info.mtime = 0
            tf.addfile(info, io.BytesIO(contenido))
    return buffer.getvalue()


def _limpiar_nombre(nombre: str) -> str:
    """Quita sólo lo que es ruido, y NADA que sea un salto de directorio.

    Se usa DESPUÉS de `_validar_nombre`, que ya ha comprobado que no hay `..`
    ni ruta absoluta. Sin ese orden, un `lstrip("./")` de guasa "limpia"
    `../../etc/x` y lo convierte en `etc/x`: el fichero acaba en el sitio
    equivocado y el usuario no se entera, que es peor que un rechazo.
    """
    limpio = nombre.replace("\\", "/")
    while limpio.startswith("./"):
        limpio = limpio[2:]
    return limpio.strip("/")


def _validar_nombre(nombre: str) -> None:
    """Rechaza un nombre de fichero que no pueda salir del directorio destino.

    El daemon lo rechaza también (`500 invalid entry name`, medido en SPEC-20
    §3.1), pero un 500 de Docker para un fichero que el usuario ha elegido del
    navegador no es una respuesta: tiene que ser un 400 que diga qué estaba mal
    y que no haya escrito nada.
    """
    if not nombre or not nombre.strip():
        raise SubidaInvalida("Hay un fichero sin nombre en la selección.")

    normalizado = nombre.replace("\\", "/")
    if normalizado.startswith("/"):
        raise SubidaInvalida(
            f"El nombre «{nombre}» es una ruta absoluta. Sube ficheros, no rutas del host."
        )
    # Se mira el nombre CRUDO, no el limpio: `lstrip` se come el `..` de en medio y el
    # rechazo tiene que venir antes.
    if any(parte == ".." for parte in normalizado.split("/")):
        raise SubidaInvalida(
            f"El nombre «{nombre}» sale del directorio destino («..» no se admite)."
        )
    limpio = _limpiar_nombre(nombre)
    if not limpio:
        raise SubidaInvalida(f"El nombre «{nombre}» no es válido para un fichero.")


def _traducir_error_de_subida(exc: DockerError) -> None:
    """Convierte el rechazo del daemon en un mensaje que se puede enseñar."""
    mensaje = docker_error_message(exc)
    if "invalid entry name" in mensaje.lower():
        raise SubidaInvalida(
            "El daemon ha rechazado un nombre de fichero por contener «..» o una ruta absoluta."
        ) from exc
    raise DockerError(docker_error_status(exc), {"message": mensaje}) from exc


# --- Rutas --------------------------------------------------------------------


def _normalizar_ruta(path: str) -> str:
    """Deja la ruta en forma canónica: absoluta, sin `.`, sin `..` ni `//`.

    OJO con lo que esto NO es: no es una defensa. Los `..` se resuelven dentro
    del namespace del contenedor, así que aunque llegaran enteros el daemon no
    sacaría nada del contenedor (SPEC-20 §3.1, medido: `/datos/../../etc/hostname`
    devuelve el `/etc/hostname` del contenedor). Normalizar es para que "el
    mismo sitio" se pueda pedir de dos maneras y no se muestren dos listados
    distintos.

    Un `..` que se sale de la raíz se recorta en vez de rechazarse, que es lo
    que hace el kernel.
    """
    partes: list[str] = []
    for parte in (path or "/").split("/"):
        if not parte or parte == ".":
            continue
        if parte == "..":
            if partes:
                partes.pop()
            continue
        partes.append(parte)
    return "/" + "/".join(partes)


def _error_de_daemon(exc: Exception) -> DockerError:
    """Un `DockerError` servible, sea lo que sea lo que haya criado aiodocker."""
    if isinstance(exc, DockerError):
        return DockerError(docker_error_status(exc), {"message": docker_error_message(exc)})
    return DockerError(503, {"message": str(exc)})


class ContainerFilesService:
    """Fachada de los ficheros de un contenedor.

    Los métodos son `@staticmethod` como en `ContainerService`: son funciones
    puras sobre `docker` y no hay estado que compartir.
    """

    @staticmethod
    async def list_directory(
        docker: aiodocker.Docker, container_id: str, path: str
    ) -> ListDirectoryResult:
        return await list_directory(docker, container_id, path)

    @staticmethod
    async def download_file(
        docker: aiodocker.Docker, container_id: str, path: str
    ) -> tuple[bytes, str]:
        return await download_file(docker, container_id, path)

    @staticmethod
    async def upload_files(
        docker: aiodocker.Docker,
        container_id: str,
        path: str,
        archivos: Sequence[tuple[str, bytes]],
    ) -> int:
        return await upload_files(docker, container_id, path, archivos)

    @staticmethod
    def normalizar_ruta(path: str) -> str:
        return _normalizar_ruta(path)

# Alias sin guion bajo para los tests: `_normalizar_ruta` es de uso interno del
# módulo y la ruta que llega por HTTP ya está normalizada, pero el comportamiento
# (recortar el `..` que se sale de la raíz, como el kernel) esObservable desde
# fuera y por eso tiene su propia prueba.
normalizar_ruta_publica = _normalizar_ruta
