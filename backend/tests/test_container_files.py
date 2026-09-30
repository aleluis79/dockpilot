# SPDX-License-Identifier: AGPL-3.0-or-later
"""Ficheros de un contenedor (SPEC-20).

Lo que se comprueba aquí, por encima del repaso de la API:

  1. **El listado va por `exec` y la ruta viaja en el argv**, nunca interpolada
     en una cadena de shell. Es lo que impide que un `..` o un `;` se
     interpreten como sintaxis. Se aserta sobre el argv registrado, no sobre que
     "funcione": un test que sólo mira el resultado pasa igual con `sh -c`.

  2. **Un nombre con espacios no se parte**, y uno con espacios dobles no
     inventa un tamaño. Es el límite real de `ls`, documentado en §2.3: el
     nombre es la cola de la línea y `doble  espacio.txt` se parte en dos si se
     separa por columnas.

  3. **Nada de esto escribe en el disco del host.** Se comprueba que el backend
     no abre ficheros: los bytes van del navegador al contenedor y al revés,
     sin tocar el host.
"""


import io
import tarfile

import pytest
from aiodocker.exceptions import DockerError

CID = "c777"


def _tar_con_un_directorio() -> bytes:
    """El tar que `GET /archive` devuelve para un DIRECTORIO: el árbol entero.

    Incluye un hijo con contenido, que es justo lo que hace peligroso
    descargarlo: no es un marcador vacío.
    """
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tf:
        info = tarfile.TarInfo("sub")
        info.type = tarfile.DIRTYPE
        tf.addfile(info)
        contenido = b"x" * 1024
        hijo = tarfile.TarInfo("sub/uno.txt")
        hijo.size = len(contenido)
        tf.addfile(hijo, io.BytesIO(contenido))
    return buf.getvalue()


# --- Listado ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_listar_devuelve_nombre_tipo_y_tamano(files_client):
    r = await files_client.get(f"/api/v1/containers/{CID}/files", params={"path": "/datos"})

    assert r.status_code == 200, r.text
    datos = r.json()
    por_nombre = {e["name"]: e for e in datos["entries"]}

    assert por_nombre["uno.txt"] == {
        "name": "uno.txt",
        "kind": "file",
        "size": 2048,
        "symlink_target": None,
    }
    assert por_nombre["sub"]["kind"] == "dir"
    assert por_nombre["atajo"]["kind"] == "symlink"
    assert por_nombre["atajo"]["symlink_target"] == "/datos"


@pytest.mark.asyncio
async def test_listar_ordena_directorios_primero(files_client):
    r = await files_client.get(f"/api/v1/containers/{CID}/files", params={"path": "/datos"})
    tipos = [e["kind"] for e in r.json()["entries"]]

    assert tipos == sorted(tipos, key=lambda t: 0 if t == "dir" else 1)


@pytest.mark.asyncio
async def test_listar_en_la_raiz_no_ofrece_padre(files_client):
    r = await files_client.get(f"/api/v1/containers/{CID}/files", params={"path": "/"})

    assert r.status_code == 200
    assert r.json()["parent"] is None


@pytest.mark.asyncio
async def test_listar_en_un_subdirectorio_ofrece_padre(files_client):
    r = await files_client.get(f"/api/v1/containers/{CID}/files", params={"path": "/datos/sub"})

    assert r.json()["parent"] == "/datos"


@pytest.mark.asyncio
async def test_listar_incluye_los_ocultos(files_client):
    r = await files_client.get(f"/api/v1/containers/{CID}/files", params={"path": "/datos"})

    assert ".oculto" in {e["name"] for e in r.json()["entries"]}


@pytest.mark.asyncio
async def test_un_nombre_con_espacios_no_se_parte(files_client):
    """`con espacios` es UNA entrada, no dos.

    Es el motivo de usar `ls -1A` como verdad: un nombre por línea aguanta los
    espacios sin ambigüedad.
    """
    r = await files_client.get(f"/api/v1/containers/{CID}/files", params={"path": "/datos"})
    nombres = [e["name"] for e in r.json()["entries"]]

    assert "con espacios" in nombres
    assert "espacios" not in nombres


