# SPDX-License-Identifier: AGPL-3.0-or-later
"""Ejecución del CLI de Docker Compose.

**Este es el único módulo del backend con permiso para lanzar procesos
externos.** SPEC-12 lo introduce; SPEC-13 reutiliza este mismo runner y solo le
añade un modo de streaming. Si alguna vez hace falta otro proceso externo, se
añade aquí y en ningún otro sitio.

Por qué se llama al CLI y no se parsea el YAML en Python
--------------------------------------------------------
Porque la utilidad de un preview es ser fiel. Si el plan lo produjera un parser
propio, ese parser tendría que replicar la interpolación de variables, la fusión
de `extends`, los `profiles`, los `include`, el `env_file` con su precedencia y
los `!reset`/`!override` del Compose Spec. El día que se le escapara uno, el
preview mostraría un plan que luego `up` no cumple: eso es peor que no tener
preview, porque enseña a dejar de mirar.

`docker compose config --format json` es el propio compose diciendo "esto es lo
que interpreté". Si el preview y el `up` de SPEC-13 salen del mismo binario con
el mismo archivo, no pueden discrepar.

Compromiso que esto supone
--------------------------
El backend deja de ser cliente puro del Engine API y pasa a ser supervisor de
procesos. Son cinco obligaciones, y todas están implementadas abajo:

1. **Nunca `shell=True`.** Siempre lista de argumentos. Es la diferencia entre
   pasar un argumento y ejecutar una línea de shell.
2. **`PATH` reducido** a una lista conocida, para que un `PATH` alterado no
   convierta un nombre de binario en otra cosa.
3. **Variables de compose y de Docker limpias** del entorno hijo: si el backend
   arrancara con `COMPOSE_PROJECT_NAME` o `DOCKER_HOST` definidos, el preview
   resolvería contra otro daemon o con otro nombre de proyecto del que el
   usuario cree.
4. **`stdin=DEVNULL`.** Sin esto, un compose que pregunte algo se queda
   bloqueado leyendo de la entrada estándar y la petición no termina nunca.
5. **El proceso se mata siempre**, en éxito, en error y en cancelación, con
   `kill()` seguido de `wait()` para no dejar nada colgando.
"""

import asyncio
import os
import re
import shutil
from collections.abc import AsyncIterator
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

# Tiempos generosos para `config`: es una operación local de resolución de
# texto. Si tarda más, algo está mal (un `include:` remoto, un contexto
# colgado) y cortar es mejor que esperar.
TIMEOUT_CONFIG_S = 10.0

# `docker` puede estar en cualquiera de estos sitios según la instalación. Se
# pasa un PATH mínimo en vez de heredar el del proceso del backend, cuyo valor no
# controlamos.
KNOWN_PATH = "/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin"

# Prefijos de variables que alteran el comportamiento de compose o el daemon
# destino. Se eliminan todas del entorno hijo, no solo las dos que menciona la
# spec: `COMPOSE_FILE`, `COMPOSE_PROFILES` o `DOCKER_CONTEXT` tienen el mismo
# efecto de cambiar el resultado sin que el usuario lo haya pedido.
ENV_PREFIXES_TO_DROP = ("COMPOSE_",)
ENV_NAMES_TO_DROP = frozenset(
    {
        "DOCKER_HOST",
        "DOCKER_CONTEXT",
        "DOCKER_TLS_VERIFY",
        "DOCKER_CERT_PATH",
        # Estas también dirigen el CLI a otro sitio: si sobreviven, el
        # `docker compose` del panel puede negociar una versión de API distinta
        # de la que usa aiodocker, o usar otro builder, y entonces la operación
        # que se ve en la UI no es la que ejecuta el host.
        "DOCKER_API_VERSION",
        "DOCKER_BUILDKIT",
        "DOCKER_CLI_HINTS",
        "DOCKER_CONTENT_TRUST",
        "BUILDKIT_PROGRESS",
    }
)


class ComposeCliAusente(Exception):
    """El binario `docker` no está en el PATH o no tiene el plugin compose."""


class ComposeCliTimeout(Exception):
    """El CLI no terminó dentro del tiempo previsto. El proceso ya está muerto."""


