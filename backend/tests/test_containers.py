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
    # Se comprueba que el FILTRO funciona, no cuántos hay: el escenario de
    # referencia creció con los contenedores de salud de SPEC-18 y una
    # aserción sobre el total se rompería cada vez que se añada uno.
    assert data, "el filtro devuelve al menos el contenedor en marcha"
    assert all(c["status"] == "running" for c in data)
    assert "c123" in [c["id"] for c in data]


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


# --- Healthchecks (SPEC-18) ----------------------------------------------------
#
# Las tres formas del dato se midieron contra el daemon 29.8.1 y NO son la misma
# en cada sitio, que es la trampa de esta spec:
#   - `containers/json`     -> `Health: {"Status": "none"}` sin healthcheck
#   - `containers/{id}/json` -> `State.Health` AUSENTE (no "none") sin healthcheck
#   - `containers/{id}/json` -> `Config.Healthcheck.Test` solo si hay healthcheck


def _sondas(codigo: int, salida: str = "", cuantas: int = 1) -> list[dict]:
    return [
        {
            "Start": f"2026-09-30T18:40:{i:02d}.069196549-03:00",
            "End": f"2026-09-30T18:40:{i:02d}.09728021-03:00",
            "ExitCode": codigo,
            "Output": salida,
        }
        for i in range(cuantas)
    ]


@pytest.mark.asyncio
async def test_el_listado_incluye_la_salud(mock_docker):
    from app.services.container_service import ContainerService

    resumenes = await ContainerService.list_containers(mock_docker)
    por_nombre = {r.name: r for r in resumenes}

    assert por_nombre["web-app"].health.status == "none"
    assert por_nombre["db"].health.status == "unhealthy"
    assert por_nombre["db"].health.failing_streak == 3
    assert por_nombre["api"].health.status == "starting"
    assert por_nombre["sano"].health.status == "healthy"


@pytest.mark.asyncio
async def test_el_listado_no_hace_inspect_por_contenedor(mock_docker):
    """El `Health` viene en `containers/json`: si hiciera falta un `show()` por
    contenedor, la lista serían N+1 llamadas para pintar una etiqueta."""
    from app.services.container_service import ContainerService

    inspectados: list[str] = []
    original = mock_docker.containers.get

    async def get_contado(cid):
        inspectados.append(cid)
        return await original(cid)

    mock_docker.containers.get = get_contado

    await ContainerService.list_containers(mock_docker)

    assert inspectados == [], "la lista no debería inspeccionar contenedores"


@pytest.mark.asyncio
async def test_un_daemon_que_no_manda_health_deja_none(mock_docker):
    """`Health` en el listado sólo existe en Docker >= 20.10. Un daemon viejo no
    manda la clave y el panel tiene que funcionar igual.

    Con `_health = None` el doble omite `Health` del resumen, que es exactamente
    la forma de un daemon que no la manda.
    """
    from app.services.container_service import ContainerService

    for c in mock_docker.containers_db.values():
        c._health = None

    resumenes = await ContainerService.list_containers(mock_docker)

    assert resumenes, "la lista se devuelve igual"
    assert all(r.health.status == "none" for r in resumenes)


@pytest.mark.asyncio
async def test_el_detalle_trae_el_historial_de_sondas(mock_docker):
    from app.services.container_service import ContainerService

    detalle = await ContainerService.get_container(mock_docker, "c789")

    assert detalle.health.status == "unhealthy"
    assert detalle.health.failing_streak == 3
    assert len(detalle.health.log) == 3
    assert detalle.health.log[0].exit_code == 1
    assert "connection refused" in detalle.health.log[0].output
    # Y el comando que se está midiendo: sin saber QUÉ se mide, "unhealthy" no
    # es accionable.
    assert detalle.health.test == ["CMD-SHELL", "pg_isready -U postgres"]


@pytest.mark.asyncio
async def test_el_detalle_usa_el_health_del_inspect_y_no_el_del_listado(mock_docker):
    """Si el detalle usara el `Health` del listado, el historial saldría vacío:
    el listado no trae `Log`."""
    from app.services.container_service import ContainerService

    detalle = await ContainerService.get_container(mock_docker, "c789")

    assert detalle.health.log, "el historial sólo existe en el inspect"


@pytest.mark.asyncio
async def test_sin_healthcheck_el_detalle_no_trae_historial(mock_docker):
    from app.services.container_service import ContainerService

    detalle = await ContainerService.get_container(mock_docker, "c123")

    assert detalle.health.status == "none"
    assert detalle.health.log == []
    assert detalle.health.test == []


@pytest.mark.asyncio
async def test_la_salida_de_una_sonda_se_recorta(mock_docker):
    """Una sonda puede imprimir un volcado de 4 MB y el detalle es un modal."""
    from app.services.container_service import ContainerService

    enorme = "x" * (3 * 1024 * 1024)
    detalle = await ContainerService.get_container(mock_docker, "c792")

    assert detalle.health.status == "unhealthy"
    assert len(detalle.health.log[0].output) < len(enorme)
    assert detalle.health.log[0].output.startswith("xxx")
    # Recortar la salida NO recorta el historial: son cosas distintas.
    assert len(detalle.health.log) == 1