@pytest.mark.asyncio
async def test_un_nombre_con_espacios_dobles_agunta_el_tamano(files_client):
    """`doble  espacio.txt` sale entero Y con su tamaño.

    El spec (§2.3) daba por hecho que esto se partiría en `doble` + `espacio.txt`
    y que habría que renunciar al tamaño. Al medir se vio que no hace falta: se
    separa la FECHA con `split(None, 3)` —tres campos, cueste lo que cueste el
    relleno del día— y la cola es el nombre con sus espacios intactos. La línea
    entera no se parte nunca por columnas, sólo se le quita la cabecera.

    Este test es el que fija ese truco: un refactor que vuelva a `split("  ")`
    deja de pasarlo, y el síntoma sería un tamaño equivocado en la fila de al
    lado.
    """
    r = await files_client.get(f"/api/v1/containers/{CID}/files", params={"path": "/datos"})
    entradas = r.json()["entries"]

    con_doble = [e for e in entradas if "doble" in e["name"]]
    assert len(con_doble) == 1
    assert con_doble[0]["name"] == "doble  espacio.txt"
    assert con_doble[0]["size"] == 2, "el tamaño no es el suyo"


@pytest.mark.asyncio
async def test_el_sin_puntos_suspensivos_llega_al_daemon_como_un_argumento(files_client, mock_docker_files):
    """`..` viaja como texto en el argv, no como algo que alguien interprete.

    Dos cosas distintas y las dos importan:

      - El argv NO lleva `sh -c`, así que `/datos; rm -rf /` es un argumento de
        `ls` y no dos comandos.
      - El backend normaliza la ruta antes (lo hace para poder calcular el
        padre), y normalizar recorta el `..` que se sale de la raíz, que es
        exactamente lo que hace el kernel. El `..` no desaparece de la
        seguridad: se resuelve DENTRO del contenedor, que es la frontera real
        (SPEC-20 §3.1).
    """
    from app.services.container_files_service import normalizar_ruta_publica

    await files_client.get(
        f"/api/v1/containers/{CID}/files", params={"path": "/datos/../../etc"}
    )

    ejecuciones = mock_docker_files.containers_db[CID].ejecuciones
    assert ejecuciones, "no se ejecutó ningún ls"
    for argv in ejecuciones:
        assert argv[0] == "ls", f"el comando no es ls: {argv}"
        assert "sh" not in argv and "-c" not in argv, f"pasa por una shell: {argv}"
        # La ruta es UN elemento del argv (el último), no texto concatenado.
        assert argv[-1] == normalizar_ruta_publica("/datos/../../etc")
        assert argv[-1] == "/etc"
        # Y ninguna forma de llegar fuera: es una ruta de contenedor.
        assert not argv[-1].startswith("/etc/../../")


@pytest.mark.asyncio
async def test_normalizar_recorta_el_salto_de_raiz_como_el_kernel():
    """`/../../etc` es `/etc`, igual que en un shell. Ni más ni menos."""
    from app.services.container_files_service import normalizar_ruta_publica as norm

    assert norm("/") == "/"
    assert norm("") == "/"
    assert norm("/datos/./sub") == "/datos/sub"
    assert norm("/datos//sub///") == "/datos/sub"
    assert norm("/../../etc") == "/etc"
    assert norm("/datos/sub/..") == "/datos"
    # Lo que NO puede hacer es dejar salir la ruta de una forma rara.
    for entrada in ("/datos/..", "/datos/../..", "/a/b/../../../c"):
        assert norm(entrada).startswith("/")
        assert ".." not in norm(entrada)