# Código de salida con el que se reporta un timeout. 124 es el de `timeout(1)` en
# coreutils, y es un valor que el proceso real nunca devuelve: la UI usa -1 para
# "lo paró el usuario", así que si el timeout saliera con -1 se mostraría como
# una cancelación que el usuario no hizo (además del error 504 de antes).
CODIGO_TIMEOUT = 124


class ComposeCliFallo(Exception):
    """El CLI terminó con código distinto de cero: el archivo no es válido."""

    def __init__(self, codigo: int, stderr: str) -> None:
        super().__init__(stderr or f"docker compose terminó con código {codigo}")
        self.codigo = codigo
        self.stderr = stderr


@dataclass
class ResultadoProceso:
    codigo: int
    stdout: str
    stderr: str


def _entlimpio() -> dict[str, str]:
    """Entorno para el proceso hijo, sin lo que learía de más.

    Se hereda el entorno del backend **menos** las variables de compose y de
    Docker, y con el `PATH` sustituido por una lista conocida.
    """
    entorno = {
        clave: valor
        for clave, valor in os.environ.items()
        if clave not in ENV_NAMES_TO_DROP and not clave.startswith(ENV_PREFIXES_TO_DROP)
    }
    entorno["PATH"] = KNOWN_PATH
    return entorno


# Punto único de sustitución para los tests: parchean este atributo con un
# proceso falso y así **no se ejecuta el binario real**. No se parchea
# `asyncio.create_subprocess_exec` para la lógica del runner porque eso ocultaría
# el contrato del proceso (los dos pipes, `wait()` y `kill()`), que es justo lo
# que hay que probar. Los argumentos con los que se crea sí se comprueban
# parcheando `asyncio.create_subprocess_exec` directamente.
async def _crear_proceso(
    args: list[str], cwd: str, env: dict[str, str]
) -> asyncio.subprocess.Process:  # pragma: no cover - sustituido en tests
    return await asyncio.create_subprocess_exec(
        *args,
        cwd=cwd,
        env=env,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )


def argumentos_config(
    path: str | Path, project_name: str | None = None
) -> list[str]:
    """Argumentos de `docker compose ... config --format json`.

    **`--profile '*'` va siempre y no es opcional.** `docker compose config`
    excluye los servicios que declaran `profiles` salvo que se activen: sin el
    asterisco, un proyecto con un servicio `profiles: [dev]` devuelve un plan con
    un servicio menos **sin avisar**, y el usuario cree que el plan es completo
    cuando le falta la mitad (SPEC-12 §3.4). Es inocuo en archivos sin perfiles.

    Sin `-p`, compose deduce el nombre del directorio, que es lo que hará el
    `up` de SPEC-13 si el usuario no lo fuerza.
    """
    return (
        [
            "docker",
            "compose",
            "--profile",
            "*",
            "-f",
            str(path),
        ]
        + (["-p", project_name] if project_name else [])
        + ["config", "--format", "json"]
    )


async def _recoger(proceso: asyncio.subprocess.Process) -> tuple[str, str]:
    """Lee los dos pipes a la vez y los decodifica sin reventar.

    `errors="replace"`: un byte inválido en la salida no debe tumbar la
    respuesta, y el texto con la tilde es más útil que un 500.
    """
    stdout, stderr = await asyncio.gather(
        proceso.stdout.read(),
        proceso.stderr.read(),
    )
    return (
        stdout.decode("utf-8", errors="replace") if stdout else "",
        stderr.decode("utf-8", errors="replace") if stderr else "",
    )