@pytest.mark.asyncio
async def test_el_filtro_de_salud_lo_resuelve_el_daemon(mock_docker):
    """El filtro lo pone el daemon (`filters.health`), no la vista."""
    from app.services.container_service import ContainerService

    pedidos: list[dict] = []

    async def listar(**kwargs):
        pedidos.append(kwargs.get("filters") or {})
        return []

    mock_docker.containers.list = listar

    await ContainerService.list_containers(mock_docker, health=["unhealthy"])

    assert {"health": ["unhealthy"]} in pedidos


@pytest.mark.asyncio
async def test_el_filtro_de_salud_llega_por_la_api(async_client: AsyncClient, mock_docker):
    """El filtro "Con problemas" es un parámetro de la petición, no del navegador."""
    pedidos: list[dict] = []
    original = mock_docker.containers.list

    async def listar(**kwargs):
        pedidos.append(kwargs.get("filters") or {})
        return await original(**kwargs)

    mock_docker.containers.list = listar

    response = await async_client.get("/api/v1/containers?health=unhealthy&health=starting")

    assert response.status_code == 200
    assert {"health": ["unhealthy", "starting"]} in pedidos


@pytest.mark.asyncio
async def test_la_api_expone_la_salud_en_listado_y_detalle(async_client: AsyncClient):
    """El contrato sale por HTTP, no sólo por el servicio (SPEC-18 §2.1)."""
    listado = await async_client.get("/api/v1/containers")
    assert listado.status_code == 200
    por_id = {c["id"]: c for c in listado.json()}

    assert por_id["c123"]["health"] == {"status": "none", "failing_streak": 0}
    assert por_id["c789"]["health"]["status"] == "unhealthy"
    assert por_id["c791"]["health"] == {"status": "healthy", "failing_streak": 0}

    detalle = await async_client.get("/api/v1/containers/c789")
    assert detalle.status_code == 200
    salud = detalle.json()["health"]
    assert salud["status"] == "unhealthy"
    assert len(salud["log"]) == 3
    assert salud["log"][0]["exit_code"] == 1
    assert salud["test"] == ["CMD-SHELL", "pg_isready -U postgres"]


# --- Renombrar un contenedor (SPEC-19) -----------------------------------------
#
# Todas las reglas se midieron contra el daemon 29.8.1 antes de escribir el spec.


@pytest.mark.asyncio
async def test_renombrar_devuelve_el_nombre_anterior_y_el_nuevo(mock_docker):
    from app.services.container_service import ContainerService

    respuesta = await ContainerService.rename_container(mock_docker, "c123", "api-gateway")

    # El panel necesita el anterior para sustituir el nombre en todas partes; sin
    # él tendría que suponerlo, y la suposición se nota en la UI.
    assert respuesta.old_name == "web-app"
    assert respuesta.new_name == "api-gateway"
    assert respuesta.id == "c123"
    assert respuesta.message


@pytest.mark.asyncio
async def test_renombrar_no_cambia_el_id(mock_docker):
    """El invariante que hace la función barata: no hay recreate."""
    from app.services.container_service import ContainerService

    antes = (await mock_docker.containers.get("c123"))._as_summary_dict()["Id"]
    await ContainerService.rename_container(mock_docker, "c123", "otro-nombre")
    despues = (await mock_docker.containers.get("c123"))._as_summary_dict()["Id"]

    assert antes == despues


@pytest.mark.asyncio
async def test_renombrar_un_contenedor_parado_lo_deja_parado(mock_docker):
    from app.services.container_service import ContainerService

    await ContainerService.rename_container(mock_docker, "c456", "parado-renombrado")

    contenedor = await mock_docker.containers.get("c456")
    assert contenedor._status == "exited"
    assert contenedor._name == "/parado-renombrado"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("nombre", "motivo"),
    [
        ("x", "al menos dos caracteres"),
        ("a", "al menos dos caracteres"),
        ("mi web", "espacio"),
        ("mi/web", "barra"),
        ("mi:web", "dos puntos"),
        ("", "no puede estar vacío"),
        ("   ", "no puede estar vacío"),
    ],
)
async def test_nombres_invalidos_dan_400(mock_docker, nombre, motivo):
    """El mínimo de 2 caracteres es la trampa: el validador de REDES usa `*` y
    aceptaría un carácter, pero Docker los rechaza. Por eso el de contenedores
    es propio y no se reutiliza el de redes."""
    from fastapi import HTTPException

    from app.services.container_service import ContainerService

    with pytest.raises(HTTPException) as exc:
        await ContainerService.rename_container(mock_docker, "c123", nombre)

    assert exc.value.status_code == 400
    assert motivo in str(exc.value.detail).lower()