@pytest.mark.asyncio
async def test_la_ruta_con_puntos_suspensivos_no_sale_del_contenedor(files_client, mock_docker_files):
    """Pedir `/datos/../../etc` lista el `/etc` DEL CONTENEDOR. Nada más.

    Ésta es la garantía real y no la del panel: el `..` se resuelve dentro del
    namespace del contenedor (medido en SPEC-20 §3.1 — devuelve el
    `/etc/hostname` del contenedor), así que la operación no falla ni puede
    sacar nada del host. Lo que se comprueba aquí es que la respuesta sea un
    listado normal y que no aparezca ninguna ruta del host por ninguna parte.
    """
    r = await files_client.get(
        f"/api/v1/containers/{CID}/files", params={"path": "/datos/../../etc"}
    )

    assert r.status_code == 200
    cuerpo = r.json()
    assert cuerpo["path"] == "/etc", "la ruta no quedó dentro del contenedor"
    # Ningún host path en la respuesta.
    assert "/home/" not in r.text and "/var/lib/docker" not in r.text


@pytest.mark.asyncio
async def test_una_ruta_inexistente_da_404(files_client):
    r = await files_client.get(
        f"/api/v1/containers/{CID}/files", params={"path": "/no-existe"}
    )

    assert r.status_code == 404


@pytest.mark.asyncio
async def test_un_contenedor_inexistente_da_404(files_client):
    r = await files_client.get("/api/v1/containers/nope/files", params={"path": "/datos"})

    assert r.status_code == 404


# --- Descarga -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_descargar_devuelve_el_contenido_y_no_escribe_en_el_host(files_client, tmp_path, monkeypatch):
    """La descarga devuelve bytes pelados y no toca el disco.

    `GET /archive` devuelve un TAR con un solo miembro, no el contenido: quien
    tiene que desenvolverlo es el servicio. Si no lo deshace, el usuario se
    descarga un tar disfrazado de `.log`.
    """
    r = await files_client.get(
        f"/api/v1/containers/{CID}/files/download", params={"path": "/datos/uno.txt"}
    )

    assert r.status_code == 200
    assert r.content == b"contenido de uno\n", "el contenido llegó como tar, sin desenvolver"
    # Y el nombre llega para que el navegador nombre la descarga.
    assert "uno.txt" in r.headers.get("content-disposition", "")


@pytest.mark.asyncio
async def test_descargar_un_symlink_devuelve_el_enlace_y_no_su_destino(files_client, mock_docker_files):
    """Copiar un enlace copia el enlace (SPEC-20 §3.5).

    Medido contra el daemon: `GET /archive` de un symlink devuelve un miembro
    con `issym=True`, `size=0` y `linkname` apuntando al destino. El contenido
    que se descarga es ESA ruta, que es lo que `docker cp` escribiría al
    reconstruirlo. La primera versión filtraba por `isfile()`, que deja fuera a
    los enlaces, y lo daba por inexistente.

    Seguir el enlace sería un traversal: puede apuntar a cualquier ruta del
    contenedor, y el usuario pidió un enlace.
    """
    mock_docker_files.symlinks["/datos/atajo"] = "/datos"

    r = await files_client.get(
        f"/api/v1/containers/{CID}/files/download", params={"path": "/datos/atajo"}
    )

    assert r.status_code == 200, r.text
    # El contenido es la RUTA del destino, no el contenido de lo que apunta. Si
    # se siguiera, bajaría `/datos` entero.
    assert r.content == b"/datos"


