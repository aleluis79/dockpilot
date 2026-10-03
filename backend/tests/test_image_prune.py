# SPDX-License-Identifier: AGPL-3.0-or-later
"""La limpieza de imágenes (SPEC-21).

Dos niveles, y la razón de que sean dos y no uno con una casilla:

- **Sin etiqueta** (`dangling`) es el resultado de un `build` que dejó capas
  viejas. casi siempre no hay forma de recuperarlo salvo volver a descargarlo, y
  ni siquiera se sabe de qué registro.
- **Con etiqueta** es `python:3.12-slim`, `alpine:latest`. Borrarlas funciona, y
  duele: la próxima vez que alguien la pida hay que volver a descargarla.

Y el preaviso **no** se pide al daemon, porque no hay forma de preguntarle qué
borraría un prune sin borrarlo: sale de leer `GET /images/json`. La consecuencia
es que es una lectura que puede fallar, y cuando falla **no** puede devolver una
lista vacía, porque "no sé qué hay" y "no hay nada" son cosas distintas y aquí la
segunda haría pinchar un botón que no tiene nada que limpiar.
"""

import pytest
from aiodocker.exceptions import DockerError

from app.services.image_service import ImageService

pytestmark = pytest.mark.asyncio


@pytest.fixture
def imagenes() -> list[dict]:
    """Las cuatro formas que importa, con las cifras del host de referencia."""
    return [
        # Sin etiqueta y sin uso: la única que la limpieza segura borra.
        {"Id": "sha256:ae21ea6bfe46000000000000000000000000000000000000000000000000ab",
         "RepoTags": [], "Containers": 0, "Size": 806_423_444},
        # Sin etiqueta PERO EN USO: el daemon no la borra. La trampa.
        {"Id": "sha256:1ed1b0e1d76500000000000000000000000000000000000000000000000cd",
         "RepoTags": [], "Containers": 1, "Size": 94_432_874},
        # Con etiqueta y sin uso: la limpieza agresiva.
        {"Id": "sha256:f77ac9e44ae9000000000000000000000000000000000000000000000ef",
         "RepoTags": ["python:3.12-slim"], "Containers": 0, "Size": 179_402_011},
        # Con etiqueta y en uso: ni una ni otra.
        {"Id": "sha256:e013e867e71200000000000000000000000000000000000000000000ab",
         "RepoTags": ["postgres:16-alpine"], "Containers": 1, "Size": 419_579_858},
    ]


@pytest.fixture
def docker_lectura(mock_docker, imagenes):
    """Un doble que sólo lee. `prune` se cuenta aparte para poder afirmar que
    el preaviso no lo llama nunca.

    Los elementos son **dicts planos**, y no es una decisión de estilo:
    `docker.images.list()` devuelve dicts en aiodocker 0.27 (medido), mientras
    que `docker.containers.list()` devuelve objetos `DockerContainer` con los
    datos en `_container`. Un doble que usa la forma del otro fallaría
    soltando un `{}` silencioso, porque `_get_image_dict` cae en su rama de
    "no lo sé" y devuelve un diccionario vacío sin dar ningún error.
    """

    async def listar(*_a, **_kw):
        return list(imagenes)

    async def prune(**_kw):
        prune.llamadas += 1
        prune.filtros.append(_kw.get("filters"))
        return {"ImagesDeleted": [], "SpaceReclaimed": 0}

    prune.llamadas = 0
    prune.filtros = []
    mock_docker.images.list = AsyncMockLike(listar)
    mock_docker.images.prune = AsyncMockLike(prune)
    return mock_docker


class AsyncMockLike:
    """Lo mínimo para poder contar llamadas sin meter `unittest.mock` en las
    aserciones: una función con contador y con filtros."""

    def __init__(self, side_effect):
        self._side_effect = side_effect
        self.llamadas = 0
        self.filtros = []
        self.await_count = 0

    def __call__(self, *a, **kw):
        self.llamadas += 1
        self.await_count += 1
        if kw.get("filters") is not None:
            self.filtros.append(kw["filters"])
        return _Awaitable(self._side_effect(*a, **kw))


