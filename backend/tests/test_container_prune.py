# SPDX-License-Identifier: AGPL-3.0-or-later
"""La limpieza de contenedores parados (SPEC-21).

Aquí el preaviso tiene **dos fuentes** y no una, y es el punto que más se
-equivoca al implementarlo:

- **Qué contenedores están parados** sale de `GET /containers/json`.
- **Cuánto ocupan** sólo está en `GET /system/df` → `Containers[]` → `SizeRw`.
  En `/containers/json` la clave **no existe** (medido en el daemon 29.8.2: `None`).

Y si el `df` no responde, el preaviso responde `503` en vez de decir «0 bytes»,
que sería una afirmación sobre el disco del host que el panel no puede sostener.
Es el mismo `usage_known` de SPEC-08 aplicado a otro sitio.
"""

import pytest
from aiodocker.exceptions import DockerError
from fastapi import HTTPException

from app.services.container_service import ContainerService

pytestmark = pytest.mark.asyncio


def _df_contenedores() -> dict:
    return {
        "Containers": [
            {"Id": "a4d168477d28", "Names": ["/peluchito"], "SizeRw": 131_072, "State": "exited"},
            {"Id": "cb6cde7c42a5", "Names": ["/full-editor-db"], "SizeRw": 24_576, "State": "exited"},
        ]
    }


@pytest.fixture
def docker_lectura(mock_docker):
    """Un doble con un contenedor en marcha y dos parados, y un `df` que sí
    trae los tamaños."""

    class Contenedor:
        def __init__(self, det: dict) -> None:
            self._container = det

    async def listar(*_a, **_kw):
        return [
            Contenedor({"Id": "aa", "Names": ["/vivo"], "State": "running"}),
            Contenedor({"Id": "a4d168477d28", "Names": ["/peluchito"], "State": "exited"}),
            Contenedor({"Id": "cb6cde7c42a5", "Names": ["/full-editor-db"], "State": "exited"}),
        ]

    async def prune(**_kw):
        prune.llamadas += 1
        return {"ContainersDeleted": ["a4d168477d28", "cb6cde7c42a5"], "SpaceReclaimed": 155_648}

    prune.llamadas = 0

    async def query_json(ruta, **_kw):
        if ruta == "system/df":
            return _df_contenedores()
        raise AssertionError(f"Ruta inesperada: {ruta}")

    mock_docker.containers.list = _Contador(listar)
    mock_docker.containers.prune = _Contador(prune)
    mock_docker._query_json = query_json
    return mock_docker


class _Contador:
    def __init__(self, side_effect) -> None:
        self._side_effect = side_effect
        self.llamadas = 0

    def __call__(self, *a, **kw):
        self.llamadas += 1
        return _Awaitable(self._side_effect(*a, **kw))


class _Awaitable:
    def __init__(self, coro) -> None:
        self._coro = coro

    def __await__(self):
        return self._coro.__await__()


# --- El preaviso ------------------------------------------------------------


async def test_el_preaviso_solo_cuenta_parados(docker_lectura):
    p = await ContainerService.preview_prune(docker=docker_lectura)

    assert p.stopped_count == 2
    assert "vivo" not in p.stopped_names


async def test_el_preaviso_usa_nombres_y_no_ids(docker_lectura):
    """Un id no lo reconoce nadie, y un contenedor parado puede tener dentro lo
    único que hacía que mereciera la pena pararlo."""
    p = await ContainerService.preview_prune(docker=docker_lectura)

    assert sorted(p.stopped_names) == ["full-editor-db", "peluchito"]
    assert "a4d168477d28" not in p.stopped_names


async def test_los_bytes_salen_del_system_df(docker_lectura):
    """De `/containers/json` no salen: la clave no existe ahí."""
    p = await ContainerService.preview_prune(docker=docker_lectura)

    assert p.stopped_bytes == 131_072 + 24_576


async def test_el_preaviso_no_borra_nada(docker_lectura):
    await ContainerService.preview_prune(docker=docker_lectura)

    assert docker_lectura.containers.prune.llamadas == 0


