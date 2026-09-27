# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests del inventario de proyectos Docker Compose (SPEC-11)."""

import pytest

pytestmark = pytest.mark.asyncio


async def _overview(client):
    r = await client.get("/api/v1/compose/projects")
    assert r.status_code == 200, r.text
    return r.json()


async def _proyecto(overview, nombre):
    for p in overview["projects"]:
        if p["name"] == nombre:
            return p
    raise AssertionError(f"El proyecto '{nombre}' no aparece en el inventario")


# --- Agrupación y contadores ---------------------------------------------------


async def test_agrupa_recursos_por_proyecto(compose_client):
    data = await _overview(compose_client)
    proyecto = await _proyecto(data, "tickets-app")
    # No tiene contenedores, pero sí cuatro volúmenes.
    assert proyecto["volumes_count"] == 4
    assert proyecto["containers_total"] == 0


async def test_proyecto_sin_contenedores_queda_orphaned(compose_client):
    data = await _overview(compose_client)
    assert (await _proyecto(data, "simp-sica"))["orphaned"] is True
    assert (await _proyecto(data, "tickets-app"))["orphaned"] is True
    # `app` también lo es: la red `app-net` del doble base lleva la etiqueta de
    # proyecto y no tiene ningún contenedor. Es el caso real de una red que
    # sobrevive a un `down`.
    assert (await _proyecto(data, "app"))["orphaned"] is True
    # El contador tiene que cuadrar con las filas, sin proyectos de más.
    assert data["orphaned_projects"] == sum(1 for p in data["projects"] if p["orphaned"])


async def test_proyecto_con_contenedores_detenidos_no_es_orphaned(compose_client):
    data = await _overview(compose_client)
    proyecto = await _proyecto(data, "tienda")
    # Tiene un contenedor parado y otro servicio con réplicas.
    assert proyecto["containers_total"] == 4
    assert proyecto["orphaned"] is False


async def test_proyecto_sin_recursos_no_aparece(compose_client):
    data = await _overview(compose_client)
    nombres = {p["name"] for p in data["projects"]}
    assert "no-existe" not in nombres
    # La etiqueta sólo existe si algún recurso la lleva, así que no hay entrada
    # vacía que colarse en el inventario.
    assert all(p["name"] for p in data["projects"])


async def test_recurso_sin_project_label_no_se_agrupa(compose_client):
    data = await _overview(compose_client)
    # `full-editor-db` no lleva etiqueta, y tampoco `web-app` ni `db-postgres`
    # del doble base: los tres cuentan como contenedores sin proyecto.
    assert data["unlabelled_containers"] == 3
    nombres = {p["name"] for p in data["projects"]}
    assert not any("full-editor" in n for n in nombres)


async def test_volumen_anonymous_no_se_agrupa(compose_client):
    data = await _overview(compose_client)
    nombres = {p["name"] for p in data["projects"]}
    # El volumen anónimo trae `com.docker.volume.anonymous` y ningún proyecto:
    # agrupar por "tiene etiquetas" inventaría un proyecto que no existe.
    assert "aa342f746404c4a57823f40a9bccdc6cc78a2520701d2507f050b5aa5dcc9c09" not in nombres


async def test_labels_nulos_no_rompen_el_inventario(compose_client):
    # `/volumes` devuelve `Labels: None` y `/networks` y `/containers/json`
    # devuelven `{}`. Leído con `.items()` el primero revienta (SPEC-11 §3.2).
    data = await _overview(compose_client)
    assert data["unlabelled_volumes"] >= 1
    assert data["unlabelled_networks"] >= 3


# --- Detalle -------------------------------------------------------------------


async def test_nombre_logico_y_real_de_red_y_volumen(compose_client):
    r = await compose_client.get("/api/v1/compose/projects/elasticsearch-local")
    assert r.status_code == 200, r.text
    detalle = r.json()

    red = detalle["networks"][0]
    # El archivo declara `elastic`; en Docker se llama con el prefijo del proyecto.
    assert red["logical_name"] == "elastic"
    assert red["name"] == "elasticsearch-local_elastic"

    volumen = detalle["volumes"][0]
    assert volumen["logical_name"] == "elasticsearch_data"
    assert volumen["name"] == "elasticsearch-local_elasticsearch_data"


async def test_replicas_se_agrupan_por_servicio(compose_client):
    r = await compose_client.get("/api/v1/compose/projects/tienda")
    detalle = r.json()
    api = next(s for s in detalle["services"] if s["name"] == "api")
    assert api["replicas"] == 3
    assert len(api["container_names"]) == 3
    assert len(api["container_ids"]) == 3


async def test_quita_la_barra_inicial_de_los_nombres_de_contenedor(compose_client):
    r = await compose_client.get("/api/v1/compose/projects/elasticsearch-local")
    detalle = r.json()
    nombres = [n for s in detalle["services"] for n in s["container_names"]]
    # El daemon devuelve `Names: ["/elasticsearch"]`; la barra no debe colarse.
    assert "elasticsearch" in nombres
    assert not any(n.startswith("/") for n in nombres)