class _Awaitable:
    def __init__(self, coro) -> None:
        self._coro = coro

    def __await__(self):
        return self._coro.__await__()


# --- El preaviso ------------------------------------------------------------


async def test_el_preaviso_no_borra_nada(docker_lectura):
    """Un prune es una escritura, y un recuento no puede pedir una escritura."""
    await ImageService.preview_prune(docker=docker_lectura)

    assert docker_lectura.images.prune.llamadas == 0


async def test_cuenta_las_sin_etiqueta_sin_uso(docker_lectura):
    p = await ImageService.preview_prune(docker=docker_lectura)

    assert p.dangling_count == 1
    assert p.dangling_bytes == 806_423_444
    assert p.dangling_ids == ["sha256:ae21ea6bfe46"]


async def test_no_cuenta_una_sin_etiqueta_que_esta_en_uso(docker_lectura):
    """La trampa: `1ed1b0e1d765` no tiene etiqueta y la usa un contenedor, así
    que el daemon no la va a borrar. Contarla sería prometer un borrado que no
    ocurre, y el diálogo mentiría en el número que el usuario está mirando."""
    p = await ImageService.preview_prune(docker=docker_lectura)

    assert "sha256:1ed1b0e1d765" not in p.dangling_ids
    assert p.in_use_dangling == 1


async def test_cuenta_las_con_etiqueta_en_el_nivel_agresivo(docker_lectura):
    p = await ImageService.preview_prune(docker=docker_lectura)

    assert p.tagged_count == 1
    assert p.tagged_refs == ["python:3.12-slim"]
    assert p.tagged_bytes == 179_402_011


async def test_una_imagen_en_uso_no_aparece_en_ninguno_de_los_dos_niveles(docker_lectura):
    p = await ImageService.preview_prune(docker=docker_lectura)

    assert "postgres:16-alpine" not in p.tagged_refs
    assert p.dangling_count + p.tagged_count == 2


async def test_ignora_el_placeholder_none_none(docker_lectura, imagenes):
    """Docker escribe `<none>:<none>` en `RepoTags` en lugar de `[]` según la
    versión. Si no se filtra, una imagen sin etiqueta parece tener una."""
    imagenes[0]["RepoTags"] = ["<none>:<none>"]

    p = await ImageService.preview_prune(docker=docker_lectura)

    assert p.dangling_count == 1
    assert p.tagged_count == 1


async def test_preaviso_sin_imagenes(docker_lectura, imagenes):
    imagenes.clear()

    p = await ImageService.preview_prune(docker=docker_lectura)

    assert p.dangling_count == 0
    assert p.tagged_count == 0


async def test_preaviso_con_daemon_caido_responde_503(mock_docker):
    """Un fallo de la lectura **no** es una lista vacía: si lo fuera, el botón
    diría "no hay nada que limpiar" cuando lo que no se sabe es si hay algo."""
    from aiodocker.exceptions import DockerError

    async def fallo(*_a, **_kw):
        raise DockerError(900, "Cannot connect to Docker Engine")

    mock_docker.images.list = AsyncMockLike(fallo)

    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        await ImageService.preview_prune(docker=mock_docker)

    # 900 no es un código HTTP: traducido, no servido tal cual.
    assert exc.value.status_code == 503


# --- El prune ---------------------------------------------------------------


async def test_el_nivel_seguro_no_manda_filtro(docker_lectura):
    """El default del daemon ya es «sólo las imágenes sin etiqueta», que es lo que
    promete el botón: lo que tiene etiqueta se queda. Mandar `{"dangling": ...}`
    sería lo mismo con más superficie."""
    await ImageService.prune_images(docker=docker_lectura, all_unused=False)

    assert docker_lectura.images.prune.filtros == []


