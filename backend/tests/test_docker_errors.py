# SPDX-License-Identifier: AGPL-3.0-or-later
"""El status de un `DockerError` no siempre es un código HTTP.

aiodocker levanta `DockerError(900, "Cannot connect to Docker Engine...")` cuando
no puede hablar con el daemon. Ese 900 se colaba tal cual en `HTTPException`, y
uvicorn lo terminaba indexando en `STATUS_LINE[900]`: `KeyError`, respuesta
vacía y `curl: (52) Empty reply from server`.

Es el fallo más probable de todo el panel (dockerd parado, socket con otros
permisos, daemon que reinicia), así que cada endpoint tiene que devolver un 503
limpio en ese caso.
"""

from unittest.mock import MagicMock

import pytest
from aiodocker.exceptions import DockerError
from fastapi import HTTPException
from httpx import AsyncClient

from app.core.docker import docker_error_status

pytestmark = pytest.mark.asyncio


@pytest.mark.parametrize(
    ("status", "esperado"),
    [
        (900, 503),  # el 900 de aiodocker: no pude hablar con el daemon
        (0, 503),  # DockerStreamError: el HTTP fue correcto, el chunk no
        (304, 503),  # 3xx no puede llevar cuerpo de error
        (200, 503),
        (503, 503),
        (500, 500),
        (409, 409),
        (404, 404),
        (400, 400),
        (599, 599),
    ],
)
async def test_status_de_aiodocker_siempre_servible(status, esperado):
    assert docker_error_status(DockerError(status, {"message": "boom"})) == esperado


async def test_status_robusto_ante_basura():
    """Un `status` que no sea un número entero tampoco puede colarse."""
    assert docker_error_status(object()) == 503
    assert docker_error_status(DockerError(True, {"message": "x"})) == 503
    assert docker_error_status(Exception("sin status")) == 503


async def test_error_daemon_caido_da_503_y_no_rompe_la_conexion(
    async_client: AsyncClient, mock_docker
):
    """El escenario real: dockerd no está. Debe ser un 503 legible.

    Antes esto era un 900 que reventaba dentro de uvicorn, así que el cliente no
    recibía NADA: ni 503, ni error, ni cuerpo.
    """
    mock_docker.containers.get.side_effect = DockerError(
        900, "Cannot connect to Docker Engine via unix:///var/run/docker.sock"
    )

    response = await async_client.get("/api/v1/containers/c123")

    assert response.status_code == 503
    assert "Cannot connect" in str(response.json()["detail"])


async def test_el_detalle_es_texto_y_no_un_objeto(async_client: AsyncClient, mock_docker):
    """`DockerError.message` puede ser un dict, y el schema `detail` es `str`.

    Si se pasa tal cual, la respuesta lleva `{"detail": {"message": ...}}` y el
    frontend lo pinta como `[object Object]`.
    """
    mock_docker.containers.get.side_effect = DockerError(404, {"message": "No such container: c123"})

    response = await async_client.get("/api/v1/containers/c123")

    assert response.status_code == 404
    assert isinstance(response.json()["detail"], str)


async def test_ningun_endpoint_devuelve_un_status_invalido(async_client: AsyncClient, mock_docker):
    """Barre los endpoints reales del doble y revisa todos.

    Es la defensa contra que el mismo descuido vuelva colado en otro sitio: si
    alguien escribe `status_code=e.status` otra vez, esta lista se cae.
    """
    rutas = [
        ("GET", "/api/v1/containers"),
        ("GET", "/api/v1/containers/c123"),
        ("POST", "/api/v1/containers/c123/start"),
        ("POST", "/api/v1/containers/c123/stop"),
        ("POST", "/api/v1/containers/c123/restart"),
        ("POST", "/api/v1/containers/c123/pause"),
        ("POST", "/api/v1/containers/c123/unpause"),
        ("POST", "/api/v1/containers/c123/kill"),
        ("DELETE", "/api/v1/containers/c123?force=true"),
        ("GET", "/api/v1/volumes"),
        ("GET", "/api/v1/volumes/datos-app"),
        ("GET", "/api/v1/images"),
        ("GET", "/api/v1/images/nginx:alpine"),
        ("GET", "/api/v1/networks"),
        ("GET", "/api/v1/networks/bridge"),
        ("GET", "/api/v1/system/info"),
        ("GET", "/api/v1/system/df"),
    ]
    for metodo, url in rutas:
        mock_docker.containers.list.side_effect = DockerError(900, "Cannot connect")
        mock_docker.containers.get.side_effect = DockerError(900, "Cannot connect")

        # Los repos de volúmenes, imágenes, redes y sistema son objetos reales
        # del doble, no mocks: hay que sustituirles el método entero.
        async def caido(*_a, **_k):
            raise DockerError(900, "Cannot connect to Docker Engine")

        for repo in (mock_docker.volumes, mock_docker.images, mock_docker.networks):
            repo.list = caido
            repo.get = caido
        mock_docker.system.info = caido
        mock_docker._query_json = caido

        respuesta = await async_client.request(metodo, url)

        status = respuesta.status_code
        # Lo que no puede ser: 900 (el de aiodocker), 0, 1xx y 3xx. Un
        # `HTTPException` con cualquiera de ellos revienta en uvicorn y el
        # cliente se queda sin respuesta.
        assert status != 900, f"{metodo} {url} devolvió el 900 crudo de aiodocker"
        assert 200 <= status < 300 or 400 <= status < 600, (
            f"{metodo} {url} devolvió {status}, que no se puede servir"
        )
        if status >= 400:
            # Y el error tiene que ser legible, no un dict crudo.
            assert isinstance(respuesta.json().get("detail"), str), (
                f"{metodo} {url} devolvió un detail que no es texto"
            )


# --- Cobertura del propio helper -----------------------------------------------


async def test_excepcion_de_http_hereda_el_status_normalizado(mock_docker):
    """El helper se usa igual dentro y fuera de un `except`."""
    try:
        raise DockerError(900, "Cannot connect to Docker Engine")
    except DockerError as e:
        with pytest.raises(HTTPException) as exc:
            raise HTTPException(status_code=docker_error_status(e), detail="x") from e

    assert exc.value.status_code == 503


async def test_el_cliente_de_aiodocker_sigue_siendo_el_que_manda():
    """Si aiodocker cambia su 900 por otra cosa, el helper lo sigue corrigiendo."""
    exc = DockerError(999, "lo que sea")
    assert exc.status == 999
    assert docker_error_status(exc) == 503


async def test_no_se_rompe_con_una_excepcion_que_no_es_docker_error():
    assert docker_error_status(MagicMock(status=404)) == 404
