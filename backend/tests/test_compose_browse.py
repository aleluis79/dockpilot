# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests del explorador de archivos compose (SPEC-14).

Ninguno habla con Docker: el explorador solo lee nombres del disco, y que el
test lo demuestre es parte de su valor. La raíz de todos los casos es `tmp_path`,
así que la suite no depende del disco real del host ni puede salirse de él.

Los casos de confinamiento son los que importan aquí. Un `..` y un enlace
simbólico son las dos formas de convertir un selector de ficheros en un
explorador de tu disco entero, y las dos se comprueban con ficheros de verdad.
"""

import os

import pytest
from httpx import ASGITransport, AsyncClient

from app.core.docker import get_docker
from app.main import app

pytestmark = pytest.mark.asyncio


# --- Utilidades ----------------------------------------------------------------


@pytest.fixture
def raiz(tmp_path):
    """Directorio raíz del explorador, aislado por test."""
    return tmp_path


@pytest.fixture
def browse_client(raiz, monkeypatch):
    """Cliente HTTP del endpoint de exploración, con la raíz en `tmp_path`.

    Se monkeypatchea `settings`, que es de donde la implementación debe leer la
    raíz: si se leyera una variable de entorno directamente, el test pasaría sin
    ejercitar la ruta que se usa en producción.
    """
    from app.core import config

    monkeypatch.setattr(config.settings, "COMPOSE_BROWSE_ROOT", str(raiz))
    app.dependency_overrides[get_docker] = lambda: None
    transport = ASGITransport(app=app)
    yield AsyncClient(transport=transport, base_url="http://test")
    app.dependency_overrides.clear()


async def _browse(client, path):
    return await client.get("/api/v1/compose/browse", params={"path": str(path)})


def _nombres(payload):
    return {entrada["name"] for entrada in payload["entries"]}


def _rutas(payload):
    return {entrada["path"] for entrada in payload["entries"]}


# --- Listado -------------------------------------------------------------------


async def test_lista_directorios_y_ficheros_compose(browse_client, raiz):
    (raiz / "sica").mkdir()
    (raiz / "sica" / "docker-compose.yml").write_text("services: {}\n")
    (raiz / "notas.md").write_text("no es compose")

    respuesta = await _browse(browse_client, raiz)

    assert respuesta.status_code == 200
    cuerpo = respuesta.json()
    assert "sica" in _nombres(cuerpo)
    assert "notas.md" not in _nombres(cuerpo)


async def test_los_ficheros_que_no_son_yaml_no_aparecen(browse_client, raiz):
    """Compose no aceptaría un `Dockerfile` ni un `.md`, así que tampoco se listan."""
    (raiz / "Dockerfile").write_text("FROM alpine")
    (raiz / "notas.md").write_text("nada")
    (raiz / "config.json").write_text("{}")
    (raiz / "docker-compose.yml").write_text("services: {}\n")

    cuerpo = (await _browse(browse_client, raiz)).json()

    assert _nombres(cuerpo) == {"docker-compose.yml"}


async def test_marca_los_directorios_como_directorios(browse_client, raiz):
    (raiz / "sica").mkdir()
    (raiz / "docker-compose.yml").write_text("services: {}\n")

    cuerpo = (await _browse(browse_client, raiz)).json()
    por_nombre = {e["name"]: e for e in cuerpo["entries"]}

    assert por_nombre["sica"]["kind"] == "dir"
    assert por_nombre["docker-compose.yml"]["kind"] == "file"


async def test_devuelve_la_ruta_absoluta_de_cada_entrada(browse_client, raiz):
    """El frontend rellena el campo con `path`, así que tiene que venir completo."""
    (raiz / "sica").mkdir()
    (raiz / "sica" / "docker-compose.yml").write_text("services: {}\n")

    arriba = (await _browse(browse_client, raiz)).json()
    abajo = (await _browse(browse_client, raiz / "sica")).json()

    assert str(raiz / "sica") in _rutas(arriba)
    assert str(raiz / "sica" / "docker-compose.yml") in _rutas(abajo)


async def test_devuelve_el_tamano_del_fichero(browse_client, raiz):
    (raiz / "docker-compose.yml").write_text("services: {}\n")

    cuerpo = (await _browse(browse_client, raiz)).json()
    entrada = cuerpo["entries"][0]

    assert entrada["size"] > 0


# --- Orden ---------------------------------------------------------------------


async def test_los_ficheros_compose_van_primero(browse_client, raiz):
    (raiz / "stack.yml").write_text("services: {}\n")
    (raiz / "otro.yml").write_text("services: {}\n")
    (raiz / "docker-compose.yml").write_text("services: {}\n")

    cuerpo = (await _browse(browse_client, raiz)).json()
    orden = [e["name"] for e in cuerpo["entries"]]

    assert orden.index("docker-compose.yml") < orden.index("stack.yml")
    assert cuerpo["entries"][0]["es_compose"] is True


async def test_reconoce_los_otros_nombres_de_compose(browse_client, raiz):
    for nombre in ("compose.yml", "compose.yaml", "docker-compose.prod.yaml", "mi-compose.yml"):
        (raiz / nombre).write_text("services: {}\n")
    (raiz / "dependencias.yml").write_text("[]")

    cuerpo = (await _browse(browse_client, raiz)).json()
    marcados = {e["name"] for e in cuerpo["entries"] if e["es_compose"]}

    assert marcados == {"compose.yml", "compose.yaml", "docker-compose.prod.yaml", "mi-compose.yml"}


async def test_un_yaml_con_nombre_poco_habitual_sigue_alcanzable(browse_client, raiz):
    """`stack.yml` es un compose file válido: no se filtra, se ordena.

    Filtrar por nombre dejaría fuera proyectos reales, que es el problema que la
    spec viene a resolver.
    """
    (raiz / "stack.yml").write_text("services: {}\n")

    cuerpo = (await _browse(browse_client, raiz)).json()

    assert "stack.yml" in _nombres(cuerpo)
    assert cuerpo["entries"][0]["es_compose"] is False


async def test_los_directorios_van_antes_que_los_ficheros(browse_client, raiz):
    """Los directorios son los que hacen falta para navegar, y son los que se cortan."""
    (raiz / "zzz").mkdir()
    (raiz / "aaa.yml").write_text("services: {}\n")

    cuerpo = (await _browse(browse_client, raiz)).json()

    assert cuerpo["entries"][0]["name"] == "zzz"


# --- Navegación ----------------------------------------------------------------


async def test_en_la_raiz_no_hay_padre_para_subir(browse_client, raiz):
    cuerpo = (await _browse(browse_client, raiz)).json()

    assert cuerpo["parent"] is None


async def test_sube_al_padre_hasta_la_raiz(browse_client, raiz):
    (raiz / "proyectos" / "sica").mkdir(parents=True)
    (raiz / "proyectos" / "sica" / "docker-compose.yml").write_text("services: {}\n")

    sica = (await _browse(browse_client, raiz / "proyectos" / "sica")).json()
    proyectos = (await _browse(browse_client, raiz / "proyectos")).json()
    inicio = (await _browse(browse_client, raiz)).json()

    assert sica["parent"] == str(raiz / "proyectos")
    assert proyectos["parent"] == str(raiz)
    assert inicio["parent"] is None


async def test_normaliza_un_ruta_con_dos_puntos_dentro_de_la_raiz(browse_client, raiz):
    """`..` que no sale de la raíz es una forma válida de escribir la misma ruta."""
    (raiz / "sica").mkdir()

    respuesta = await _browse(browse_client, raiz / "sica" / ".." / "sica")

    assert respuesta.status_code == 200
    assert respuesta.json()["path"] == str(raiz / "sica")


# --- Confinamiento -------------------------------------------------------------


async def test_ruta_relativa_devuelve_400(browse_client, raiz):
    respuesta = await _browse(browse_client, "sica/docker-compose.yml")

    assert respuesta.status_code == 400
    assert "absoluta" in respuesta.json()["detail"].lower()


async def test_dos_puntos_que_sale_de_la_raiz_devuelve_403(browse_client, raiz):
    respuesta = await _browse(browse_client, raiz / ".." / ".." / "etc")

    assert respuesta.status_code == 403


async def test_ruta_absoluta_fuera_de_la_raiz_devuelve_403(browse_client, raiz):
    respuesta = await _browse(browse_client, "/etc")

    assert respuesta.status_code == 403


async def test_el_403_no_revela_si_el_destino_existe(browse_client, raiz):
    """Un `403` que distinguiera "existe pero fuera" de "no existe" filtraría el disco."""
    existe = await _browse(browse_client, "/etc")
    no_existe = await _browse(browse_client, "/no/existe/jamas")

    assert existe.status_code == 403
    assert existe.json()["detail"] == no_existe.json()["detail"]


async def test_la_raiz_no_puede_ser_prefijo_de_otra_ruta(browse_client, tmp_path, monkeypatch):
    """`/home/al` no contiene a `/home/alejandro`, aunque el texto empiece igual.

    Un `str.startswith()` ingenuo aceptaría el segundo caso. Se comprueba con
    directorios reales porque el fallo es de camino, no de lógica.
    """
    from app.core import config

    raiz_corta = tmp_path / "al"
    largo = tmp_path / "alejandro"
    raiz_corta.mkdir()
    (largo / "secreto").mkdir(parents=True)
    monkeypatch.setattr(config.settings, "COMPOSE_BROWSE_ROOT", str(raiz_corta))

    dentro = await _browse(browse_client, raiz_corta)
    fuera = await _browse(browse_client, largo)

    assert dentro.status_code == 200
    assert fuera.status_code == 403


async def test_un_enlace_simetrico_fuera_de_la_raiz_no_se_lista(browse_client, raiz, tmp_path):
    """Un enlace a `~/.ssh` pasa cualquier comparación de texto; el `resolve()` no."""
    fuera = tmp_path.parent / "fuera-de-raiz"
    fuera.mkdir(exist_ok=True)
    (fuera / "id_rsa").write_text("secreto")
    (raiz / "enlace").symlink_to(fuera, target_is_directory=True)
    (raiz / "normal").mkdir()

    cuerpo = (await _browse(browse_client, raiz)).json()

    assert "enlace" not in _nombres(cuerpo)
    assert "normal" in _nombres(cuerpo)
    assert cuerpo["ocultos"] == 1


async def test_no_se_puede_entrar_en_un_enlace_fuera_de_la_raiz(browse_client, raiz, tmp_path):
    """Ocultarlo del listado no basta: la ruta tiene que seguir rechazada."""
    fuera = tmp_path.parent / "fuera-de-raiz-sub"
    fuera.mkdir(exist_ok=True)
    (raiz / "enlace").symlink_to(fuera, target_is_directory=True)

    respuesta = await _browse(browse_client, raiz / "enlace")

    assert respuesta.status_code == 403


async def test_un_enlace_simetrico_dentro_de_la_raiz_sigue_valiendo(browse_client, raiz):
    """No es una criba de enlaces: es un confinamiento. Un enlace interno es legítimo."""
    real = raiz / "real"
    real.mkdir()
    (real / "docker-compose.yml").write_text("services: {}\n")
    (raiz / "atajo").symlink_to(real, target_is_directory=True)

    cuerpo = (await _browse(browse_client, raiz)).json()
    dentro = (await _browse(browse_client, raiz / "atajo")).json()

    assert "atajo" in _nombres(cuerpo)
    assert "docker-compose.yml" in _nombres(dentro)
    assert dentro["ocultos"] == 0


# --- Límite de entradas --------------------------------------------------------


async def test_trunca_y_lo_dice(browse_client, raiz, monkeypatch):
    from app.core import config

    for indice in range(12):
        (raiz / f"dir{indice:02d}").mkdir()
    monkeypatch.setattr(config.settings, "COMPOSE_BROWSE_MAX", 5)

    cuerpo = (await _browse(browse_client, raiz)).json()

    assert len(cuerpo["entries"]) == 5
    assert cuerpo["total"] == 12
    assert cuerpo["truncado"] is True


async def test_un_listado_completo_no_se_declara_truncado(browse_client, raiz):
    (raiz / "docker-compose.yml").write_text("services: {}\n")

    cuerpo = (await _browse(browse_client, raiz)).json()

    assert cuerpo["truncado"] is False
    assert cuerpo["total"] == len(cuerpo["entries"])


async def test_el_corte_prefiere_directorios_a_ficheros(browse_client, raiz, monkeypatch):
    """Si hay que cortar, se cortan los ficheros: los directorios son la navegación."""
    from app.core import config

    for indice in range(4):
        (raiz / f"dir{indice}").mkdir()
    for indice in range(4):
        (raiz / f"compose{indice}.yml").write_text("services: {}\n")
    monkeypatch.setattr(config.settings, "COMPOSE_BROWSE_MAX", 4)

    cuerpo = (await _browse(browse_client, raiz)).json()

    assert {e["kind"] for e in cuerpo["entries"]} == {"dir"}
    assert cuerpo["truncado"] is True


# --- Errores -------------------------------------------------------------------


async def test_directorio_inexistente_devuelve_404(browse_client, raiz):
    respuesta = await _browse(browse_client, raiz / "no-existe")

    assert respuesta.status_code == 404
    assert "no-existe" in respuesta.json()["detail"]


async def test_un_fichero_no_es_un_directorio(browse_client, raiz):
    (raiz / "docker-compose.yml").write_text("services: {}\n")

    respuesta = await _browse(browse_client, raiz / "docker-compose.yml")

    assert respuesta.status_code == 400


@pytest.mark.skipif(
    hasattr(os, "geteuid") and os.geteuid() == 0,
    reason="root ignora los permisos, así que el test daría un falso verde",
)
async def test_directorio_sin_permiso_devuelve_403(browse_client, raiz):
    cerrado = raiz / "cerrado"
    cerrado.mkdir()
    (cerrado / "docker-compose.yml").write_text("services: {}\n")
    os.chmod(cerrado, 0o000)
    try:
        respuesta = await _browse(browse_client, cerrado)
    finally:
        os.chmod(cerrado, 0o755)

    assert respuesta.status_code == 403
    assert "leer" in respuesta.json()["detail"].lower()


# --- Privacidad ----------------------------------------------------------------


async def test_no_devuelve_el_contenido_de_los_ficheros(browse_client, raiz):
    """El contenido lo sirve SPEC-12 con su límite de tamaño. Aquí no se abre nada."""
    secreto = "SUPER_SECRETO_DE_SQL"
    (raiz / "docker-compose.yml").write_text(f"services:\n  db:\n    image: postgres\n    # {secreto}\n")

    respuesta = await _browse(browse_client, raiz)

    assert respuesta.status_code == 200
    assert secreto not in respuesta.text


async def test_un_yaml_enorme_se_lista_pero_no_se_devuelve(browse_client, raiz):
    """El tope de tamaño es de SPEC-12, no del explorador.

    Aquí no se abre el fichero, solo se le pide el `stat`, así que un `.yml` de
    varios megas sale en el listado con su nombre y su tamaño. Lo que no puede
    pasar es que su contenido viaje en la respuesta: ese límite vive en el plan.
    """
    grande = raiz / "docker-compose.yml"
    with grande.open("w") as archivo:
        archivo.write("services: {}\n")
        archivo.write("# relleno\n" * 200_000)

    respuesta = await _browse(browse_client, raiz)
    cuerpo = respuesta.json()

    assert respuesta.status_code == 200
    assert "relleno" not in respuesta.text
    assert cuerpo["entries"][0]["size"] > 1_000_000


async def test_no_usa_el_daemon_de_docker(raiz, monkeypatch):
    """El listado no necesita Docker; si lo pidiera, sería una dependencia de más."""
    from app.core import config
    from app.services.compose_service import browse

    (raiz / "docker-compose.yml").write_text("services: {}\n")
    monkeypatch.setattr(config.settings, "COMPOSE_BROWSE_ROOT", str(raiz))

    resultado = await browse(path=str(raiz))

    assert resultado.total == 1


async def test_sin_ruta_devuelve_la_raiz(browse_client, raiz):
    """El cliente no puede deducir la raíz: se la tiene que decir el backend.

    `~` significa el home del usuario del backend, no el del navegador, así que
    pedir `~` y ampliarlo en el cliente duplicaría la lógica de la raíz en dos
    sitios, que es como se cuelan los confinamientos.
    """
    (raiz / "proyectos").mkdir()
    (raiz / "docker-compose.yml").write_text("services: {}\n")

    respuesta = await browse_client.get("/api/v1/compose/browse")

    assert respuesta.status_code == 200
    cuerpo = respuesta.json()
    assert cuerpo["path"] == str(raiz)
    assert cuerpo["root"] == str(raiz)
    assert cuerpo["parent"] is None
    assert _nombres(cuerpo) == {"proyectos", "docker-compose.yml"}
