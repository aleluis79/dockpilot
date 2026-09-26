# SPDX-License-Identifier: AGPL-3.0-or-later
"""Contratos de `/api/v1/system` (SPEC-09)."""

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.asyncio


async def test_system_info_normaliza_info(async_client: AsyncClient):
    """`/system/info` traduce las claves del daemon a nombres estables.

    El daemon usa `ServerVersion`, `MemTotal`, `Driver`...; se verifica el
    contrato de la API, no el volcado crudo.
    """
    response = await async_client.get("/api/v1/system/info")
    assert response.status_code == 200
    data = response.json()

    assert data["server_version"] == "29.8.1"
    assert data["ncpu"] == 12
    assert data["memory_total"] == 32827215872
    assert data["storage_driver"] == "overlayfs"
    assert data["os_type"] == "linux"
    assert data["os_name"] == "Debian GNU/Linux 13 (trixie)"
    assert data["architecture"] == "x86_64"
    assert data["hostname"] == "dockpilot-test"
    assert data["docker_root_dir"] == "/var/lib/docker"
    assert data["containers_total"] == 2
    assert data["containers_running"] == 1
    assert data["containers_stopped"] == 1
    assert data["images_total"] == 2


async def test_system_df_normaliza_los_cuatro_bloques(async_client: AsyncClient):
    """`/system/df` mapea `ImageUsage`/`ContainerUsage`/`VolumeUsage` a ResourceUsage.

    Los agregados vienen en `<X>Usage`, no en los bloques legacy `Images`/
    `Containers`/`Volumes`, que llegan vacíos.
    """
    response = await async_client.get("/api/v1/system/df")
    assert response.status_code == 200
    usage = response.json()

    assert usage["images"] == {
        "total_count": 2,
        "active_count": 1,
        "total_size": 5106255209,
        "reclaimable": 4223809473,
    }
    assert usage["containers"]["total_count"] == 2
    assert usage["containers"]["reclaimable"] == 24576
    assert usage["volumes"]["reclaimable"] == 53747987
    assert usage["layers_size"] == 5106255209
    # `BuildCache` es una lista; el tamaño recuperable es el entero gemelo.
    assert usage["build_cache_size"] == 123456789


async def test_system_df_no_suma_layers_size_al_total_de_imagenes(
    async_client: AsyncClient,
):
    """`layers_size` va aparte: son capas compartidas entre imágenes.

    Sumarlo a `images.total_size` inflaría el espacio de la barra y lo
    contaría dos veces.
    """
    response = await async_client.get("/api/v1/system/df")
    usage = response.json()

    assert usage["layers_size"] == usage["images"]["total_size"]
    assert "layers_size" not in usage["images"]


async def test_system_overview_agrupa_info_y_uso(async_client: AsyncClient):
    """`/system/overview` devuelve los tres bloques en una sola respuesta."""
    response = await async_client.get("/api/v1/system/overview")
    assert response.status_code == 200
    data = response.json()

    assert set(data.keys()) == {"info", "usage", "top_images", "top_volumes"}
    assert data["info"]["server_version"] == "29.8.1"
    assert data["usage"]["images"]["total_count"] == 2


async def test_system_overview_ordena_mayores_consumidores(async_client: AsyncClient):
    """Los mayores consumidores van de mayor a menor y con su tipo."""
    response = await async_client.get("/api/v1/system/overview")
    data = response.json()

    top_images = data["top_images"]
    assert [i["name"] for i in top_images] == [
        "tmp/builder-leftover:latest",
        "postgres:16-alpine",
    ]
    assert all(i["kind"] == "image" for i in top_images)
    assert top_images[0]["size"] > top_images[1]["size"]

    top_volumes = data["top_volumes"]
    assert [v["kind"] for v in top_volumes] == ["volume"] * len(top_volumes)
    assert [v["size"] for v in top_volumes] == sorted(
        (v["size"] for v in top_volumes), reverse=True
    )
    assert top_volumes[0]["name"] == "datos-app"


async def test_system_overview_limita_los_top_consumidores(async_client: AsyncClient):
    """No se devuelven más de 5 entradas por categoría."""
    response = await async_client.get("/api/v1/system/overview")
    data = response.json()

    assert len(data["top_images"]) <= 5
    assert len(data["top_volumes"]) <= 5


async def test_system_info_tolera_claves_ausentes(async_client: AsyncClient, mock_docker):
    """Un daemon que no reporta un campo no debe tumbar la respuesta.

    Se vacían las claves para comprobar que los valores por defecto del schema
    evitan un 500.
    """
    original = mock_docker.system.info

    async def sparse_info():
        data = await original()
        # El daemon devuelve `null` explícito cuando no puede medir algo, y en
        # algunos setups los contadores llegan como texto. Ambos casos deben
        # normalizarse, no reventar la respuesta.
        for key in ("ServerVersion", "MemTotal", "NCPU", "Driver", "OperatingSystem"):
            data[key] = None
        data["Containers"] = "4"
        return data

    mock_docker.system.info = sparse_info

    response = await async_client.get("/api/v1/system/info")
    assert response.status_code == 200
    data = response.json()

    assert data["server_version"] == ""
    assert data["memory_total"] == 0
    assert data["ncpu"] == 0
    assert data["storage_driver"] == ""
    # Un número como texto se convierte, no se descarta.
    assert data["containers_total"] == 4


