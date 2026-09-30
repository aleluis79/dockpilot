# SPDX-License-Identifier: AGPL-3.0-or-later
import pytest
from aiodocker.exceptions import DockerError
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_list_containers_general(async_client: AsyncClient):
    """Escenario: Listado general de contenedores."""
    response = await async_client.get("/api/v1/containers")
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    assert len(data) >= 2

    first = data[0]
    assert "id" in first
    assert "name" in first
    assert "image" in first
    assert "status" in first
    assert "ports" in first


@pytest.mark.asyncio
async def test_filter_containers_by_status(async_client: AsyncClient):
    """Escenario: Filtrado de contenedores por estado."""
    response = await async_client.get("/api/v1/containers?status=running")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["status"] == "running"
    assert data[0]["id"] == "c123"


@pytest.mark.asyncio
async def test_get_container_detail(async_client: AsyncClient):
    """Inspeccionar detalle de un contenedor."""
    response = await async_client.get("/api/v1/containers/c123")
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == "c123"
    assert data["name"] == "web-app"
    assert "command" in data
    assert "env" in data
    assert "labels" in data


@pytest.mark.asyncio
async def test_stop_container_success(async_client: AsyncClient):
    """Escenario: Detener un contenedor en ejecución exitosamente."""
    response = await async_client.post("/api/v1/containers/c123/stop")
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == "c123"
    assert data["action"] == "stop"
    assert data["success"] is True


@pytest.mark.asyncio
async def test_start_container_success(async_client: AsyncClient):
    """Escenario: Iniciar un contenedor detenido exitosamente."""
    response = await async_client.post("/api/v1/containers/c456/start")
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == "c456"
    assert data["action"] == "start"
    assert data["success"] is True


@pytest.mark.asyncio
async def test_restart_container_success(async_client: AsyncClient):
    """Escenario: Reiniciar un contenedor."""
    response = await async_client.post("/api/v1/containers/c123/restart")
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == "c123"
    assert data["action"] == "restart"
    assert data["success"] is True


@pytest.mark.asyncio
async def test_pause_and_unpause_container(async_client: AsyncClient):
    """Pausar y reactivar contenedor."""
    pause_res = await async_client.post("/api/v1/containers/c123/pause")
    assert pause_res.status_code == 200
    assert pause_res.json()["action"] == "pause"

    unpause_res = await async_client.post("/api/v1/containers/c123/unpause")
    assert unpause_res.status_code == 200
    assert unpause_res.json()["action"] == "unpause"


@pytest.mark.asyncio
async def test_remove_container_stopped_success(async_client: AsyncClient, mock_docker):
    """Escenario: Eliminar un contenedor detenido."""
    response = await async_client.delete("/api/v1/containers/c456")
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == "c456"
    assert data["action"] == "remove"
    assert data["success"] is True


@pytest.mark.asyncio
async def test_remove_running_container_conflict(async_client: AsyncClient):
    """Escenario: Intentar eliminar un contenedor en ejecución sin forzar."""
    response = await async_client.delete("/api/v1/containers/c123?force=false")
    assert response.status_code == 409
    data = response.json()
    assert "detail" in data


@pytest.mark.asyncio
async def test_remove_running_container_forced(async_client: AsyncClient):
    """Eliminar un contenedor en ejecución con force=true."""
    response = await async_client.delete("/api/v1/containers/c123?force=true")
    assert response.status_code == 200
    assert response.json()["success"] is True


@pytest.mark.asyncio
async def test_container_not_found(async_client: AsyncClient):
    """Escenario: Operar sobre un contenedor que no existe."""
    response = await async_client.get("/api/v1/containers/inexistente-000")
    assert response.status_code == 404
    data = response.json()
    assert "detail" in data


@pytest.mark.asyncio
async def test_docker_daemon_unavailable(async_client: AsyncClient, mock_docker):
    """Escenario: Error de comunicación con el daemon Docker."""
    mock_docker.containers.list.side_effect = DockerError(500, {"message": "Docker daemon unavailable"})
    response = await async_client.get("/api/v1/containers")
    assert response.status_code in [500, 503]


# --- Traducción de `Created` ----------------------------------------------------


