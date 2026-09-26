"""Gestión de imágenes: listado, inspección, borrado y descarga por WebSocket (SPEC-07)."""

import pytest
from httpx import AsyncClient
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect


# --------------------------------------------------------------------------- #
# Listado local enriquecido
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_list_local_images_enriched(async_client: AsyncClient):
    """El listado informa de los contenedores que usan cada imagen y de sus digests."""
    response = await async_client.get("/api/v1/images/local")
    assert response.status_code == 200
    data = response.json()

    by_tag = {tag: image for image in data for tag in image["tags"]}
    assert "nginx:alpine" in by_tag
    assert "redis:alpine" in by_tag

    assert by_tag["nginx:alpine"]["containers"] == 0
    assert by_tag["redis:alpine"]["containers"] == 2
    assert by_tag["nginx:alpine"]["repo_digests"] == ["nginx@sha256:aaa1"]
    assert by_tag["redis:alpine"]["repo_digests"] == []


@pytest.mark.asyncio
async def test_list_local_images_excludes_untagged(async_client: AsyncClient):
    """Las imágenes sin tag (<none>:<none>) se excluyen del inventario."""
    response = await async_client.get("/api/v1/images/local")
    data = response.json()

    assert all("<none>" not in tag for image in data for tag in image["tags"])
    assert all("<none>" not in digest for image in data for digest in image["repo_digests"])


# --------------------------------------------------------------------------- #
# Inspección
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_image_detail_success(async_client: AsyncClient):
    """GET /{id} por tag devuelve metadatos, configuración e historial."""
    response = await async_client.get("/api/v1/images/nginx:alpine")
    assert response.status_code == 200
    data = response.json()

    assert data["architecture"] == "amd64"
    assert data["os"] == "linux"
    assert data["layer_count"] == 3
    assert data["entrypoint"] == ["/docker-entrypoint.sh"]
    assert data["cmd"] == ["nginx", "-g", "daemon off;"]
    assert "NGINX_VERSION=1.27" in data["env"]
    assert "80/tcp" in data["exposed_ports"]
    assert data["user"] == "nginx"
    assert len(data["history"]) == 2
    assert data["history"][0]["created_by"].startswith("/bin/sh -c")
    assert data["history"][0]["size"] == 1200


@pytest.mark.asyncio
async def test_image_detail_not_found(async_client: AsyncClient):
    """Una imagen inexistente devuelve 404."""
    response = await async_client.get("/api/v1/images/no-existe-esta-imagen")
    assert response.status_code == 404
    assert "detail" in response.json()


@pytest.mark.asyncio
async def test_image_detail_tolerates_history_failure(async_client: AsyncClient, mock_docker):
    """Si el historial falla, el detalle se sirve igualmente con history vacío."""
    mock_docker.images.history_error_refs = {"nginx:alpine"}

    response = await async_client.get("/api/v1/images/nginx:alpine")
    assert response.status_code == 200
    data = response.json()

    assert data["id"] == "sha256:img1"
    assert data["history"] == []


# --------------------------------------------------------------------------- #
# Borrado
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_delete_image_success(async_client: AsyncClient):
    """Borrar una imagen no utilizada devuelve 200 con deleted=true."""
    response = await async_client.delete("/api/v1/images/nginx:alpine")
    assert response.status_code == 200
    data = response.json()

    # El id devuelto es la referencia solicitada, no el ID resuelto: evitaría
    # una llamada extra al daemon solo para eso.
    assert data["id"] == "nginx:alpine"
    assert data["deleted"] is True
    # nginx:latest queda sin referenciar: el usuario debe saber por qué no baja el espacio
    assert data["untagged"] == ["nginx:latest"]
    assert "message" in data


@pytest.mark.asyncio
async def test_delete_image_conflict(async_client: AsyncClient):
    """Una imagen en uso devuelve 409 y solo se borra forzando."""
    conflict = await async_client.delete("/api/v1/images/redis:alpine")
    assert conflict.status_code == 409
    assert "detail" in conflict.json()

    forced = await async_client.delete("/api/v1/images/redis:alpine?force=true")
    assert forced.status_code == 200
    assert forced.json()["deleted"] is True


