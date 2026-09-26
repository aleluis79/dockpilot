"""Gestión de volúmenes: listado, detalle, borrado y limpieza (SPEC-08)."""

import pytest
from httpx import AsyncClient

from tests.fake_volumes import ANON_A


# --------------------------------------------------------------------------- #
# Listado
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_list_volumes_joins_usage(async_client: AsyncClient):
    """El listado une /volumes con /system/df para traer size y ref_count."""
    response = await async_client.get("/api/v1/volumes")
    assert response.status_code == 200
    data = response.json()

    by_name = {v["name"]: v for v in data}
    assert by_name["datos-app"]["size"] == 104857600
    assert by_name["datos-app"]["ref_count"] == 1
    assert by_name["temporal"]["ref_count"] == 0


@pytest.mark.asyncio
async def test_list_volumes_handles_missing_usage_index(async_client: AsyncClient):
    """Un volumen ausente del índice de df aparece con size 0 y ref_count 0."""
    response = await async_client.get("/api/v1/volumes")
    data = response.json()

    by_name = {v["name"]: v for v in data}
    assert "sin-usage" in by_name, "el volumen debe listarse aunque el daemon no sepa su tamaño"
    assert by_name["sin-usage"]["size"] == 0
    assert by_name["sin-usage"]["ref_count"] == 0


@pytest.mark.asyncio
async def test_anonymous_volume_detection(async_client: AsyncClient):
    """El nombre hash de 64 hex se marca como anónimo; un nombre legible no."""
    response = await async_client.get("/api/v1/volumes")
    by_name = {v["name"]: v for v in response.json()}

    assert by_name[ANON_A]["is_anonymous"] is True
    assert by_name["datos-app"]["is_anonymous"] is False
    assert by_name["temporal"]["is_anonymous"] is False


@pytest.mark.asyncio
async def test_list_volumes_exposes_metadata(async_client: AsyncClient):
    """El listado incluye driver, punto de montaje, ámbito y fecha."""
    response = await async_client.get("/api/v1/volumes")
    by_name = {v["name"]: v for v in response.json()}

    datos = by_name["datos-app"]
    assert datos["driver"] == "local"
    assert datos["scope"] == "local"
    assert datos["mountpoint"] == "/var/lib/docker/volumes/datos-app/_data"
    assert datos["created_at"].startswith("2026-09-20")
    assert datos["labels"] == {"app": "dockpilot"}


# --------------------------------------------------------------------------- #
# Detalle
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_volume_detail_success(async_client: AsyncClient):
    """GET /{name} devuelve metadatos, opciones y contenedores que lo usan."""
    response = await async_client.get("/api/v1/volumes/datos-app")
    assert response.status_code == 200
    data = response.json()

    assert data["name"] == "datos-app"
    assert data["ref_count"] == 1
    assert data["size"] == 104857600
    assert "containers" in data
    assert isinstance(data["containers"], list)
    assert "options" in data


@pytest.mark.asyncio
async def test_volume_detail_lists_containers_using_it(async_client: AsyncClient):
    """El detalle nombra los contenedores que usan el volumen.

    `/volumes/{name}` NO incluye campo `Containers`: los nombres hay que
    sacarlos de los `Mounts` del listado de contenedores. Sin esto, el panel
   aba de "En uso (1)" junto a una lista vacía que además afirmaba que se
    podía eliminar sin forzar, cuando el DELETE devuelve 409.
    """
    response = await async_client.get("/api/v1/volumes/datos-app")
    assert response.status_code == 200
    data = response.json()

    assert data["ref_count"] == 1
    assert data["containers"] == ["web-app"], (
        "un volumen con ref_count > 0 debe nombrar sus contenedores"
    )


@pytest.mark.asyncio
async def test_volume_detail_without_containers(async_client: AsyncClient):
    """Un volumen libre no nombra ningún contenedor."""
    response = await async_client.get("/api/v1/volumes/temporal")
    assert response.status_code == 200
    data = response.json()

    assert data["ref_count"] == 0
    assert data["containers"] == []


@pytest.mark.asyncio
async def test_volume_detail_reports_reference_mismatch(async_client: AsyncClient, mock_docker):
    """Si el daemon dice ref_count > 0 pero ningún contenedor lo monta, se expone.

    Es mejor mostrar la discrepancia que un vacío que sugiere que se puede
    borrar sin forzar cuando el DELETE va a fallar con 409.
    """
    # 'datos-app' tiene RefCount=1 en el df, pero se retira el contenedor que lo montaba
    for container in mock_docker.containers_db.values():
        container._mounts = []

    response = await async_client.get("/api/v1/volumes/datos-app")
    assert response.status_code == 200
    data = response.json()

    assert data["ref_count"] == 1
    assert data["containers"] == []


@pytest.mark.asyncio
async def test_volume_detail_not_found(async_client: AsyncClient):
    """Un volumen inexistente devuelve 404 nombrándolo.

    Se comprueba el detalle y no solo el código: una ruta inexistente también
    devuelve 404, así que este test pasaría por el motivo equivocado.
    """
    response = await async_client.get("/api/v1/volumes/no-existe-este-volumen")
    assert response.status_code == 404
    detail = response.json()["detail"]
    assert "no-existe-este-volumen" in detail
    assert "Not Found" not in detail


# --------------------------------------------------------------------------- #
# Borrado
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_delete_volume_success(async_client: AsyncClient):
    """Borrar un volumen no utilizado devuelve 200 con deleted=true."""
    response = await async_client.delete("/api/v1/volumes/temporal")
    assert response.status_code == 200
    data = response.json()

    assert data["name"] == "temporal"
    assert data["deleted"] is True
    assert "message" in data


@pytest.mark.asyncio
async def test_delete_volume_conflict(async_client: AsyncClient):
    """Un volumen en uso devuelve 409 y solo se borra forzando."""
    conflict = await async_client.delete("/api/v1/volumes/datos-app")
    assert conflict.status_code == 409
    assert "detail" in conflict.json()

    forced = await async_client.delete("/api/v1/volumes/datos-app?force=true")
    assert forced.status_code == 200
    assert forced.json()["deleted"] is True


@pytest.mark.asyncio
async def test_delete_volume_not_found(async_client: AsyncClient):
    """Borrar un volumen inexistente devuelve 404 nombrándolo.

    Igual que en el detalle, se verifica el mensaje para no pasar en verde
    porque la ruta simplemente no exista.
    """
    response = await async_client.delete("/api/v1/volumes/no-existe-este-volumen")
    assert response.status_code == 404
    detail = response.json()["detail"]
    assert "no-existe-este-volumen" in detail
    assert "Not Found" not in detail


# --------------------------------------------------------------------------- #
# Limpieza
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_prune_only_removes_unused(async_client: AsyncClient):
    """La limpieza borra los no usados y respeta los que están en uso."""
    response = await async_client.post("/api/v1/volumes/prune")
    assert response.status_code == 200
    data = response.json()

    deleted = data["deleted"]
    assert "temporal" in deleted
    assert ANON_A in deleted
    assert "datos-app" not in deleted, "un volumen con ref_count > 0 no puede eliminarse"
    assert data["bytes_reclaimed"] > 0


@pytest.mark.asyncio
async def test_prune_reports_reclaimed_bytes(async_client: AsyncClient):
    """Los bytes recuperados se calculan con el tamaño que informa el daemon."""
    response = await async_client.post("/api/v1/volumes/prune")
    data = response.json()

    # temporal (5 MiB) + anónimo (48505107) = 53747987
    assert data["bytes_reclaimed"] == 53747987
    assert "message" in data