async def ejecutar_config(
    path: str | Path,
    *,
    project_name: str | None = None,
    timeout: float = TIMEOUT_CONFIG_S,
) -> ResultadoProceso:
    """Resuelve un archivo compose y devuelve su configuración en JSON.

    `stderr` se devuelve **siempre**, también cuando el código es 0: compose
    valida el archivo y aun así avisa por stderr de una variable sin definir
    (SPEC-12 §3.3). Un implementation que solo mire el código se come ese aviso.
    """
    args = argumentos_config(path, project_name)
    cwd = str(Path(path).resolve().parent)

    try:
        proceso = await _crear_proceso(args, cwd, _entlimpio())
    except FileNotFoundError as error:
        raise ComposeCliAusente(
            "No se encontró el binario 'docker'. DockPilot necesita el CLI de "
            "Docker Compose para previsualizar un archivo."
        ) from error
    except OSError as error:
        raise ComposeCliAusente(
            f"No se pudo ejecutar 'docker': {error}"
        ) from error

    try:
        stdout, stderr = await asyncio.wait_for(_recoger(proceso), timeout=timeout)
    except TimeoutError:
        # Obligación 5: el proceso se mata y se espera, para que no quede un
        # `docker compose` vivo que el usuario ya no puede parar desde el panel.
        await _terminar(proceso)
        raise ComposeCliTimeout(
            f"docker compose no terminó en {timeout:g} s"
        ) from None

    codigo = await proceso.wait()
    if codigo != 0:
        raise ComposeCliFallo(codigo, stderr)
    return ResultadoProceso(codigo=codigo, stdout=stdout, stderr=stderr)


def _matar(proceso: asyncio.subprocess.Process) -> bool:
    """Mata el proceso. **Síncrono a propósito.**

    Es la única parte de la limpieza que no puede ser interrumpida: dentro del
    `finally` de una tarea que se está cancelando, cualquier `await` puede volver
    a lanzar `CancelledError` y saltarse el resto de la limpieza. Un `docker
    compose` que sobrevive a la cancelación es un proceso que el usuario ya no
    tiene dónde parar.
    """
    if proceso.returncode is not None:
        return False
    try:
        proceso.kill()
    except ProcessLookupError:
        # Ya había terminado entre la comprobación y el kill.
        return False
    return True


async def _terminar(proceso: asyncio.subprocess.Process) -> None:
    """Mata el proceso y espera a que muera de verdad.

    `kill()` sin `wait()` deja un zombi: el proceso ya no hace nada pero el
    sistema lo mantiene hasta que el padre salga.
    """
    if not _matar(proceso):
        return
    try:
        await proceso.wait()
    except ProcessLookupError:
        pass


# --- SPEC-13: modo streaming ---------------------------------------------------
#
# Comparte núcleo con `ejecutar_config` de SPEC-12: mismas cinco obligaciones,
# mismo `PATH`, mismo entorno limpio, mismo `stdin=DEVNULL`. La única diferencia
# es que aquí la salida se emite por trozos mientras corre en vez de recogerse
# entera al final. No se abre un segundo camino de ejecución.


# El trabajo varía en dos órdenes de magnitud: un `down` tarda segundos y un `up`
# descarga imágenes y arranca N contenedores. Un plazo global tendría que ser el
# mayor, y entonces los errores lentos no se detectan nunca.
TIMEOUTS_S = {
    "stop": 60.0,
    "down": 60.0,
    "logs": 60.0,
    "pull": 600.0,
    "up": 900.0,
}

TIMEOUT_POR_DEFECTO_S = 60.0

# Qué acciones aceptan un servicio. El servicio va como argumento POSICIONAL
# porque compose v2 no tiene `--service` (SPEC-13 §3.1).
ACCIONES_CON_SERVICIO = frozenset({"logs", "pull", "stop"})

# Nombres de servicio de compose: lo que pone el usuario en el `docker-compose.yml`
# bajo cada clave. Al ir como argumento posicional, un `-` inicial lo convertiría
# en flag, así que se exige el mismo patrón que usa compose.
SERVICE_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]*$")

# Secuencias de escape ANSI. Sin TTY compose no colorea, pero si el `PATH` o la
# versión del CLI cambian eso, el panel acabaría pintando escapes dentro de un
# `<pre>`. Es una red de seguridad, no una necesidad observada.
_ANSI = re.compile(rb"\x1b\[[0-9;?]*[A-Za-z]")

# Tamaño de lectura. 64 KiB es el búfer por defecto de los streams de asyncio.
CHUNK = 65536


@dataclass
class Trozo:
    """Un fragmento de salida, ya limpiado y decodificado."""

    stream: Literal["stdout", "stderr"]
    data: str


