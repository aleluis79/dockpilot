# SPDX-License-Identifier: AGPL-3.0-or-later
import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_create_container_minimal(async_client: AsyncClient):
    """Escenario: Creación básica de contenedor con auto-arranque."""
    payload = {
        "image": "nginx:alpine",
        "name": "my-web-app",
        "start_now": True,
    }
    response = await async_client.post("/api/v1/containers", json=payload)
    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "my-web-app"
    assert data["image"] == "nginx:alpine"
    assert data["started"] is True
    assert data["status"] == "running"
    assert "id" in data


@pytest.mark.asyncio
async def test_create_container_with_ports_and_env(async_client: AsyncClient):
    """Escenario: Creación con mapeo de puertos y variables de entorno."""
    payload = {
        "image": "postgres:16-alpine",
        "name": "my-postgres",
        "ports": [
            {"host_port": 5432, "container_port": 5432, "protocol": "tcp"}
        ],
        "env": {
            "POSTGRES_PASSWORD": "secretpassword",
            "POSTGRES_USER": "admin",
        },
        "volumes": [
            {"host_path": "/tmp/pgdata", "container_path": "/var/lib/postgresql/data", "mode": "rw"}
        ],
        "start_now": True,
    }
    response = await async_client.post("/api/v1/containers", json=payload)
    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "my-postgres"
    assert data["started"] is True


@pytest.mark.asyncio
async def test_create_container_without_start(async_client: AsyncClient):
    """Creación sin arranque automático."""
    payload = {
        "image": "redis:alpine",
        "name": "my-redis-cache",
        "start_now": False,
    }
    response = await async_client.post("/api/v1/containers", json=payload)
    assert response.status_code == 201
    data = response.json()
    assert data["started"] is False
    assert data["status"] == "created"


@pytest.mark.asyncio
async def test_create_container_name_conflict(async_client: AsyncClient):
    """Escenario: Conflicto por nombre de contenedor duplicado."""
    payload = {
        "image": "nginx:alpine",
        "name": "web-app",  # Ya existe en conftest.py ("c123": "/web-app")
        "start_now": True,
    }
    response = await async_client.post("/api/v1/containers", json=payload)
    assert response.status_code == 409
    assert "detail" in response.json()


# --- El contenedor que se crea pero no arranca no puede quedarse ahí ------------


@pytest.mark.asyncio
async def test_un_start_fallido_no_deja_contenedores_huerfanos(async_client: AsyncClient, mock_docker):
    """Si `start()` falla, el contenedor ya creado se borra.

    El caso real es el puerto ya ocupado: el daemon creaba el contenedor y
    fallaba al arrancarlo. El usuario recibía un 500 y le aparecía un contenedor
    en estado `created` que no había pedido, que luego contaba en el listado, en
    el `/system/df` y que un prune se podía llevar.
    """
    from aiodocker.exceptions import DockerError

    creados: list[str] = []
    borrados: list[str] = []

    original_create = mock_docker.containers.create

    async def create(config, name=None):
        contenedor = await original_create(config=config, name=name)
        creados.append(contenedor.id)

        async def start():
            raise DockerError(
                500,
                {
                    "message": (
                        "failed to set up container networking: "
                        "Bind for 0.0.0.0:8080 failed: port is already allocated"
                    )
                },
            )

        async def delete(force=False, v=False):
            borrados.append(contenedor.id)

        contenedor.start = start
        contenedor.delete = delete
        return contenedor

    mock_docker.containers.create = create

    response = await async_client.post(
        "/api/v1/containers",
        json={"image": "nginx:alpine", "name": "con-puerto-ocupado", "start_now": True},
    )

    assert response.status_code >= 400
    assert len(creados) == 1, "el contenedor sí llegó a crearse"
    assert borrados == creados, "el contenedor huérfano no se borró"


@pytest.mark.asyncio
async def test_el_borrado_del_huerfano_no_tapa_el_error_original(async_client: AsyncClient, mock_docker):
    """Si el borrado también falla, el error que ve el usuario es el del start."""
    from aiodocker.exceptions import DockerError

    original_create = mock_docker.containers.create

    async def create(config, name=None):
        contenedor = await original_create(config=config, name=name)

        async def start():
            raise DockerError(500, {"message": "port is already allocated"})

        async def delete(force=False, v=False):
            raise DockerError(500, {"message": "no se puede borrar"})

        contenedor.start = start
        contenedor.delete = delete
        return contenedor

    mock_docker.containers.create = create

    response = await async_client.post(
        "/api/v1/containers",
        json={"image": "nginx:alpine", "name": "otro", "start_now": True},
    )

    assert response.status_code >= 400
    assert "already allocated" in str(response.json()["detail"])


@pytest.mark.asyncio
async def test_sin_start_now_no_se_borra_nada(async_client: AsyncClient, mock_docker):
    """Crear sin arrancar es una petición válida: no hay nada que limpiar."""
    response = await async_client.post(
        "/api/v1/containers",
        json={"image": "nginx:alpine", "name": "solo-creado", "start_now": False},
    )

    assert response.status_code == 201
    assert response.json()["status"] == "created"


# --- El comando se parte como lo haría una shell -------------------------------


@pytest.mark.asyncio
async def test_el_command_respeta_las_comillas(async_client: AsyncClient, mock_docker):
    """`str.split()` rompía los argumentos entrecomillados.

    `python -c "print(1)"` se convertía en `['python', '-c', '"print(1)"']`: la
    comilla iba dentro del argumento y python la receive como parte del código.
    """
    capturado: dict = {}
    original_create = mock_docker.containers.create

    async def create(config, name=None):
        capturado["cmd"] = config.get("Cmd")
        return await original_create(config=config, name=name)

    mock_docker.containers.create = create

    response = await async_client.post(
        "/api/v1/containers",
        json={
            "image": "nginx:alpine",
            "name": "con-comando",
            "command": 'sh -c "echo hola && echo adios"',
            "start_now": False,
        },
    )

    assert response.status_code == 201
    assert capturado["cmd"] == ["sh", "-c", "echo hola && echo adios"]


@pytest.mark.asyncio
async def test_el_command_entrecomillado_mal_pide_un_400(async_client: AsyncClient):
    """Comillas sin cerrar es un error del usuario, no un 500."""
    response = await async_client.post(
        "/api/v1/containers",
        json={"image": "nginx:alpine", "name": "comillas-rotas", "command": 'sh -c "sin cerrar'},
    )

    assert response.status_code == 400


# --- La referencia de imagen se valida ----------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("imagen", ["", "   ", "imagen con espacios", "mal@ref@sha256:xx"])
async def test_una_referencia_de_imagen_invalida_da_400(async_client: AsyncClient, imagen):
    """El canal WebSocket de descarga ya validaba esto; el REST no.

    La misma operación validada por un lado y sin validar por el otro hacía que
    la referencia llegara tal cual a `images.inspect` y `images.pull`.
    """
    response = await async_client.post("/api/v1/containers", json={"image": imagen, "name": "x"})

    assert response.status_code == 400


@pytest.mark.asyncio
async def test_una_imagen_sin_tag_se_normaliza_como_hace_docker(async_client: AsyncClient):
    """Igual que `docker pull`: sin tag, `latest`."""
    response = await async_client.post(
        "/api/v1/containers", json={"image": "nginx", "name": "sin-tag", "start_now": False}
    )

    assert response.status_code == 201
    assert response.json()["image"] == "nginx:latest"