async def test_el_nivel_agresivo_NO_pide_all_al_daemon(docker_lectura):
    """**`all` ya no es un filtro válido de `POST /images/prune`.**

    Medido contra el daemon 29.8.2 (API 1.56): el endpoint acepta `dangling`,
    `label` y `until`, y rechaza `all` y `unused` con `400 invalid filter
    '<nombre>'`. Por eso el nivel agresivo **no** se pide como un prune con
    filtro, sino borrando imagen a imagen. Un test que afirmara lo contrario
    estaría fijando un endpoint que devuelve 400.
    """
    async def delete(*_a, **_kw):
        return []

    docker_lectura.images.delete = AsyncMockLike(delete)

    await ImageService.prune_images(docker=docker_lectura, all_unused=True)

    assert docker_lectura.images.prune.llamadas == 0
    assert docker_lectura.images.prune.filtros == []


async def test_el_nivel_agresivo_borra_cada_imagen_con_etiqueta(docker_lectura):
    borrados: list[str] = []

    async def delete(image_id, **_kw):
        borrados.append(image_id)
        return [{"Untagged": "python:3.12-slim", "Deleted": image_id}]

    docker_lectura.images.delete = AsyncMockLike(delete)

    r = await ImageService.prune_images(docker=docker_lectura, all_unused=True)

    assert len(borrados) == 1
    assert "python:3.12-slim" in r.deleted
    assert r.kept == []


async def test_el_nivel_agresivo_no_toca_lo_que_usa_un_contenedor(docker_lectura):
    borrados: list[str] = []

    async def delete(image_id, **_kw):
        borrados.append(image_id)
        return []

    docker_lectura.images.delete = AsyncMockLike(delete)

    await ImageService.prune_images(docker=docker_lectura, all_unused=True)

    # Sólo hay una con etiqueta y sin uso: la de postgres la usa un contenedor.
    assert len(borrados) == 1
    assert "f77ac" in borrados[0]


async def test_el_nivel_agresivo_informa_de_lo_que_no_pudo(docker_lectura):
    """Un borrado uno a uno puede fallar a medias, y el caso normal es que alguien
    haya arrancado un contenedor con esa imagen entre el preaviso y el botón. Un
    «3 de 6» obligaría a adivinar cuáles."""

    async def delete(image_id, **_kw):
        if "f77ac" in image_id:
            raise DockerError(409, {"message": "conflict: image is being used"})
        return []

    docker_lectura.images.delete = AsyncMockLike(delete)

    r = await ImageService.prune_images(docker=docker_lectura, all_unused=True)

    assert r.kept == ["python:3.12-slim (conflict: image is being used)"]
    assert "siguen ahí" in r.message


async def test_prune_devuelve_los_borrados_y_los_bytes(docker_lectura):
    async def prune(**_kw):
        return {
            "ImagesDeleted": [{"Untagged": "<none>:<none>", "Deleted": "sha256:ae21ea6bfe46"}],
            "SpaceReclaimed": 806_423_444,
        }

    docker_lectura.images.prune = AsyncMockLike(prune)

    r = await ImageService.prune_images(docker=docker_lectura, all_unused=False)

    assert r.bytes_reclaimed == 806_423_444
    assert r.deleted == ["sha256:ae21ea6bfe46"]


async def test_prune_sin_nada_que_borrar_no_dice_que_no_hay_nada_que_limpiar(docker_lectura):
    """El prune sólo sabe qué borró, no qué había: el inventario lo sabe el
    preaviso, que es otro endpoint."""
    async def prune(**_kw):
        return {"ImagesDeleted": [], "SpaceReclaimed": 0}

    docker_lectura.images.prune = AsyncMockLike(prune)

    r = await ImageService.prune_images(docker=docker_lectura, all_unused=False)

    assert r.deleted == []
    assert r.bytes_reclaimed == 0
    assert "nada que limpiar" not in r.message.lower()
    assert "no ha eliminado" in r.message.lower()