def test_created_de_inspect_no_se_desvía_por_el_offset_del_host():
    """`Created` es epoch en `list` y fecha ISO en `inspect`: deben coincidir.

    La ISO llega en UTC con `Z`. Si se quita la `Z` antes de `fromisoformat` el
    datetime sale *naive* y `.timestamp()` lo lee como hora local: la fecha se
    iba exactamente lo que el offset de la máquina (en un host de Argentina,
    3 horas). El epoch de `/containers/json` es la referencia.
    """
    from app.services.container_service import _parse_created_timestamp

    epoch_de_list = 1789919314
    iso_de_inspect = "2026-09-20T15:48:34.746262744Z"

    assert _parse_created_timestamp(iso_de_inspect) == epoch_de_list
    assert _parse_created_timestamp(epoch_de_list) == epoch_de_list


def test_created_acepta_offsets_explicitos_y_basura():
    from app.services.container_service import _parse_created_timestamp

    # +02:00 explícito: el instante es el mismo, la forma no importa.
    assert _parse_created_timestamp("2026-09-20T17:48:34+02:00") == 1789919314
    assert _parse_created_timestamp("2026-09-20T15:48:34Z") == 1789919314
    assert _parse_created_timestamp("no-es-una-fecha") == 0
    assert _parse_created_timestamp(None) == 0


# --- Parseo de líneas de log ---------------------------------------------------


def test_el_parser_no_se_come_primeras_palabras_de_lineas_normales():
    """Con `timestamps=False` no puede haber timestamp, así que no se toca nada.

    El sniffer buscaba una `T` y un signo en el primer token, sin mirar ni si se
    habían pedido timestamps: `"T-shirt S-M: 42 items"` salía con el mensaje
    mutilado a `"S-M: 42 items"`.
    """
    from app.services.container_service import parse_docker_log_line

    lineas = [
        "T-shirt S-M: 42 items",
        "X-Y+T plain text",
        "NOT-A-TIMESTAMP: value",
        "Error connecting to database",
    ]
    for cruda in lineas:
        entrada = parse_docker_log_line(cruda, timestamps=False)
        assert entrada.timestamp is None, cruda
        assert entrada.message == cruda, f"la línea se mutiló: {cruda!r} -> {entrada.message!r}"


def test_el_sniffer_acepta_un_timestamp_de_verdad():
    from app.services.container_service import parse_docker_log_line

    for cruda, esperado in [
        ("2026-09-25T20:24:39.154430789Z Server started", "2026-09-25T20:24:39.154430789Z"),
        ("2026-09-25T20:24:39+02:00 Server started", "2026-09-25T20:24:39+02:00"),
        ("2026-09-25T20:24:39.154Z Server started", "2026-09-25T20:24:39.154Z"),
    ]:
        entrada = parse_docker_log_line(cruda, timestamps=True)
        assert entrada.timestamp == esperado
        assert entrada.message == "Server started"

    # Y con timestamps=False el prefijo se queda dentro del mensaje.
    entrada = parse_docker_log_line("2026-09-25T20:24:39.154Z Hola", timestamps=False)
    assert entrada.timestamp is None
    assert entrada.message == "2026-09-25T20:24:39.154Z Hola"


def test_un_pseudo_timestamp_no_pasa_ni_siquiera_con_timestamps_true():
    """El patrón tiene que ser RFC-3339 completo, no "algo con T y un signo"."""
    from app.services.container_service import parse_docker_log_line

    for cruda in ["T-shirt S-M: 42 items", "X-Y+T plain text", "NOT-A-TIMESTAMP: value"]:
        entrada = parse_docker_log_line(cruda, timestamps=True)
        assert entrada.timestamp is None, cruda
        assert entrada.message == cruda


def test_stderr_exige_marca_explicita():
    """Una frase que empieza por "Error" no es un error de stderr.

    Buscar "error" o "fatal" en los primeros 25 caracteres arrastraba a stderr
    líneas normales de stdout, que luego desaparecían del filtro del visor.
    """
    from app.services.container_service import parse_docker_log_line

    for cruda in ["[stderr] boom", "ERROR: algo", "FATAL: muero", "FATAL - muero"]:
        assert parse_docker_log_line(cruda).stream == "stderr", cruda

    for cruda in [
        "Error handled gracefully by middleware",
        "Error connecting to database",
        "The error was recovered",
        "Server started",
    ]:
        assert parse_docker_log_line(cruda).stream == "stdout", cruda