async def test_system_df_tolera_bloques_ausentes(async_client: AsyncClient, mock_docker):
    """Si falta `ImageUsage`, se devuelven ceros en vez de fallar."""
    original = mock_docker._query_json

    async def sparse_df(endpoint, method="GET", params=None):
        data = await original(endpoint, method, params)
        if endpoint == "system/df":
            data.pop("ImageUsage", None)
            data.pop("BuildCacheUsage", None)
        return data

    mock_docker._query_json = sparse_df

    response = await async_client.get("/api/v1/system/df")
    assert response.status_code == 200
    usage = response.json()

    assert usage["images"]["total_count"] == 0
    assert usage["build_cache_size"] == 0


async def test_system_info_reporta_error_del_daemon(async_client: AsyncClient, mock_docker):
    """Un fallo del daemon se traduce a 503 con un mensaje legible."""
    from aiodocker.exceptions import DockerError

    mock_docker.system.error = DockerError(500, {"message": "cannot connect"})

    response = await async_client.get("/api/v1/system/info")
    assert response.status_code == 503
    assert "información del sistema" in response.json()["detail"]


async def test_system_df_reporta_error_del_daemon(async_client: AsyncClient, mock_docker):
    """Igual para `/system/df`."""
    from aiodocker.exceptions import DockerError

    original = mock_docker._query_json

    async def failing(endpoint, method="GET", params=None):
        if endpoint == "system/df":
            raise DockerError(500, {"message": "df unavailable"})
        return await original(endpoint, method, params)

    mock_docker._query_json = failing

    response = await async_client.get("/api/v1/system/df")
    assert response.status_code == 503
    assert "consumo de disco" in response.json()["detail"]

async def test_system_overview_resuelve_nombres_de_imagen_por_id(
    async_client: AsyncClient, mock_docker
):
    """`ImageUsage.Items` no trae `Names`: el nombre se resuelve por `Id`.

    Comprobado contra el daemon: los items de imagen llegan con `Id`, `Size`,
    `Containers` y `Labels`, pero sin nombre. Sin resolverlo contra
    `/images/json`, la lista de mayores consumidores saldría vacía.
    """
    original = mock_docker._query_json

    async def df_without_names(endpoint, method="GET", params=None):
        data = await original(endpoint, method, params)
        if endpoint == "system/df":
            items = data["ImageUsage"]["Items"]
            # Se quitan los nombres que el doble si traia, como en el daemon real.
            # El primero se resuelve por su etiqueta real; el segundo apunta a una
            # imagen que solo tiene "<none>:<none>" y debe caer al Id corto.
            for item, image_id in zip(items, ["sha256:img1", "sha256:img3"]):
                item.pop("Names", None)
                item["Id"] = image_id
        return data

    mock_docker._query_json = df_without_names

    response = await async_client.get("/api/v1/system/overview")
    assert response.status_code == 200
    top_images = response.json()["top_images"]

    nombres = [i["name"] for i in top_images]
    assert "nginx:alpine" in nombres, (
        "el nombre de la imagen debe resolverse desde /images/json por su Id"
    )
    # img3 solo tiene "<none>:<none>", así que se identifica por su Id corto
    assert "sha256:img3" in nombres  # _short_id conserva el prefijo del digest


async def test_system_overview_usa_id_corto_si_la_imagen_no_se_resuelve(
    async_client: AsyncClient, mock_docker
):
    """Una imagen que no aparece en `/images/json` se identifica por su Id.

    No se descarta: es preferible un identificador poco pretty a esconder un
    consumidor grande de disco.
    """
    original = mock_docker._query_json

    async def df_with_unknown_image(endpoint, method="GET", params=None):
        data = await original(endpoint, method, params)
        if endpoint == "system/df":
            items = data["ImageUsage"]["Items"]
            items[0].pop("Names", None)
            items[0]["Id"] = "sha256:ff00ffee00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff"
        return data

    mock_docker._query_json = df_with_unknown_image

    response = await async_client.get("/api/v1/system/overview")
    top_images = response.json()["top_images"]

    assert "sha256:ff00ffee00ff" in [i["name"] for i in top_images]

async def test_system_overview_lee_el_tamano_de_volumen_desde_usage_data(
    async_client: AsyncClient,
):
    """El tamaño de un volumen vive en `UsageData.Size`, no en `Item.Size`.

    Comprobado contra el daemon: las claves de un item de volumen son
    `CreatedAt`, `Driver`, `Labels`, `Mountpoint`, `Name`, `Options`, `Scope` y
    `UsageData`. Leer `Size` a nivel de item devuelve siempre 0, y el panel
    acabaria mostrando 0 MiB con 460 MB recuperables.
    """
    response = await async_client.get("/api/v1/system/overview")
    top_volumes = response.json()["top_volumes"]
    por_nombre = {v["name"]: v["size"] for v in top_volumes}

    assert por_nombre["datos-app"] == 104857600
    assert por_nombre["temporal"] == 5242880
    # El mayor consumidor va primero
    assert top_volumes[0]["name"] == "datos-app"
    assert top_volumes[0]["size"] == 104857600
    # Ningún tamaño puede quedarse a cero por leer el campo equivocado
    assert all(v["size"] > 0 for v in top_volumes)