async def test_prune_con_docker_error_responde_503(mock_docker):
    """El 900 de aiodocker no es un código HTTP, y aquí no se sirve nada: se
    traduce, como en el resto del panel."""
    from fastapi import HTTPException

    async def fallo(**_kw):
        raise DockerError(900, "Cannot connect to Docker Engine")

    mock_docker.images.prune = AsyncMockLike(fallo)

    with pytest.raises(HTTPException) as exc:
        await ImageService.prune_images(docker=mock_docker, all_unused=False)

    assert exc.value.status_code == 503


async def test_el_nivel_agresivo_con_el_daemon_caido_responde_503(mock_docker):
    """Un borrado uno a uno puede fallar a medias, y eso se informa. Pero si
    **todas** las peticiones fallan y ninguna es un rechazo del daemon, eso no es
    un resultado parcial: es que no se pudo hablar con él, y decir «0 eliminadas,
    6 no se pudieron» escondería una caída detrás de un texto de resumen."""
    from fastapi import HTTPException

    async def listar(*_a, **_kw):
        return [
            {"Id": "sha256:aa", "RepoTags": ["x:1"], "Containers": 0, "Size": 10},
            {"Id": "sha256:bb", "RepoTags": ["y:1"], "Containers": 0, "Size": 20},
        ]

    async def delete(*_a, **_kw):
        raise DockerError(900, "Cannot connect to Docker Engine")

    mock_docker.images.list = AsyncMockLike(listar)
    mock_docker.images.delete = AsyncMockLike(delete)

    with pytest.raises(HTTPException) as exc:
        await ImageService.prune_images(docker=mock_docker, all_unused=True)

    assert exc.value.status_code == 503

# --- Contrato por HTTP (SPEC-21 §3.2) ---------------------------------------


async def test_el_prune_no_es_el_detalle_de_una_imagen(test_client):
    """El fallo que no se ve leyendo el router: `/prune` declarado después de
    `/{image_id}` hace que `GET /images/prune` sea el detalle de una imagen
    llamada «prune», y el 404 hablaría de una imagen que no existe."""
    r = test_client.get("/api/v1/images/prune")

    assert r.status_code == 200
    cuerpo = r.json()
    # El preaviso, no un detalle de imagen.
    assert "dangling_count" in cuerpo
    assert "Id" not in cuerpo


async def test_post_sin_parametros_no_pide_all(test_client, mock_docker):
    """Un `curl -X POST` a secas tiene que ser el nivel seguro. Es el motivo de
    que `all` sea un parámetro de query con default `false` y no del cuerpo.

    `None` en la lista significa que **no se mandó ningún filtro**, y eso es lo
    correcto: el default del daemon ya es borrar sólo las imágenes sin etiqueta.
    """
    filtros: list = []

    async def prune(**kw):
        filtros.append(kw.get("filters"))
        return {"ImagesDeleted": [], "SpaceReclaimed": 0}

    mock_docker.images.prune = AsyncMockLike(prune)

    r = test_client.post("/api/v1/images/prune")

    assert r.status_code == 200
    assert filtros == [None]


async def test_post_con_all_true_borra_una_a_una(test_client, mock_docker):
    """El contrato por HTTP del nivel agresivo: sin prune, con deletes."""
    borrados: list[str] = []

    async def delete(image_id, **_kw):
        borrados.append(image_id)
        return []

    async def prune(**_kw):
        prune.llamadas += 1
        return {"ImagesDeleted": [], "SpaceReclaimed": 0}

    prune.llamadas = 0

    async def listar(*_a, **_kw):
        return [{"Id": "sha256:aa", "RepoTags": ["x:1"], "Containers": 0, "Size": 10}]

    mock_docker.images.list = AsyncMockLike(listar)
    mock_docker.images.prune = AsyncMockLike(prune)
    mock_docker.images.delete = AsyncMockLike(delete)

    r = test_client.post("/api/v1/images/prune?all=true")

    assert r.status_code == 200
    assert prune.llamadas == 0
    assert borrados == ["sha256:aa"]