async def test_preaviso_sin_parados(docker_lectura):
    class Contenedor:
        def __init__(self, det: dict) -> None:
            self._container = det

    async def solo_vivo(*_a, **_kw):
        return [Contenedor({"Id": "aa", "Names": ["/vivo"], "State": "running"})]

    docker_lectura.containers.list = _Contador(solo_vivo)

    p = await ContainerService.preview_prune(docker=docker_lectura)

    assert p.stopped_count == 0
    assert p.stopped_bytes == 0


async def test_preaviso_sin_df_responde_503(mock_docker):
    """Un `0` aquí significaría «no ocupa nada», que es una afirmación sobre el
    disco del host. Si no se sabe, se dice que no se sabe."""

    class Contenedor:
        def __init__(self, det: dict) -> None:
            self._container = det

    async def listar(*_a, **_kw):
        return [Contenedor({"Id": "aa", "Names": ["/parado"], "State": "exited"})]

    async def df_caido(*_a, **_kw):
        raise DockerError(900, "Cannot connect to Docker Engine")

    mock_docker.containers.list = _Contador(listar)
    mock_docker._query_json = df_caido

    with pytest.raises(HTTPException) as exc:
        await ContainerService.preview_prune(docker=mock_docker)

    assert exc.value.status_code == 503


async def test_preaviso_sin_contenedores_responde_503(mock_docker):
    """Un `df` sin la clave `Containers` tampoco es un `0`: es una forma que no
    se reconoce, y reconocerla por ausencia sería inventar el dato."""

    class Contenedor:
        def __init__(self, det: dict) -> None:
            self._container = det

    async def listar(*_a, **_kw):
        return [Contenedor({"Id": "aa", "Names": ["/parado"], "State": "exited"})]

    async def df_raro(*_a, **_kw):
        return {"otra_cosa": 1}

    mock_docker.containers.list = _Contador(listar)
    mock_docker._query_json = df_raro

    with pytest.raises(HTTPException) as exc:
        await ContainerService.preview_prune(docker=mock_docker)

    assert exc.value.status_code == 503


# --- El prune ---------------------------------------------------------------


async def test_prune_borra_los_parados(docker_lectura):
    r = await ContainerService.prune_containers(docker=docker_lectura)

    assert r.deleted == ["a4d168477d28", "cb6cde7c42a5"]
    assert r.bytes_reclaimed == 155_648
    assert docker_lectura.containers.prune.llamadas == 1


async def test_prune_sin_parados_lo_dice(mock_docker):
    async def prune(**_kw):
        return {"ContainersDeleted": [], "SpaceReclaimed": 0}

    mock_docker.containers.prune = _Contador(prune)

    r = await ContainerService.prune_containers(docker=mock_docker)

    assert r.deleted == []
    assert "nada" in r.message.lower()


async def test_prune_con_docker_error_responde_503(mock_docker):
    async def fallo(**_kw):
        raise DockerError(900, "Cannot connect to Docker Engine")

    mock_docker.containers.prune = _Contador(fallo)

    with pytest.raises(HTTPException) as exc:
        await ContainerService.prune_containers(docker=mock_docker)

    assert exc.value.status_code == 503

# --- Contrato por HTTP (SPEC-21 §3.2) ---------------------------------------


async def test_el_prune_no_es_el_detalle_de_un_contenedor(test_client, mock_docker):
    """`/prune` declarado después de `/{container_id}` haría que este GET fuera el
    detalle de un contenedor llamado «prune»."""
    async def listar(*_a, **_kw):
        return []

    async def df(*_a, **_kw):
        return {"Containers": []}

    mock_docker.containers.list = _Contador(listar)
    mock_docker._query_json = df

    r = test_client.get("/api/v1/containers/prune")

    assert r.status_code == 200
    cuerpo = r.json()
    assert "stopped_count" in cuerpo
    assert "Id" not in cuerpo


async def test_post_a_seco_borra_los_parados(test_client, mock_docker):
    async def prune(**_kw):
        prune.llamadas += 1
        return {"ContainersDeleted": ["a4d168477d28"], "SpaceReclaimed": 131_072}

    prune.llamadas = 0
    mock_docker.containers.prune = _Contador(prune)

    r = test_client.post("/api/v1/containers/prune")

    assert r.status_code == 200
    assert prune.llamadas == 1
    assert r.json()["deleted"] == ["a4d168477d28"]
