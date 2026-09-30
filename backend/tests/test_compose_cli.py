# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests del runner de `docker compose` (SPEC-12 §3.4 y §3.6).

Ninguno ejecuta el binario: `fake_spawn` sustituye el punto de inyección
`_crear_proceso` y `spawn_call` intercepta `asyncio.create_subprocess_exec` para
comprobar los argumentos de creación. Lo que se prueba es el contrato del
runner, no Docker.
"""

import json

import pytest

from app.services.compose_cli import (
    KNOWN_PATH,
    ComposeCliAusente,
    ComposeCliFallo,
    ComposeCliTimeout,
    argumentos_config,
    ejecutar_config,
)

pytestmark = pytest.mark.asyncio

ARCHIVO = "/home/usuario/proyectos/tienda/docker-compose.yml"


# --- Resultados y códigos ------------------------------------------------------


async def test_devuelve_stdout_stderr_y_codigo(fake_spawn):
    fake_spawn.devolver(stdout=json.dumps({"name": "tienda"}).encode())

    resultado = await ejecutar_config(ARCHIVO)

    assert resultado.codigo == 0
    assert json.loads(resultado.stdout) == {"name": "tienda"}


async def test_captura_stderr_tambien_con_codigo_cero(fake_spawn):
    # El caso que hay que tratar bien: compose valida el archivo y aun así avisa
    # por stderr de una variable sin definir, saliendo con 0 (SPEC-12 §3.3).
    aviso = b'time="..." level=warning msg="The \\"X\\" variable is not set."'
    fake_spawn.devolver(stdout=b"{}", stderr=aviso)

    resultado = await ejecutar_config(ARCHIVO)

    assert resultado.codigo == 0
    assert "level=warning" in resultado.stderr


async def test_codigo_distinto_de_cero_es_error_de_validacion(fake_spawn):
    mensaje = b"go-yaml load error in parser at L3.C11: did not find expected ','"
    fake_spawn.devolver(codigo=1, stdout=b"", stderr=mensaje)

    with pytest.raises(ComposeCliFallo) as info:
        await ejecutar_config(ARCHIVO)

    assert info.value.codigo == 1
    assert "go-yaml" in info.value.stderr


async def test_cli_ausente_cuando_el_binario_no_existe(fake_spawn):
    fake_spawn.fallar_con(FileNotFoundError("docker"))

    with pytest.raises(ComposeCliAusente) as info:
        await ejecutar_config(ARCHIVO)

    assert "Docker Compose" in str(info.value)


async def test_otros_oserror_tambien_son_cli_ausente(fake_spawn):
    fake_spawn.fallar_con(PermissionError("permiso denegado"))

    with pytest.raises(ComposeCliAusente):
        await ejecutar_config(ARCHIVO)


# --- Temporizador y muerte del proceso -----------------------------------------


async def test_limita_la_lectura_por_tiempo(fake_spawn):
    fake_spawn.devolver(cuelga=True)

    with pytest.raises(ComposeCliTimeout):
        await ejecutar_config(ARCHIVO, timeout=0.05)


async def test_mata_el_proceso_al_vencer_el_temporizador(fake_spawn):
    # Sin esto queda un `docker compose` vivo que el usuario no puede parar desde
    # ningún sitio del panel.
    fake_spawn.devolver(cuelga=True)

    with pytest.raises(ComposeCliTimeout):
        await ejecutar_config(ARCHIVO, timeout=0.05)

    assert fake_spawn.proceso is not None
    assert fake_spawn.proceso.killed is True
    assert fake_spawn.proceso.waited is True


async def test_mensaje_de_timeout_dice_el_limite(fake_spawn):
    fake_spawn.devolver(cuelga=True)

    with pytest.raises(ComposeCliTimeout) as info:
        await ejecutar_config(ARCHIVO, timeout=0.05)

    assert "0.05" in str(info.value)


# --- Argumentos ----------------------------------------------------------------


async def test_argumentos_de_config_sin_nombre_de_proyecto():
    # Sin `-p`, compose deduce el nombre del directorio, que es lo que hará el
    # `up` de SPEC-13 si el usuario no lo fuerza.
    assert argumentos_config(ARCHIVO) == [
        "docker",
        "compose",
        "--profile",
        "*",
        "-f",
        ARCHIVO,
        "config",
        "--format",
        "json",
    ]


async def test_argumentos_de_config_con_nombre_de_proyecto():
    args = argumentos_config(ARCHIVO, "tienda")

    assert args[:6] == ["docker", "compose", "--profile", "*", "-f", ARCHIVO]
    assert args[6:8] == ["-p", "tienda"]
    assert args[-3:] == ["config", "--format", "json"]


async def test_usa_el_directorio_del_archivo_como_cwd(fake_spawn):
    # Sin `cwd` los `env_file` y los `build.context` relativos se resolverían
    # contra el directorio del backend, y el plan no sería el del usuario.
    fake_spawn.devolver(stdout=b"{}")

    await ejecutar_config(ARCHIVO)

    assert fake_spawn.ultima.cwd == "/home/usuario/proyectos/tienda"


# --- Obligaciones del seam (SPEC-12 §3.6) --------------------------------------


async def test_crea_el_proceso_sin_pipes_de_entrada(spawn_call):
    # Sin DEVNULL, un compose que pregunte algo se queda bloqueado leyendo de
    # la entrada estándar y la petición no termina nunca.
    await ejecutar_config(ARCHIVO)

    import asyncio as _asyncio

    assert spawn_call[0]["stdin"] == _asyncio.subprocess.DEVNULL


async def test_crea_el_proceso_con_los_dos_pipes_de_salida(spawn_call):
    await ejecutar_config(ARCHIVO)

    import asyncio as _asyncio

    assert spawn_call[0]["stdout"] == _asyncio.subprocess.PIPE
    assert spawn_call[0]["stderr"] == _asyncio.subprocess.PIPE


async def test_no_pasa_shell_true(spawn_call):
    # `create_subprocess_exec` ni siquiera acepta `shell`: la firma no lo tiene,
    # así que no hay forma de que un argumento se reintercale como línea de shell.
    await ejecutar_config(ARCHIVO)

    assert "shell" not in spawn_call[0]


async def test_pasa_los_argumentos_como_lista(spawn_call):
    await ejecutar_config(ARCHIVO)

    assert spawn_call[0]["args"][:5] == ["docker", "compose", "--profile", "*", "-f"]


async def test_reduce_el_path_a_una_lista_conocida(fake_spawn):
    fake_spawn.devolver(stdout=b"{}")

    await ejecutar_config(ARCHIVO)

    assert fake_spawn.ultima.env["PATH"] == KNOWN_PATH


async def test_limpia_las_variables_de_compose_del_entorno(fake_spawn, monkeypatch):
    monkeypatch.setenv("COMPOSE_PROJECT_NAME", "del-servidor")
    monkeypatch.setenv("COMPOSE_FILE", "/otro/compose.yml")
    fake_spawn.devolver(stdout=b"{}")

    await ejecutar_config(ARCHIVO)

    env = fake_spawn.ultima.env
    assert "COMPOSE_PROJECT_NAME" not in env
    assert "COMPOSE_FILE" not in env


async def test_limpia_las_variables_de_docker_del_entorno(fake_spawn, monkeypatch):
    monkeypatch.setenv("DOCKER_HOST", "tcp://otro-daemon:2375")
    monkeypatch.setenv("DOCKER_CONTEXT", "produccion")
    fake_spawn.devolver(stdout=b"{}")

    await ejecutar_config(ARCHIVO)

    env = fake_spawn.ultima.env
    assert "DOCKER_HOST" not in env
    assert "DOCKER_CONTEXT" not in env


async def test_el_entorno_del_hijo_ignora_el_del_proyecto(fake_spawn, monkeypatch):
    # Si el backend arrancara con COMPOSE_PROJECT_NAME o DOCKER_HOST definidos,
    # el preview resolvería contra otro daemon o con otro nombre de proyecto del
    # que el usuario cree.
    monkeypatch.setenv("COMPOSE_PROJECT_NAME", "del-servidor")
    monkeypatch.setenv("DOCKER_HOST", "tcp://otro-daemon:2375")
    fake_spawn.devolver(stdout=b"{}")

    await ejecutar_config(ARCHIVO)

    env = fake_spawn.ultima.env
    assert "del-servidor" not in env.values()
    assert "tcp://otro-daemon:2375" not in env.values()


# --- Decodificación ------------------------------------------------------------


async def test_los_bytes_invalidos_no_tumban_la_respuesta(fake_spawn):
    # Un byte inválido en la salida no debe convertir un 200 en un 500.
    fake_spawn.devolver(stdout=b'{"name": "tienda", "x": "\xff\xfe"}')

    resultado = await ejecutar_config(ARCHIVO)

    assert "tienda" in resultado.stdout


async def test_limpia_las_variables_que_redirigen_el_cli(fake_spawn, monkeypatch):
    """También las que cambian CON QUÉ API habla el CLI, no solo a qué daemon.

    `DOCKER_HOST` ya estaba en la lista, pero `DOCKER_API_VERSION` no: si
    sobrevivía, el `docker compose` del panel negociaba una versión de API
    distinta de la que usa aiodocker, y el `up` que se ve en la UI no era
    exactamente el `up` que ejecuta el host.
    """
    monkeypatch.setenv("DOCKER_API_VERSION", "1.24")
    monkeypatch.setenv("DOCKER_BUILDKIT", "0")
    monkeypatch.setenv("DOCKER_CONTENT_TRUST", "1")
    monkeypatch.setenv("BUILDKIT_PROGRESS", "plain")
    monkeypatch.setenv("DOCKER_CLI_HINTS", "false")
    fake_spawn.devolver(stdout=b"{}")

    await ejecutar_config(ARCHIVO)

    env = fake_spawn.ultima.env
    for variable in (
        "DOCKER_API_VERSION",
        "DOCKER_BUILDKIT",
        "DOCKER_CONTENT_TRUST",
        "BUILDKIT_PROGRESS",
        "DOCKER_CLI_HINTS",
    ):
        assert variable not in env, f"{variable} llegó al proceso hijo"
    assert "1.24" not in env.values()


async def test_lo_que_no_es_de_docker_sobrevive_al_hijo(fake_spawn, monkeypatch):
    """La limpieza no puede comerse el entorno que el CLI sí necesita."""
    monkeypatch.setenv("HOME", "/home/usuario")
    monkeypatch.setenv("LANG", "es_ES.UTF-8")
    fake_spawn.devolver(stdout=b"{}")

    await ejecutar_config(ARCHIVO)

    env = fake_spawn.ultima.env
    assert env["HOME"] == "/home/usuario"
    assert env["LANG"] == "es_ES.UTF-8"