@pytest.mark.asyncio
async def test_delete_image_not_found(async_client: AsyncClient):
    """Borrar una imagen inexistente devuelve 404."""
    response = await async_client.delete("/api/v1/images/no-existe-esta-imagen")
    assert response.status_code == 404


# --------------------------------------------------------------------------- #
# WebSocket de descarga
# --------------------------------------------------------------------------- #
def test_ws_pull_streams_progress(test_client: TestClient):
    """La descarga emite start, una capa por evento de progreso y finally done."""
    with test_client.websocket_connect("/ws/images/pull?image=alpine:3.20") as ws:
        start = ws.receive_json()
        assert start["type"] == "start"
        assert start["image"] == "alpine:3.20"

        statuses = []
        while True:
            message = ws.receive_json()
            if message["type"] == "done":
                assert message["image"] == "alpine:3.20"
                assert message["id"]
                break
            # El digest se emite como mensaje propio, no como capa
            assert message["type"] in ("layer", "digest"), message
            if message["type"] == "layer":
                statuses.append(message["status"])

        assert "Pulling fs layer" in statuses
        assert "Downloading" in statuses
        assert "Pull complete" in statuses


def test_ws_pull_reports_layer_progress_fields(test_client: TestClient):
    """Los mensajes de capa traducen progressDetail del daemon a current/total."""
    with test_client.websocket_connect("/ws/images/pull?image=alpine:3.20") as ws:
        ws.receive_json()  # start

        downloading = None
        for _ in range(12):
            message = ws.receive_json()
            if message.get("status") == "Downloading":
                downloading = message
                break
            if message["type"] == "done":
                break

        assert downloading is not None
        assert downloading["type"] == "layer"
        assert downloading["id"] == "4f55086f7dd0"
        assert downloading["current"] == 1024
        assert downloading["total"] == 4096


def test_ws_pull_emits_digest(test_client: TestClient):
    """El digest de la imagen se emite como mensaje propio."""
    with test_client.websocket_connect("/ws/images/pull?image=alpine:3.20") as ws:
        ws.receive_json()  # start

        digest = None
        for _ in range(15):
            message = ws.receive_json()
            if message["type"] == "digest":
                digest = message
                break
            if message["type"] == "done":
                break

        assert digest is not None
        assert digest["digest"].startswith("sha256:")


def test_ws_pull_invalid_reference(test_client: TestClient):
    """Una referencia malformada produce error 400 sin contactar con Docker."""
    with test_client.websocket_connect("/ws/images/pull?image=nginx%20alpine") as ws:
        error = ws.receive_json()
        assert error["type"] == "error"
        assert error["code"] == 400
        assert "message" in error


def test_ws_pull_registry_error(test_client: TestClient):
    """Un repositorio inexistente se traduce a error 404 y el socket cierra limpio.

    El cierre es 1000 y no un código de error: el cliente debe poder distinguir
    "la descarga falló" de "se cortó la conexión".
    """
    with test_client.websocket_connect("/ws/images/pull?image=no-existe-este-repo-xyz123") as ws:
        assert ws.receive_json()["type"] == "start"

        error = None
        for _ in range(12):
            message = ws.receive_json()
            if message["type"] == "error":
                error = message
                break

        assert error is not None
        assert error["code"] == 404
        assert "pull access denied" in error["message"]

        # Tras el error, el servidor cierra; el cliente lo percibe al leer
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()

    assert exc.value.code == 1000


def test_ws_pull_normalizes_missing_tag(test_client: TestClient):
    """Una referencia sin tag se normaliza a :latest antes de descargar."""
    with test_client.websocket_connect("/ws/images/pull?image=alpine") as ws:
        start = ws.receive_json()
        assert start["type"] == "start"
        assert start["image"] == "alpine:latest"
