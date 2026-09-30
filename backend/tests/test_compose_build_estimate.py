# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests de la estimación del coste de `build` (SPEC-15).

El propósito es que el usuario sepa lo que va a costar antes de arrancar. En el
host de referencia un contexto son 393 MB y 19 000 ficheros, así que la
estimación tiene que ser rápida y decir la verdad.

Ninguno construye nada: se mide el directorio y nada más.
"""

import os

import pytest

from app.services.compose_service import _estimar_build

pytestmark = pytest.mark.asyncio


@pytest.fixture
def compose(tmp_path):
    """Un compose file en `tmp_path` y su directorio, que es la base del contexto."""
    archivo = tmp_path / "docker-compose.yml"
    archivo.write_text("services: {}\n")
    return archivo


def _ctx(compose, nombre="app"):
    """Crea el directorio de contexto y devuelve el `build` que lo apunta.

    Devuelve el `build` y no solo la ruta porque si no, un test puede crear `app/`
    y medir `.` sin que nada lo impida: el padre contiene además el propio
    `docker-compose.yml` y las cifras no cuadran sin que se note por qué.
    """
    d = compose.parent / nombre
    d.mkdir(parents=True, exist_ok=True)
    return {"context": f"./{nombre}"}, d


# --- Resolución del contexto ---------------------------------------------------


async def test_el_contexto_relativo_se_resuelve_contra_el_archivo(compose):
    """Es la regla de compose: `context` es relativo al archivo, no al cwd.

    Resolverlo contra el directorio de trabajo del backend daría otra ruta
    distinta en cada máquina, y el peso que se muestra sería el de otro sitio.
    """
    build, d = _ctx(compose, "backend")
    (d / "main.py").write_text("x" * 10)

    estimacion = _estimar_build(build, compose)

    assert estimacion.context == str(d)


async def test_un_contexto_absoluto_se_deja_como_esta(compose, tmp_path):
    fuera = tmp_path.parent / "contexto-absoluto"
    fuera.mkdir(exist_ok=True)
    try:
        estimacion = _estimar_build({"context": str(fuera)}, compose)
        assert estimacion.context == str(fuera)
    finally:
        fuera.rmdir()


async def test_sin_context_se_toma_el_directorio_del_archivo(compose):
    """`build: {dockerfile: X}` sin `context` significa el directorio del archivo."""
    (compose.parent / "main.py").write_text("x" * 5)

    estimacion = _estimar_build({"dockerfile": "Dockerfile"}, compose)

    assert estimacion.context == str(compose.parent)


async def test_context_vacio_se_trata_como_el_directorio_del_archivo(compose):
    estimacion = _estimar_build({"context": ""}, compose)

    assert estimacion.context == str(compose.parent)


# --- Peso y recuento -----------------------------------------------------------


async def test_estima_peso_y_numero_de_ficheros(compose):
    build, d = _ctx(compose)
    (d / "a.txt").write_bytes(b"x" * 100)
    (d / "b.txt").write_bytes(b"x" * 200)
    (d / "sub").mkdir()
    (d / "sub" / "c.txt").write_bytes(b"x" * 300)

    estimacion = _estimar_build(build, compose)

    assert estimacion.bytes_aprox == 600
    assert estimacion.ficheros_aprox == 3
    assert estimacion.truncado is False
    assert estimacion.error is None


async def test_no_aplica_dockerignore_y_el_error_no_es_mudo(compose):
    """La estimación **sobreestima** a propósito, y el nombre lo declara.

    Aplicar `.dockerignore` obligaría a reimplementar su lenguaje de patrones, que
    es un gitignore. Si la cifra no cuadra, tiene que ser porque el panel no filtra,
    y eso se dice en el nombre del campo y en el diálogo, no callando.
    """
    build, d = _ctx(compose)
    (d / ".dockerignore").write_text("*\n!docker-compose.yml\n")
    (d / "node_modules").mkdir()
    (d / "node_modules" / "grande.bin").write_bytes(b"x" * 5000)
    (d / "main.py").write_bytes(b"x" * 10)

    estimacion = _estimar_build(build, compose)

    # Cuenta los 5 000 bytes que dockerignore excluiría. Es la decisión de diseño:
    # sobreestimar hace que el usuario pregunte; subestimar le sorprende.
    assert estimacion.bytes_aprox >= 5010
    assert estimacion.error is None


async def test_contexto_inexistente_informa_error_en_vez_de_cero(compose):
    """Un 0 mudo se lee como "no pesa", y es un peso enorme y desconocido."""
    estimacion = _estimar_build({"context": "./no-existe"}, compose)

    assert estimacion.error is not None
    assert "no existe" in estimacion.error.lower()
    assert estimacion.bytes_aprox == 0
    assert estimacion.ficheros_aprox == 0


async def test_un_contexto_que_es_un_fichero_no_se_mide(compose):
    (compose.parent / "contexto.txt").write_text("soy un fichero")

    estimacion = _estimar_build({"context": "./contexto.txt"}, compose)

    assert estimacion.error is not None
    assert "directorio" in estimacion.error.lower()


async def test_un_contexto_que_es_una_cadena_lista_se_acepta(compose):
    """`build: ./ctx` es forma corta y válida; no viene como mapa."""
    build, d = _ctx(compose, "ctx")
    (d / "a").write_bytes(b"x" * 42)

    estimacion = _estimar_build(build["context"], compose)

    assert estimacion.context == str(d)
    assert estimacion.bytes_aprox == 42


async def test_un_build_invalido_no_revienta_el_plan(compose):
    """`build: 3` es basura, pero el plan entero no puede caer por ello."""
    estimacion = _estimar_build(3, compose)

    assert estimacion.error is not None


# --- Tope y casos raros --------------------------------------------------------


async def test_trunca_al_tope_de_ficheros(compose, monkeypatch):
    from app.core import config

    build, d = _ctx(compose)
    for i in range(10):
        (d / f"f{i}.txt").write_bytes(b"x" * 10)
    monkeypatch.setattr(config.settings, "COMPOSE_BUILD_ESTIMATE_MAX_FILES", 4)

    estimacion = _estimar_build(build, compose)

    assert estimacion.truncado is True
    assert estimacion.ficheros_aprox == 4
    # El tamaño es parcial, pero parcial de verdad: sale de lo recorrido.
    assert estimacion.bytes_aprox == 40


async def test_no_sigue_enlaces_simetricos(compose):
    """Un symlink dentro del contexto puede apuntar al mismo contexto.

    Seguirlo mide dos veces lo mismo, o peor, entra en un bucle. Compose no lo
    sigue al calcular el contexto, así que aquí tampoco.
    """
    build, d = _ctx(compose, "app")
    (d / "a.txt").write_bytes(b"x" * 100)
    fuera = compose.parent / "otro"
    fuera.mkdir()
    (fuera / "b.txt").write_bytes(b"x" * 900)
    (d / "enlace").symlink_to(fuera, target_is_directory=True)

    estimacion = _estimar_build(build, compose)

    assert estimacion.ficheros_aprox == 1
    assert estimacion.bytes_aprox == 100


async def test_un_enlace_simbolico_a_un_fichero_no_se_cuenta(compose):
    build, d = _ctx(compose)
    (d / "real.txt").write_bytes(b"x" * 10)
    fuera = compose.parent / "grande.bin"
    fuera.write_bytes(b"x" * 5000)
    (d / "corto.txt").symlink_to(fuera)

    estimacion = _estimar_build(build, compose)

    assert estimacion.ficheros_aprox == 1
    assert estimacion.bytes_aprox == 10


async def test_permiso_denegado_no_rompe_la_estimacion(compose):
    """Un directorio que no se puede leer se salta, y se sigue contando el resto."""
    build, d = _ctx(compose)
    (d / "legible.txt").write_bytes(b"x" * 10)
    cerrado = d / "cerrado"
    cerrado.mkdir()
    (cerrado / "x").write_bytes(b"x" * 999)
    os.chmod(cerrado, 0o000)
    try:
        estimacion = _estimar_build(build, compose)
    finally:
        os.chmod(cerrado, 0o755)

    assert estimacion.ficheros_aprox >= 1
    assert estimacion.error is None


async def test_un_contexto_vacio_da_cero_sin_error(compose):
    """Un directorio sin ficheros es 0 y no es un error: sí se ha podido medir."""
    build, d = _ctx(compose)
    d.rmdir()
    d.mkdir()

    estimacion = _estimar_build(build, compose)

    assert estimacion.bytes_aprox == 0
    assert estimacion.error is None
    assert estimacion.truncado is False