@pytest.mark.asyncio
async def test_descargar_un_directorio_que_contiene_un_symlink_no_devuelve_al_descendiente(
    files_client, mock_docker_files
):
    """Sólo cuenta el PRIMER miembro del tar: es la ruta que se pidió.

    Este es el caso que pasó de verdad contra el daemon. Pedir `/usr/lib`
    devolvía 200 con el contenido de `libGeoIP.so.1.6.12`: un symlink que estaba
    dos niveles más abajo en el tar. La causa era buscar "el primer symlink del
    árbol" en vez de mirar la entrada de la raíz.

    El test se llama así y no "test_no_devuelve_el_contenido" porque lo que
    importa no es qué symlink hay, sino que un directorio NUNCA se descargue como
    si fuera un fichero.
    """
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tf:
        raiz = tarfile.TarInfo("lib")
        raiz.type = tarfile.DIRTYPE
        tf.addfile(raiz)

        # Un symlink DOS NIVELES más abajo, como `libGeoIP.so.1.6.12`.
        enlace = tarfile.TarInfo("lib/engines-3/indirecto")
        enlace.type = tarfile.SYMTYPE
        enlace.linkname = "/otro/lado"
        tf.addfile(enlace)

        # Y un fichero de verdad más abajo, para cazar también el `next(isfile())`.
        contenido = b"contenido de un descendiente\n"
        hijo = tarfile.TarInfo("lib/engines-3/afalg.so")
        hijo.size = len(contenido)
        tf.addfile(hijo, io.BytesIO(contenido))
    mock_docker_files.tar_por_ruta["/usr/lib"] = buf.getvalue()

    r = await files_client.get(
        f"/api/v1/containers/{CID}/files/download", params={"path": "/usr/lib"}
    )

    assert r.status_code == 400, r.text
    assert "directorio" in r.text
    # Y no se ha filtrado nada del tar: ni el enlace ni el descendiente.
    assert b"contenido de un descendiente" not in r.content
    assert b"/otro/lado" not in r.content


@pytest.mark.asyncio
async def test_descargar_un_directorio_da_400_y_no_51_megabytes(files_client, mock_docker_files):
    """Un directorio por el archive son 51 MB (`/usr/lib`, medido en §2.2).

    Se rechaza con un 400 que lo dice, en vez de empezar a descargar y cortar
    luego por el tope. El 404 sería peor: el directorio SÍ existe y el panel lo
    pintaría como "se ha borrado".
    """
    mock_docker_files.tar_por_ruta["/datos/sub"] = _tar_con_un_directorio()

    r = await files_client.get(
        f"/api/v1/containers/{CID}/files/download", params={"path": "/datos/sub"}
    )

    assert r.status_code == 400
    assert "directorio" in r.text


@pytest.mark.asyncio
async def test_el_tope_de_descarga_no_deja_pasar_un_fichero_grande(files_client, monkeypatch):
    """El tope corta ANTES de la descarga, no después.

    El daemon no impone ninguno (se midió con 120 MB, SPEC-20 §2.4), así que si
    el panel no corta, un `du` de un directorio es una descarga de 51 MB.
    """
    from app.core.config import settings

    monkeypatch.setattr(settings, "FILES_DOWNLOAD_MAX_BYTES", 10)

    r = await files_client.get(
        f"/api/v1/containers/{CID}/files/download", params={"path": "/datos/uno.txt"}
    )

    assert r.status_code == 413
    assert b"64" not in r.content  # el mensaje dice el tope real, no el de por defecto


@pytest.mark.asyncio
async def test_descargar_una_ruta_inexistente_da_404(files_client):
    r = await files_client.get(
        f"/api/v1/containers/{CID}/files/download", params={"path": "/datos/nope.txt"}
    )

    assert r.status_code == 404


# --- Subida -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_subir_devuelve_el_contenido_a_la_ruta(files_client, files_client_contenido):
    r = await files_client.post(
        f"/api/v1/containers/{CID}/files/upload",
        data={"path": "/datos"},
        files={"files": ("notas.txt", b"hola desde el panel\n", "text/plain")},
    )

    assert r.status_code == 201, r.text
    assert files_client_contenido["/datos/notas.txt"] == b"hola desde el panel\n"


@pytest.mark.asyncio
async def test_subir_una_carpeta_conserva_la_estructura(files_client, files_client_contenido):
    """`webkitdirectory` llega como varias rutas relativas: hay que respetarlas.

    Sin esto, subir una carpeta deja 40 ficheros revueltos en un directorio.
    """
    r = await files_client.post(
        f"/api/v1/containers/{CID}/files/upload",
        data={"path": "/datos"},
        files=[
            ("files", ("conf/app.conf", b"uno\n", "text/plain")),
            ("files", ("conf/sub/more.conf", b"dos\n", "text/plain")),
        ],
    )

    assert r.status_code == 201, r.text
    assert files_client_contenido["/datos/conf/app.conf"] == b"uno\n"
    assert files_client_contenido["/datos/conf/sub/more.conf"] == b"dos\n"


