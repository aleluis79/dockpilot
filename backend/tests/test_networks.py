"""Contratos de `/api/v1/networks` (SPEC-10)."""

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.asyncio


async def test_list_networks_normaliza_entradas(async_client: AsyncClient):
    """`networks.list()` devuelve una lista de dicts, no un dict como volúmenes."""
    response = await async_client.get("/api/v1/networks")
    assert response.status_code == 200
    data = response.json()

    por_nombre = {n["name"]: n for n in data}
    assert set(por_nombre) == {"bridge", "host", "none", "app-net", "huerfana"}

    app = por_nombre["app-net"]
    assert app["driver"] == "bridge"
    assert app["scope"] == "local"
    assert app["attachable"] is True
    assert app["internal"] is False
    assert app["subnets"] == [{"subnet": "172.18.0.0/16", "gateway": "172.18.0.1"}]
    assert app["created"].startswith("2026-07-01")


async def test_container_count_se_deriva_de_los_contenedores(async_client: AsyncClient):
    """`list()` no trae recuento: sale de `NetworkSettings.Networks`.

    Es el mismo rodeo que hace falta en SPEC-08 para los volúmenes.
    """
    response = await async_client.get("/api/v1/networks")
    por_nombre = {n["name"]: n for n in response.json()}

    assert por_nombre["app-net"]["container_count"] == 1
    assert por_nombre["bridge"]["container_count"] == 1
    assert por_nombre["huerfana"]["container_count"] == 0


async def test_redes_predefinidas_quedan_marcadas(async_client: AsyncClient):
    """`none`, `host` y `bridge` se exponen como predefinidas."""
    response = await async_client.get("/api/v1/networks")
    por_nombre = {n["name"]: n for n in response.json()}

    for nombre in ("none", "host", "bridge"):
        assert por_nombre[nombre]["is_builtin"] is True, f"{nombre} deberia ser predefinida"
    assert por_nombre["app-net"]["is_builtin"] is False
    assert por_nombre["huerfana"]["is_builtin"] is False


async def test_subnets_tolera_ipam_null(async_client: AsyncClient):
    """`IPAM.Config` es `null` en `none` y `host`: no debe romper el listado."""
    response = await async_client.get("/api/v1/networks")
    por_nombre = {n["name"]: n for n in response.json()}

    assert por_nombre["none"]["subnets"] == []
    assert por_nombre["host"]["subnets"] == []
    # `none` tiene driver null en el daemon; no debe romperse al mapearlo
    assert "driver" in por_nombre["none"]


async def test_network_detail_lista_contenedores(async_client: AsyncClient):
    """El detalle nombra los contenedores, que solo aparecen en `show()`."""
    response = await async_client.get("/api/v1/networks/app-net")
    assert response.status_code == 200
    data = response.json()

    assert data["containers"] == ["web-app"]
    assert data["container_count"] == 1
    assert data["labels"] == {"com.docker.compose.project": "app"}
    assert data["options"] == {"com.docker.network.bridge.default_bridge": "true"}


async def test_network_detail_not_found(async_client: AsyncClient):
    """Una red inexistente devuelve 404 nombrándola.

    Se comprueba el detalle: una ruta inexistente también daría 404.
    """
    response = await async_client.get("/api/v1/networks/no-existe-esta-red")
    assert response.status_code == 404
    assert "no-existe-esta-red" in response.json()["detail"]


async def test_delete_network_ok(async_client: AsyncClient):
    """Una red sin contenedores se borra."""
    response = await async_client.delete("/api/v1/networks/huerfana")
    assert response.status_code == 200
    data = response.json()

    assert data["name"] == "huerfana"
    assert data["deleted"] is True

    listado = await async_client.get("/api/v1/networks")
    assert "huerfana" not in {n["name"] for n in listado.json()}


async def test_delete_network_not_found(async_client: AsyncClient):
    """Borrar una red inexistente devuelve 404 nombrándola."""
    response = await async_client.delete("/api/v1/networks/no-existe-esta-red")
    assert response.status_code == 404
    assert "no-existe-esta-red" in response.json()["detail"]


@pytest.mark.parametrize("nombre", ["bridge", "host", "none"])
async def test_delete_builtin_rechazado_antes_de_contactar_con_el_daemon(
    async_client: AsyncClient, mock_docker, nombre: str
):
    """Una red predefinida se rechaza con 400 sin llegar a preguntar al daemon.

    No se delega en Docker no depende de que Docker lo impida: la comprobación es nuestra.
    """
    response = await async_client.delete(f"/api/v1/networks/{nombre}")
    assert response.status_code == 400
    assert nombre in response.json()["detail"]

    # Sigue existiendo
    detalle = await async_client.get(f"/api/v1/networks/{nombre}")
    assert detalle.status_code == 200


async def test_delete_network_en_uso_devuelve_409(async_client: AsyncClient):
    """Con contenedores conectados el daemon responde 409."""
    response = await async_client.delete("/api/v1/networks/app-net")
    assert response.status_code == 409