@dataclass
class ResultadoAccion:
    """Cómo terminó la acción.

    El generador no puede devolver un valor: un `async` generator se termina
    con `StopAsyncIteration` y ahí no hay sitio para un código de salida. Quien
    llama crea este objeto, lo pasa y lo lee al terminar; es el mismo truco que
    `asyncio.subprocess` con `returncode`.
    """

    codigo: int | None = None
    terminada: bool = False
    cancelada: bool = False


def hay_cli() -> bool:
    """Si el binario `docker` está en el `PATH` reducido.

    Se comprueba **antes** de anunciar la acción, para no mandar un mensaje
    `start` con los argumentos exactos de algo que no llegó a ejecutarse nunca.
    El `FileNotFoundError` del spawn sigue ahí como red de seguridad: esta
    comprobación puede pasar y el `exec` fallar igual.
    """
    return shutil.which("docker", path=KNOWN_PATH) is not None


def timeout_de(action: str, follow: bool = True) -> float:
    """Plazo de la acción, o `None` si no debe llevar reloj.

    `logs --follow` es un stream sin fin por definición: no termina cuando el
    contenedor para, y el usuario lo deja abierto mientras trabaja. Si se le
    aplica el plazo de 60 s, `asyncio.timeout` mata el proceso y el cliente
    recibe un `504` seguido de `exit -1` aunque nada haya fallado. Por eso un
    `follow` no lleva reloj: lo que lo detiene es el cliente, que cancela la
    conexión WebSocket, y ese camino sí mata el proceso en el `finally`.

    `logs` sin `follow` sí tiene fin, así que conserva su plazo.
    """
    if action == "logs" and follow:
        return None
    return TIMEOUTS_S.get(action, TIMEOUT_POR_DEFECTO_S)


def argumentos_accion(
    action: str,
    path: str | Path,
    *,
    project_name: str | None = None,
    service: str | None = None,
    follow: bool = True,
    volumes: bool = False,
    remove_orphans: bool = True,
) -> list[str]:
    """Argumentos de `docker compose ... <acción>`.

    Sin `--profile` a propósito, y a diferencia del preview de SPEC-12: aquí se
    quiere el comportamiento real de la acción. Un `up` debe arrancar lo que el
    usuario pediría en su terminal con el perfil por defecto, no todos los
    perfiles.
    """
    if action not in TIMEOUTS_S:
        raise ValueError(f"Acción no soportada: {action}")

    args = ["docker", "compose", "-f", str(path)]
    if project_name:
        args += ["-p", project_name]

    if action == "up":
        # `-d` es obligatorio: el panel no se adjunta.
        args += ["up", "-d"]
        if remove_orphans:
            # `--remove-orphans` es lo que compose v2 ya hace por defecto, y ponerlo
            # explícito hace visible la intención en el mensaje `start`.
            #
            # Se puede apagar porque desde el plan el nombre de proyecto puede
            # chocar con otro, y el flag se llevaría por delante los contenedores
            # de servicios que no estén en el archivo nuevo: destruir trabajo en
            # marcha desde un botón que dice "Desplegar" (SPEC-15 §3.3).
            args.append("--remove-orphans")
    elif action == "logs":
        args.append("logs")
        if follow:
            args.append("--follow")
    else:
        args.append(action)
        if action == "down" and volumes:
            # Nunca por defecto: es la única acción irreversible de la spec.
            args.append("--volumes")

    # El servicio va POSICIONAL al final. Compose v2 no tiene `--service`
    # (`unknown flag: --service`), y ponerlo haría fallar la acción.
    if service and action in ACCIONES_CON_SERVICIO:
        # Un servicio sin validar acaba siendo un flag: `service="--tail=99999"`
        # se añade tal cual y compose lo lee como opción, no como nombre. No es
        # inyección de shell (`shell=False`, argv), pero sí inyección de
        # argumentos en un comando que para, borra o descarga cosas.
        if not SERVICE_PATTERN.match(service):
            raise ValueError(f"Nombre de servicio no válido: {service!r}")
        args.append(service)

    return args


def _limpiar(datos: bytes) -> str:
    """Quita escapes y retornos de carro, sin reventar con bytes malos.

    Se quitan **todos** los `\r`, también los que no van seguidos de `\n`: las
    líneas de progreso de compose los usan solos, y sin quitarlos el panel
    mostraría tres superimposed en vez de la última.
    """
    limpio = _ANSI.sub(b"", datos).replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    return limpio.decode("utf-8", errors="replace")