@pytest.mark.asyncio
async def test_nombre_demasiado_largo_da_400(mock_docker):
    """El daemon NO impone tope: aceptó 300 caracteres. Pero un nombre que no
    cabe en una etiqueta DNS (63) rompe la resolución en cuanto el contenedor
    toca una red personalizada, así que el panel pone su propio límite."""
    from fastapi import HTTPException

    from app.services.container_service import ContainerService

    with pytest.raises(HTTPException) as exc:
        await ContainerService.rename_container(mock_docker, "c123", "a" * 64)

    assert exc.value.status_code == 400
    assert "63" in str(exc.value.detail)


@pytest.mark.asyncio
async def test_nombre_igual_al_actual_da_400(mock_docker):
    from fastapi import HTTPException

    from app.services.container_service import ContainerService

    with pytest.raises(HTTPException) as exc:
        await ContainerService.rename_container(mock_docker, "c123", "web-app")

    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_el_detalle_expone_las_redes_para_poder_avisar_del_dns(mock_docker):
    """El aviso de DNS sale del CONJUNTO de redes, no de `NetworkMode`.

    `HostConfig.NetworkMode` es sólo la red **principal**: un contenedor en
    `bridge` conectado además a una red propia sigue diciendo `bridge`, que es
    justo el caso en el que el nombre SÍ es un nombre DNS. Por eso no hay campo
    `network_mode` y el cliente deduce de `networks` (SPEC-19 §3.3).
    """
    from app.services.container_service import ContainerService

    detalle = await ContainerService.get_container(mock_docker, "c123")
    assert detalle.networks == ["bridge"], "sin las redes no se puede avisar del DNS"
    assert not hasattr(detalle, "network_mode"), (
        "network_mode mentiría: dice la red principal, no si tiene redes propias"
    )


@pytest.mark.asyncio
async def test_renombrar_no_toca_las_etiquetas_de_compose(mock_docker):
    """Compose identifica por etiquetas (SPEC-19 §3.4). Renombrar el contenedor
    es una desviación que compose tolera, pero las etiquetas describen el
    ARCHIVO y no deben cambiar."""
    from app.services.container_service import ContainerService

    await ContainerService.rename_container(mock_docker, "c123", "renombrado")

    contenedor = await mock_docker.containers.get("c123")
    assert contenedor._name == "/renombrado"
    assert contenedor._labels == {}


@pytest.mark.asyncio
async def test_renombrar_uno_inexistente_da_404(mock_docker):
    from fastapi import HTTPException

    from app.services.container_service import ContainerService

    with pytest.raises(HTTPException) as exc:
        await ContainerService.rename_container(mock_docker, "no-existe", "cualquiera")

    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_el_contrato_de_rename_llega_por_http(async_client: AsyncClient, mock_docker):
    response = await async_client.post(
        "/api/v1/containers/c123/rename", json={"name": "api-gateway"}
    )

    assert response.status_code == 200
    data = response.json()
    assert data["old_name"] == "web-app"
    assert data["new_name"] == "api-gateway"
    assert data["id"] == "c123"


@pytest.mark.asyncio
async def test_el_409_dice_el_nombre_ocupado_y_no_suelta_el_id_del_daemon(mock_docker):
    """El daemon devuelve el id del contenedor que ocupa el nombre, que el
    usuario no ve nunca. El mensaje propio enseña el NOMBRE y nada más."""
    from aiodocker.exceptions import DockerError

    from app.services.container_service import ContainerService

    async def get_que_choca(cid):
        c = await original_get(cid)

        async def rename(nuevo):
            raise DockerError(
                409,
                {
                    "message": (
                        'Error when allocating new name: Conflict. The container '
                        'name "/db" is already in use by container '
                        '"a4d168477d28800cc3980efe7fd38baf5f1a8decdd3da9f0bb07982e3a3f3f88185a33". '
                        "You have to remove (or rename) that container to be able "
                        "to reuse that name."
                    )
                },
            )

        c.rename = rename
        return c

    original_get = mock_docker.containers.get
    mock_docker.containers.get = get_que_choca

    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        await ContainerService.rename_container(mock_docker, "c123", "db")

    assert exc.value.status_code == 409
    assert "'db'" in str(exc.value.detail)
    assert "a4d168477d28" not in str(exc.value.detail), "el id del daemon no debe verse"
    assert "already in use by container" not in str(exc.value.detail)


@pytest.mark.asyncio
async def test_un_contenedor_en_red_propia_expone_su_nombre_de_red(mock_docker):
    """El nombre de la red propia tiene que estar en `networks`."""
    from app.services.container_service import ContainerService

    contenedor = await mock_docker.containers.get("c123")
    original = contenedor.show

    async def show_en_red_propia():
        info = await original()
        info["NetworkSettings"]["Networks"]["mi-red"] = {"IPAddress": "172.20.0.2"}
        return info

    contenedor.show = show_en_red_propia

    detalle = await ContainerService.get_container(mock_docker, "c123")
    assert "mi-red" in detalle.networks