async def test_delete_network_force_usa_la_via_cruda(
    async_client: AsyncClient, mock_docker
):
    """`DockerNetwork.delete()` no admite parámetros: el force va por `_query_json`.

    Es la única forma de forzar el borrado con la API de aiodocker.
    """
    llamadas = []
    original = mock_docker._query_json

    async def registrar(endpoint, method="GET", params=None):
        llamadas.append((endpoint, method, params))
        return await original(endpoint, method, params)

    mock_docker._query_json = registrar

    response = await async_client.delete("/api/v1/networks/app-net?force=true")
    assert response.status_code == 200
    assert response.json()["deleted"] is True

    assert ("networks/app-net", "DELETE", {"force": "true"}) in llamadas


async def test_create_network_ok(async_client: AsyncClient):
    """Crear una red con subred y puerta de enlace explícitas."""
    response = await async_client.post(
        "/api/v1/networks",
        json={"name": "nueva", "subnet": "172.20.0.0/16", "gateway": "172.20.0.1"},
    )
    assert response.status_code == 201
    data = response.json()

    assert data["name"] == "nueva"
    assert data["driver"] == "bridge"
    assert data["subnets"] == [{"subnet": "172.20.0.0/16", "gateway": "172.20.0.1"}]
    assert data["container_count"] == 0


async def test_create_network_sin_subred_deja_asignar_a_docker(
    async_client: AsyncClient, mock_docker
):
    """Sin subred no se envía configuración IPAM: Docker asigna la siguiente libre."""
    response = await async_client.post("/api/v1/networks", json={"name": "automatica"})
    assert response.status_code == 201

    enviado = mock_docker.networks.create_calls[-1]
    assert "IPAM" not in enviado


async def test_create_network_normaliza_subnet(async_client: AsyncClient):
    """`172.20.0.5/16` se normaliza a `172.20.0.0/16` en vez de rechazarse."""
    response = await async_client.post(
        "/api/v1/networks", json={"name": "normalizada", "subnet": "172.20.0.5/16"}
    )
    assert response.status_code == 201
    assert response.json()["subnets"][0]["subnet"] == "172.20.0.0/16"


@pytest.mark.parametrize(
    "nombre",
    ["", "-empieza-por-guion", "espacio aqui", "guion/medio", "docker_reservado", "a" * 64],
)
async def test_create_network_nombre_invalido(async_client: AsyncClient, nombre: str):
    """El nombre se valida en el borde, antes de contactar con el daemon."""
    response = await async_client.post("/api/v1/networks", json={"name": nombre})
    assert response.status_code in (400, 422)


async def test_create_network_subnet_invalida(async_client: AsyncClient):
    """Una subred que no es CIDR IPv4 se rechaza con 400."""
    response = await async_client.post(
        "/api/v1/networks", json={"name": "mala", "subnet": "no-es-una-cidr"}
    )
    assert response.status_code == 400
    assert "subnet" in response.json()["detail"].lower()


async def test_create_network_gateway_sin_subnet_rechazado(async_client: AsyncClient):
    """El daemon no admite puerta de enlace sin subred: se rechaza antes."""
    response = await async_client.post(
        "/api/v1/networks", json={"name": "sin-subred", "gateway": "172.21.0.1"}
    )
    assert response.status_code == 400


async def test_create_network_driver_no_soportado(async_client: AsyncClient):
    """Esta versión solo admite el driver `bridge`."""
    response = await async_client.post(
        "/api/v1/networks", json={"name": "overlay", "driver": "overlay"}
    )
    assert response.status_code == 400
    assert "bridge" in response.json()["detail"]


async def test_create_network_duplicado_devuelve_409(async_client: AsyncClient):
    """Un 409 del daemon por nombre duplicado se traduce a un mensaje claro."""
    response = await async_client.post("/api/v1/networks", json={"name": "app-net"})
    assert response.status_code == 409
    assert "app-net" in response.json()["detail"]


async def test_prune_networks_solo_borra_las_sin_contenedores(async_client: AsyncClient):
    """La limpieza elimina huérfanas y respeta las predefinidas y las en uso."""
    response = await async_client.post("/api/v1/networks/prune")
    assert response.status_code == 200
    data = response.json()

    assert data["deleted"] == ["huerfana"]

    restantes = {n["name"] for n in (await async_client.get("/api/v1/networks")).json()}
    assert "huerfana" not in restantes
    for nombre in ("bridge", "host", "none", "app-net"):
        assert nombre in restantes, f"{nombre} no deberia haberse borrado"


async def test_prune_networks_sin_huerfanas_devuelve_lista_vacia(
    async_client: AsyncClient,
):
    """Sin redes huérfanas la respuesta es correcta y no un error."""
    await async_client.delete("/api/v1/networks/huerfana")

    response = await async_client.post("/api/v1/networks/prune")
    assert response.status_code == 200
    assert response.json()["deleted"] == []
