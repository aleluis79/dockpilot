# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests del canal WebSocket del ciclo de vida (SPEC-13 §3.2 y §3.5).

El proceso se sustituye por el doble de `conftest.py`: ningún test ejecuta
`docker compose`.
"""

import contextlib
from concurrent.futures import CancelledError

import pytest
from starlette.testclient import TestClient

from app.core.docker import get_docker
from app.main import app


@pytest.fixture
def ws_client(mock_compose_docker):
    app.dependency_overrides[get_docker] = lambda: mock_compose_docker
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()


def _abrir(ws_client, action, **query):
    parametros = "&".join(f"{k}={v}" for k, v in query.items())
    return ws_client.websocket_connect(
        f"/ws/compose/{action}" + (f"?{parametros}" if parametros else "")
    )


# --- Validación en orden --------------------------------------------------------


def test_accion_fuera_de_la_lista_devuelve_404(ws_client, fake_spawn):
    with _abrir(ws_client, "rm", path="/p/dc.yml") as ws:
        mensaje = ws.receive_json()
    assert mensaje["type"] == "error"
    assert mensaje["code"] == 404
    # 404 y no 400: la acción no existe en la API, no está mal formada.
    assert fake_spawn.calls == [], "no debe lanzar proceso con una acción inválida"


def test_ruta_no_absoluta_devuelve_400(ws_client, fake_spawn):
    with _abrir(ws_client, "up", path="dc.yml") as ws:
        mensaje = ws.receive_json()
    assert mensaje["type"] == "error"
    assert mensaje["code"] == 400
    assert "absoluta" in mensaje["message"].lower()
    assert fake_spawn.calls == []


def test_archivo_inexistente_devuelve_404(ws_client, fake_spawn):
    with _abrir(ws_client, "up", path="/no/existe/dc.yml") as ws:
        mensaje = ws.receive_json()
    assert mensaje["code"] == 404
    assert fake_spawn.calls == []


# --- down --volumes: la única acción irreversible -------------------------------


def test_down_con_volumes_exige_proyecto_detenido(ws_client, fake_spawn, archivo):
    # El panel manda `project_name` tomándolo del inventario de SPEC-11, así que
    # la comprobación es exacta. `elasticsearch-local` tiene contenedores en
    # marcha en el doble: el proceso ni se lanza.
    with _abrir(
        ws_client,
        "down",
        path=str(archivo),
        project_name="elasticsearch-local",
        volumes="true",
    ) as ws:
        mensaje = ws.receive_json()
    assert mensaje["type"] == "error"
    assert mensaje["code"] == 409
    assert "en marcha" in mensaje["message"]
    assert fake_spawn.calls == [], "con un 409 no debe tocarse el daemon para nada más"


def test_down_con_volumes_pasa_si_el_proyecto_esta_detenido(
    ws_client, fake_spawn, archivo
):
    # `tickets-app` no tiene contenedores en el doble: solo volúmenes huérfanos.
    fake_spawn.devolver(stdout_trozos=[b"hecho\n"])
    with _abrir(
        ws_client,
        "down",
        path=str(archivo),
        project_name="tickets-app",
        volumes="true",
    ) as ws:
        assert ws.receive_json()["type"] == "start"
        ws.receive_json()
        assert ws.receive_json()["type"] == "exit"
    assert "--volumes" in fake_spawn.ultima.args


def test_down_con_volumes_siempre_lleva_el_flag(ws_client, fake_spawn, archivo):
    fake_spawn.devolver(stdout_trozos=[b"hecho\n"])
    with _abrir(
        ws_client, "down", path=str(archivo), project_name="tickets-app", volumes="true"
    ) as ws:
        ws.receive_json()  # start
        ws.receive_json()  # output
        exit_msg = ws.receive_json()
    assert exit_msg["type"] == "exit"
    assert "--volumes" in fake_spawn.ultima.args


# --- El ciclo normal -----------------------------------------------------------


def test_up_lanza_el_comando_con_d_y_sin_build(ws_client, fake_spawn, archivo):
    fake_spawn.devolver(stdout_trozos=[b"Container web Started\n"])
    with _abrir(ws_client, "up", path=str(archivo)) as ws:
        inicio = ws.receive_json()
        salida = ws.receive_json()
        fin = ws.receive_json()

    assert inicio["type"] == "start"
    assert salida["type"] == "output"
    assert inicio["action"] == "up"
    assert "-d" in inicio["command"]
    assert "--build" not in inicio["command"]
    assert "--remove-orphans" in inicio["command"]
    assert fin["type"] == "exit"
    assert fin["code"] == 0
    assert fin["duration_ms"] >= 0


def test_pull_no_arranca_ningun_contenedor(ws_client, fake_spawn, archivo):
    fake_spawn.devolver(stdout_trozos=[b"descargando\n"])
    with _abrir(ws_client, "pull", path=str(archivo)) as ws:
        inicio = ws.receive_json()
        ws.receive_json()
        ws.receive_json()
    assert "pull" in inicio["command"]
    assert "up" not in inicio["command"]


def test_logs_con_seguimiento_lleva_follow(ws_client, fake_spawn, archivo):
    fake_spawn.devolver(stdout_trozos=[b"linea\n"])
    with _abrir(ws_client, "logs", path=str(archivo), follow="true") as ws:
        inicio = ws.receive_json()
        ws.receive_json()
        ws.receive_json()
    assert "--follow" in inicio["command"]


def test_logs_de_un_servicio_lleva_el_argumento_posicional(ws_client, fake_spawn, archivo):
    fake_spawn.devolver(stdout_trozos=[b"linea\n"])
    with _abrir(ws_client, "logs", path=str(archivo), service="web") as ws:
        inicio = ws.receive_json()
        ws.receive_json()
        ws.receive_json()
    # Posicional y no `--service`: compose v2 no tiene ese flag.
    assert "--service" not in inicio["command"]
    assert inicio["command"][-1] == "web"


def test_el_mensaje_start_declara_los_argumentos(ws_client, fake_spawn, archivo):
    # Quien borra algo tiene que poder ver qué se ejecutó.
    fake_spawn.devolver(stdout_trozos=[b"hecho\n"])
    with _abrir(ws_client, "down", path=str(archivo)) as ws:
        inicio = ws.receive_json()
        ws.receive_json()
        ws.receive_json()
    assert inicio["command"][:4] == ["docker", "compose", "-f", str(archivo)]


def test_emite_la_salida_por_trozos_con_su_stream(ws_client, fake_spawn, archivo):
    fake_spawn.devolver(stdout_trozos=[b"uno\n", b"dos\n"], stderr_trozos=[b"aviso\n"])
    with _abrir(ws_client, "up", path=str(archivo)) as ws:
        ws.receive_json()  # start
        datos = [ws.receive_json() for _ in range(3)]
        fin = ws.receive_json()

    assert {d["stream"] for d in datos} == {"stdout", "stderr"}
    assert all(d["type"] == "output" for d in datos)
    assert fin["type"] == "exit"


# --- Un fallo de compose no es un fallo del panel ------------------------------


def test_fallo_de_compose_es_exit_y_no_error(ws_client, fake_spawn, archivo):
    # Un `up` que falla porque el puerto está ocupado NO es un error de DockPilot:
    # el proceso se ejecutó bien, fue compose el que no tuvo éxito.
    fake_spawn.devolver(codigo=1, stdout_trozos=[b"error: port is already allocated\n"])
    with _abrir(ws_client, "up", path=str(archivo)) as ws:
        ws.receive_json()  # start
        ws.receive_json()  # output
        fin = ws.receive_json()

    assert fin["type"] == "exit"
    assert fin["code"] == 1


def test_cli_ausente_devuelve_503(ws_client, fake_spawn, archivo, monkeypatch):
    # Se comprueba ANTES de mandar el `start`: anunciarte los argumentos exactos
    # de algo que no va a ejecutarse sería mentir.
    monkeypatch.setattr("app.api.v1.ws.compose_cli.hay_cli", lambda: False)
    with _abrir(ws_client, "up", path=str(archivo)) as ws:
        mensaje = ws.receive_json()
    assert mensaje["type"] == "error"
    assert mensaje["code"] == 503
    assert "Compose" in mensaje["message"]
    assert fake_spawn.calls == []


def test_cli_ausente_por_spawn_devuelve_503(ws_client, fake_spawn, archivo, monkeypatch):
    # Red de seguridad: la comprobación puede pasar y el `exec` fallar igual
    # (permisos, un binario que no se puede ejecutar). En ese caso el `start` ya
    # salió, y el error explica por qué no llegó a correr.
    monkeypatch.setattr("app.api.v1.ws.compose_cli.hay_cli", lambda: True)
    fake_spawn.fallar_con(FileNotFoundError("docker"))
    with _abrir(ws_client, "up", path=str(archivo)) as ws:
        assert ws.receive_json()["type"] == "start"
        mensaje = ws.receive_json()
    assert mensaje["type"] == "error"
    assert mensaje["code"] == 503


def test_timeout_devuelve_504_y_termina_el_proceso(
    ws_client, fake_spawn, archivo, monkeypatch
):
    fake_spawn.devolver(cuelga=True)
    monkeypatch.setattr("app.services.compose_cli.TIMEOUTS_S", {"up": 0.05})
    with _abrir(ws_client, "up", path=str(archivo)) as ws:
        ws.receive_json()  # start
        mensaje = ws.receive_json()
    assert mensaje["type"] == "error"
    assert mensaje["code"] == 504
    assert fake_spawn.proceso.killed is True
    assert fake_spawn.proceso.waited is True


# --- Cancelación ---------------------------------------------------------------


def test_cancelacion_termina_el_proceso_y_emite_exit(ws_client, fake_spawn, archivo):
    fake_spawn.devolver(stdout_trozos=[b"una linea\n"], cuelga_solo="stdout")
    with _abrir(ws_client, "logs", path=str(archivo)) as ws:
        assert ws.receive_json()["type"] == "start"
        assert ws.receive_json()["type"] == "output"
        # `--follow` no termina nunca: el panel cancela.
        ws.send_json({"type": "cancel"})
        fin = ws.receive_json()

    assert fin["type"] == "exit"
    assert fake_spawn.proceso.killed is True
    assert fake_spawn.proceso.waited is True


def test_desconexion_termina_el_proceso(ws_client, fake_spawn, archivo):
    # Si el socket se cierra, el proceso no puede seguir vivo: el usuario ya no
    # tiene dónde pararlo.
    #
    # El `TestClient` síncrono cierra su portal mientras el servidor sigue
    # emitiendo, y eso a veces llega como `CancelledError` del propio arnés. El
    # invariante que importa es que el proceso muera, no la carrera del portal.
    fake_spawn.devolver(stdout_trozos=[b"una linea\n"], cuelga_solo="stdout")
    with contextlib.suppress(Exception, CancelledError):
        with _abrir(ws_client, "logs", path=str(archivo)) as ws:
            ws.receive_json()  # start
            ws.receive_json()  # output

    assert fake_spawn.proceso.killed is True
    assert fake_spawn.proceso.waited is True


# --- Garantías del seam --------------------------------------------------------


def test_el_entorno_del_hijo_no_hereda_el_del_backend(ws_client, fake_spawn, archivo, monkeypatch):
    # Reutiliza las garantías de SPEC-12: si el backend arrancara con
    # DOCKER_HOST o COMPOSE_PROJECT_NAME definidos, la acción iría a otro sitio.
    monkeypatch.setenv("DOCKER_HOST", "tcp://otro-daemon:2375")
    monkeypatch.setenv("COMPOSE_PROJECT_NAME", "del-servidor")
    fake_spawn.devolver(stdout_trozos=[b"hecho\n"])

    with _abrir(ws_client, "up", path=str(archivo)) as ws:
        ws.receive_json()
        ws.receive_json()
        ws.receive_json()

    env = fake_spawn.ultima.env
    assert "DOCKER_HOST" not in env
    assert "COMPOSE_PROJECT_NAME" not in env


def test_no_pasa_shell(ws_client, spawn_call, archivo, monkeypatch):
    # `create_subprocess_exec` ni siquiera acepta `shell`, así que no hay forma de
    # que un argumento se reintercale como línea de shell. Sin `fake_spawn` a
    # propósito: el doble del proceso cortocircuitaría justo lo que se observa.
    monkeypatch.setattr("app.api.v1.ws.compose_cli.hay_cli", lambda: True)
    with _abrir(ws_client, "up", path=str(archivo)) as ws:
        ws.receive_json()
        ws.receive_json()
        ws.receive_json()

    assert spawn_call, "el proceso debería haberse creado"
    assert "shell" not in spawn_call[0]