async def test_config_files_se_separa_por_coma(compose_client):
    # La etiqueta `project.config_files` puede traer varios archivos separados
    # por coma cuando el proyecto se lanzó con `-f a.yml -f b.yml`.
    async def _con_dos_archivos():
        from app.services.compose_service import _config_files

        return _config_files("uno.yml, dos.yml")

    assert await _con_dos_archivos() == ["uno.yml", "dos.yml"]


async def test_orden_proyectos_running_antes_que_huerfanos(compose_client):
    data = await _overview(compose_client)
    projects = data["projects"]
    # Los huérfanos (containers_total == 0) van al final.
    primeros_huerfanos = next(
        (i for i, p in enumerate(projects) if p["orphaned"]), len(projects)
    )
    assert all(not p["orphaned"] for p in projects[:primeros_huerfanos])


async def test_usa_una_sola_llamada_por_tipo_de_recurso(mock_compose_docker):
    # Tres listados, ni una llamada más: el desglose es de recuento y no necesita
    # `/system/df` (SPEC-11 §3.3).
    from app.services.compose_service import ComposeProjectService

    llamadas: list[str] = []

    def _contar(etiqueta, repo):
        original = repo.list

        async def envolvida(*args, **kwargs):
            llamadas.append(etiqueta)
            return await original(*args, **kwargs)

        repo.list = envolvida

    # Antes de envolver, para no perder el contador de la llamada previa.
    mock_compose_docker.containers.list.reset_mock()
    mock_compose_docker._query_json.reset_mock()
    _contar("containers", mock_compose_docker.containers)
    _contar("networks", mock_compose_docker.networks)
    _contar("volumes", mock_compose_docker.volumes)

    await ComposeProjectService.list_projects(mock_compose_docker)

    assert llamadas.count("containers") == 1
    assert llamadas.count("networks") == 1
    assert llamadas.count("volumes") == 1
    # `/system/df` es la llamada que SPEC-11 no debe hacer: el desglose es de
    # recuento, no de tamaño.
    assert mock_compose_docker._query_json.await_count == 0


async def test_acepta_contenedores_como_objetos_de_aiodocker(mock_compose_docker):
    # `containers.list()` devuelve objetos `DockerContainer`, NO dicts, y las
    # etiquetas viven en `_container`. El doble base devuelve dicts, así que sin
    # este test el servicio parecía correcto y contra el daemon real salía un
    # inventario vacío (SPEC-11 §3.1).
    class _Contenedor:
        def __init__(self, payload):
            self._container = payload

    original = mock_compose_docker.containers.list
    summaries = await original(all=True)

    async def como_objetos(*args, **kwargs):
        return [_Contenedor(s) for s in summaries]

    mock_compose_docker.containers.list = como_objetos

    from app.services.compose_service import ComposeProjectService

    data = await ComposeProjectService.list_projects(mock_compose_docker)
    proyecto = await _proyecto(data.model_dump(), "elasticsearch-local")
    assert proyecto["containers_total"] == 2
    assert proyecto["containers_running"] == 2
    assert proyecto["services_count"] == 2
    # Y ningún contenedor cae en el contador de sin etiquetar.
    assert data.unlabelled_containers == 3


# --- Errores -------------------------------------------------------------------


async def test_proyecto_no_encontrado_devuelve_404(compose_client):
    r = await compose_client.get("/api/v1/compose/projects/no-existe")
    assert r.status_code == 404
    assert r.json()["detail"]


async def test_compose_projects_daemon_unavailable(compose_client, mock_compose_docker):
    from aiodocker.exceptions import DockerError

    mock_compose_docker.containers.list.side_effect = DockerError(
        500, {"message": "daemon caído"}
    )
    r = await compose_client.get("/api/v1/compose/projects")
    assert r.status_code == 503
    assert r.json()["detail"]


# --- Propagación del proyecto a los resúmenes ----------------------------------


async def test_resumen_de_contenedor_incluye_compose_project(compose_client):
    r = await compose_client.get("/api/v1/containers")
    assert r.status_code == 200, r.text
    por_nombre = {c["name"]: c for c in r.json()}
    assert por_nombre["elasticsearch"]["compose_project"] == "elasticsearch-local"
    # Un contenedor sin etiqueta no inventa un proyecto.
    assert por_nombre["full-editor-db"]["compose_project"] is None


async def test_resumen_de_red_incluye_compose_project(compose_client):
    r = await compose_client.get("/api/v1/networks")
    assert r.status_code == 200, r.text
    por_nombre = {n["name"]: n for n in r.json()}
    assert por_nombre["elasticsearch-local_elastic"]["compose_project"] == "elasticsearch-local"
    assert por_nombre["bridge"]["compose_project"] is None


async def test_resumen_de_volumen_incluye_compose_project(compose_client):
    r = await compose_client.get("/api/v1/volumes")
    assert r.status_code == 200, r.text
    por_nombre = {v["name"]: v for v in r.json()}
    assert (
        por_nombre["elasticsearch-local_elasticsearch_data"]["compose_project"]
        == "elasticsearch-local"
    )
    # `Labels: None` no debe producir un proyecto `None` ni romper el listado.
    assert por_nombre["temporal"]["compose_project"] is None