async def ejecutar_accion(
    action: str,
    path: str | Path,
    *,
    resultado: ResultadoAccion,
    project_name: str | None = None,
    service: str | None = None,
    follow: bool = True,
    volumes: bool = False,
    remove_orphans: bool = True,
) -> AsyncIterator[Trozo]:
    """Ejecuta una acción y va emitiendo su salida mientras corre.

    Se cancela cerrando el generador: el `finally` mata el proceso, que es lo que
    hace el botón «Cancelar» del panel. El código de salida se deja en
    `resultado`, porque un generador no puede devolverlo.
    """
    args = argumentos_accion(
        action,
        path,
        project_name=project_name,
        service=service,
        follow=follow,
        volumes=volumes,
        remove_orphans=remove_orphans,
    )
    cwd = str(Path(path).resolve().parent)

    try:
        proceso = await _crear_proceso(args, cwd, _entlimpio())
    except (FileNotFoundError, OSError) as error:
        raise ComposeCliAusente(
            "No se encontró el binario 'docker'. DockPilot necesita el CLI de "
            "Docker Compose para operar un proyecto."
        ) from error

    # Los dos pipes se leen A LA VEZ. Leerlos en serie deja el otro lleno, y un
    # compose que escribe 64 KiB a `stderr` mientras se drena `stdout` se bloquea
    # a sí mismo.
    cola: asyncio.Queue[Trozo | None] = asyncio.Queue()

    async def drenar(stream: asyncio.StreamReader | None, nombre: str) -> None:
        if stream is None:
            await cola.put(None)
            return
        try:
            while True:
                datos = await stream.read(CHUNK)
                if not datos:
                    return
                texto = _limpiar(datos)
                if texto:
                    await cola.put(Trozo(stream=nombre, data=texto))  # type: ignore[arg-type]
        finally:
            # Un centinela por pipe: el consumidor no puede suponer cuál es cuál.
            await cola.put(None)

    lectores = [
        asyncio.create_task(drenar(proceso.stdout, "stdout")),
        asyncio.create_task(drenar(proceso.stderr, "stderr")),
    ]

    try:
        pendientes = len(lectores)
        # `asyncio.timeout` funciona dentro de un generador asíncrono y el `finally`
        # sigue ejecutándose al expirar, que es justo lo que hace falta: el
        # proceso tiene que morir también cuando lo mata el reloj.
        # `asyncio.timeout(None)` no arma ningún reloj: es la forma de dejar la
        # acción sin plazo, que es lo que necesita un `logs --follow`.
        async with asyncio.timeout(timeout_de(action, follow)):
            while pendientes:
                item = await cola.get()
                if item is None:
                    pendientes -= 1
                    continue
                yield item
            resultado.codigo = await proceso.wait()
    except TimeoutError:
        # El código se fija ANTES de lanzar, porque el `finally` del generador y el
        # `cancelada = True` de más abajo son caminos distintos: sin esto,
        # `codigo` se quedaba en `None` y quien lo leyera lo traducía a
        # "cancelado por el usuario".
        resultado.codigo = CODIGO_TIMEOUT
        resultado.cancelada = False
        raise ComposeCliTimeout(
            f"La acción '{action}' superó su tiempo y se detuvo."
        ) from None
    except BaseException:
        # CancelledError, WebSocketDisconnect o el corte del usuario: el proceso
        # tiene que morir igual, y `resultado` tiene que reflejarlo.
        resultado.cancelada = True
        raise
    finally:
        resultado.terminada = True
        for lector in lectores:
            lector.cancel()
        # Primero el `kill()` síncrono: pase lo que pase, el proceso muere.
        _matar(proceso)
        # Y después la parte que puede esperar, sin que una cancelación pendiente
        # la salte y deje lectores colgando.
        with suppress(asyncio.CancelledError, Exception):
            await asyncio.gather(*lectores, return_exceptions=True)
        with suppress(asyncio.CancelledError, Exception):
            await proceso.wait()