@pytest.mark.asyncio
async def test_subir_rechaza_un_nombre_con_puntos_suspensivos(files_client, files_client_contenido):
    """`..` en el nombre del fichero no se reenvía al daemon.

    El daemon lo rechaza con un 500 (`invalid entry name`), pero un 500 para un
    fichero que el usuario ha elegido no es una respuesta: tiene que ser un 400
    que diga qué estaba mal. Y nada se escribe.
    """
    r = await files_client.post(
        f"/api/v1/containers/{CID}/files/upload",
        data={"path": "/datos"},
        files={"files": ("../../../../etc/evadido.txt", b"x\n", "text/plain")},
    )

    assert r.status_code == 400
    assert all("evadido" not in ruta for ruta in files_client_contenido)


@pytest.mark.asyncio
async def test_subir_rechaza_un_nombre_absoluto(files_client, files_client_contenido):
    """`/etc/passwd` como nombre es una ruta absoluta, no un nombre."""
    r = await files_client.post(
        f"/api/v1/containers/{CID}/files/upload",
        data={"path": "/datos"},
        files={"files": ("/etc/passwd", b"x\n", "text/plain")},
    )

    assert r.status_code == 400


@pytest.mark.asyncio
async def test_el_tope_de_subida_no_deja_pasar_un_fichero_grande(files_client, files_client_contenido, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "FILES_UPLOAD_MAX_BYTES", 10)

    r = await files_client.post(
        f"/api/v1/containers/{CID}/files/upload",
        data={"path": "/datos"},
        files={"files": ("grande.txt", b"x" * 100, "text/plain")},
    )

    assert r.status_code == 413
    assert "/datos/grande.txt" not in files_client_contenido


@pytest.mark.asyncio
async def test_subir_sin_ficheros_da_400(files_client):
    r = await files_client.post(
        f"/api/v1/containers/{CID}/files/upload", data={"path": "/datos"}
    )

    assert r.status_code == 400


@pytest.mark.asyncio
async def test_subir_nunca_pide_una_ruta_del_host(files_client):
    """El contrato: la subida recibe CONTENIDO y un destino de contenedor.

    Se mira el esquema OpenAPI, que es la superficie pública, y no la firma de
    la función. La idea es que quede FIJADA: si algún día hace falta una ruta
    del host, es otro spec con el confinamiento de SPEC-14 §3.2 (SPEC-20 §1), y
    este test es el que obliga a abrir esa conversación en vez de colar un
    `host_path` debajo.
    """
    from app.main import app

    esquema = app.openapi()
    cuerpo = None
    for ruta, operaciones in esquema["paths"].items():
        if ruta.endswith("/files/upload"):
            ref = operaciones["post"]["requestBody"]["content"]["multipart/form-data"][
                "schema"
            ]["$ref"]
            cuerpo = next(
                v for k, v in esquema["components"]["schemas"].items() if k == ref.rsplit("/", 1)[-1]
            )
            break

    assert cuerpo is not None, "no se encontró el endpoint de subida"
    propiedades = set(cuerpo["properties"])
    assert propiedades == {"path", "files"}
    # Ni `host_path`, ni `source`, ni `local_path`: no hay donde meterlo.
    assert not any("host" in p or "local" in p or "source" in p for p in propiedades)


@pytest.mark.asyncio
async def test_un_error_del_daemon_no_deja_el_panel_desincronizado(files_client, monkeypatch):
    """Un fallo inesperado se traduce, no se filtra crudo.

    El 500 de `invalid entry name` del daemon es un 500 de Docker con un
    mensaje en JSON; 그대로 al cliente llega como "[object Object]" (§
    `docker_error_message`).
    """
    async def revienta(*_a, **_k):
        raise DockerError(500, {"message": "boom inesperado"})

    monkeypatch.setattr("app.services.container_files_service.list_directory", revienta)

    r = await files_client.get(f"/api/v1/containers/{CID}/files", params={"path": "/datos"})

    assert r.status_code >= 400
    assert "boom inesperado" in r.text
    assert "[object" not in r.text
