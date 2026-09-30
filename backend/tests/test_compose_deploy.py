# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests del despliegue desde el plan: colisión de nombre y coste de build (SPEC-15).

El caso que motiva todo esto: un compose file que nunca ha corrido no deja
etiquetas, así que no tiene fila en la tabla y no se puede arrancar desde ella.
Con el plan ya se puede resolver, y aquí se comprueba que el panel detecta el
único caso en que arrancarlo haría daño: que otro proyecto ya ocupe ese nombre.
"""

import json

import pytest

from app.services.compose_service import _colision

pytestmark = pytest.mark.asyncio

# --- Utilidades ----------------------------------------------------------------


def _volumen(repo, nombre: str, proyecto: str) -> None:
    """Un volumen con etiqueta de proyecto es suficiente para que exista el proyecto."""
    repo.list_payload["Volumes"].append(
        {
            "Name": nombre,
            "Driver": "local",
            "Scope": "local",
            "Mountpoint": f"/var/lib/docker/volumes/{nombre}/_data",
            "CreatedAt": "2026-09-01T10:00:00-03:00",
            "Labels": {
                "com.docker.compose.project": proyecto,
                "com.docker.compose.volume": nombre.split("_", 1)[-1],
            },
            "Options": None,
        }
    )


def _contenedor(mock, nombre: str, proyecto: str, config_files: str) -> None:
    from tests.conftest import FakeDockerContainer

    mock.containers_db[nombre] = FakeDockerContainer(
        cid=nombre,
        name=f"/{nombre}",
        image="nginx:1.27",
        status="running",
        state="running",
        labels={
            "com.docker.compose.project": proyecto,
            "com.docker.compose.service": "web",
            "com.docker.compose.project.config_files": config_files,
        },
    )


# --- Colisión de nombre --------------------------------------------------------


async def test_detecta_nombre_ocupado_por_otro_archivo(mock_docker):
    """Dos archivos compose peleándose por un nombre no se pueden fusionar.

    Los nombres de red y de volumen llevan prefijo del proyecto, y
    `container_name` es global en Docker con independencia del proyecto. Arrancar
    y que el conflicto aparezca en el `stderr` de compose es peor que negarse.
    """
    _contenedor(mock_docker, "web-otro", "tienda", "/otro/sitio/docker-compose.yml")

    resultado = await _colision(mock_docker, "tienda", "/home/usuario/tienda/docker-compose.yml")

    assert resultado is not None
    assert resultado.nombre == "tienda"
    assert resultado.mismo_archivo is False
    assert resultado.config_files == ["/otro/sitio/docker-compose.yml"]


async def test_no_detecta_colision_con_el_mismo_archivo(mock_docker):
    """Es un reinicio legítimo: el botón sigue disponible y no se avisa."""
    ruta = "/home/usuario/tienda/docker-compose.yml"
    _contenedor(mock_docker, "web", "tienda", ruta)

    resultado = await _colision(mock_docker, "tienda", ruta)

    assert resultado is None


async def test_no_detecta_colision_si_el_nombre_esta_libre(mock_docker):
    assert await _colision(mock_docker, "nuevo-proyecto", "/p/docker-compose.yml") is None


async def test_un_proyecto_huerfano_no_bloquea_nada(mock_docker):
    """Un huerfano no tiene contenedores, y `--remove-orphans` solo borra contenedores.

    Es el caso de `simp-sica` y `tickets-app` en el host de referencia: conservan
    redes y volumenes, pero no hay ningun contenedor que se puedan llevar por
    delante. Bloquearlos seria dejar fuera exactamente el despliegue que esta spec
    viene a permitir.
    """
    _volumen(mock_docker.volumes, "viejo_datos", "simp-sica")

    resultado = await _colision(mock_docker, "simp-sica", "/home/u/otro/docker-compose.yml")

    assert resultado is None


async def test_un_proyecto_sin_config_files_no_se_bloquea(mock_docker):
    """Con contenedores pero sin `config_files` no se puede demostrar que sea otro.

    `config_files` lo escribe compose en el contenedor; si no esta, es que el dato
    no esta. Bloquear por sospecha impediria reiniciar un proyecto propio.
    """
    from tests.conftest import FakeDockerContainer

    _volumen(mock_docker.volumes, "mio_datos", "mio")
    mock_docker.containers_db["sin-ruta"] = FakeDockerContainer(
        cid="sin-ruta",
        name="/sin-ruta",
        image="nginx:1.27",
        status="running",
        state="running",
        labels={
            "com.docker.compose.project": "mio",
            "com.docker.compose.service": "web",
        },
    )

    assert await _colision(mock_docker, "mio", "/otro/docker-compose.yml") is None



async def test_varios_archivos_config_del_proyecto_ocupante(mock_docker):
    """`config_files` es una lista separada por comas y todos cuentan."""
    _contenedor(
        mock_docker,
        "web",
        "tienda",
        "/a/docker-compose.yml, /a/docker-compose.override.yml",
    )

    resultado = await _colision(mock_docker, "tienda", "/b/docker-compose.yml")

    assert resultado is not None
    assert len(resultado.config_files) == 2


async def test_el_daemon_caido_no_rompe_el_plan(mock_docker):
    """El plan es válido aunque no se pueda cruzar con el host, igual que SPEC-12."""
    import aiodocker

    async def fallo(*_args, **_kwargs):
        raise aiodocker.exceptions.DockerError(500, {"message": "boom"})

    mock_docker.containers.list = fallo
    mock_docker.networks.list = fallo
    mock_docker.volumes.list = fallo

    assert await _colision(mock_docker, "tienda", "/p/docker-compose.yml") is None


# --- Integración con el plan ---------------------------------------------------


async def test_el_plan_expone_el_coste_de_build_por_servicio(
    plan_client, fake_spawn, archivo
):
    fake_spawn.devolver(
        stdout=json.dumps(
            {
                "name": "app",
                "services": {
                    "api": {"image": "x", "build": {"context": "./api"}},
                    "web": {"image": "y"},
                },
                "networks": {},
                "volumes": {},
            }
        ).encode()
    )
    (archivo.parent / "api").mkdir()
    (archivo.parent / "api" / "main.py").write_bytes(b"x" * 100)

    r = await plan_client.post(
        "/api/v1/compose/plan", json={"path": str(archivo)}
    )
    assert r.status_code == 200, r.text
    servicios = {s["name"]: s for s in r.json()["services"]}

    assert servicios["api"]["build"] is not None
    assert servicios["api"]["build"]["context"] == str(archivo.parent / "api")
    assert servicios["api"]["build"]["bytes_aprox"] == 100
    # Sin `build` no hay objeto: `None`, no un coste de cero.
    assert servicios["web"]["build"] is None


async def test_el_plan_no_informa_colision_si_el_nombre_esta_libre(
    plan_client, fake_spawn, archivo
):
    fake_spawn.devolver(
        stdout=json.dumps({"name": "nunca-visto", "services": {}, "networks": {}, "volumes": {}}).encode()
    )

    r = await plan_client.post("/api/v1/compose/plan", json={"path": str(archivo)})

    assert r.json()["proyecto_en_uso"] is None


async def test_el_plan_avisa_de_la_colision_de_nombre(
    plan_client, fake_spawn, archivo, mock_docker
):
    """El caso real: el plan resuelve un nombre que otro proyecto ya ocupa."""
    fake_spawn.devolver(
        stdout=json.dumps(
            {"name": "tickets-app", "services": {}, "networks": {}, "volumes": {}}
        ).encode()
    )
    _contenedor(
        mock_docker, "otro", "tickets-app", "/en/otro/lugar/docker-compose.yml"
    )

    r = await plan_client.post("/api/v1/compose/plan", json={"path": str(archivo)})

    colision = r.json()["proyecto_en_uso"]
    assert colision is not None
    assert colision["nombre"] == "tickets-app"
    assert colision["mismo_archivo"] is False


# --- El plan cuando el daemon no responde -------------------------------------


async def test_sin_daemon_los_recursos_no_parecen_existentes(mock_docker):
    """"No lo sé" no es "sí, ya existe".

    `_a_recursos` calcula `exists = real in ya_existentes`, así que devolver los
    nombres declarados cuando la lectura falla marcaba TODAS las redes y
    volúmenes del preview como ya creados. Con el daemon caído, "no lo sé" tiene
    que traducirse a "no existe", no a "ya está".
    """
    import aiodocker

    datos = {
        "networks": {"front": {"name": "tienda_front"}},
        "volumes": {"data": {"name": "tienda_data"}},
    }

    async def fallo(*_args, **_kwargs):
        raise aiodocker.exceptions.DockerError(900, "Cannot connect to Docker Engine")

    mock_docker.networks.list = fallo
    mock_docker.volumes.list = fallo

    from app.schemas.compose import PlannedNetwork, PlannedVolume
    from app.services.compose_service import _a_recursos, _nombres_existentes

    existentes = await _nombres_existentes(mock_docker, datos)
    assert existentes == {"networks": set(), "volumes": set()}

    redes = _a_recursos(datos["networks"], PlannedNetwork, existentes)
    volumenes = _a_recursos(datos["volumes"], PlannedVolume, existentes)

    assert [n.name for n in redes] == ["tienda_front"]
    assert all(n.exists is False for n in redes)
    assert [v.name for v in volumenes] == ["tienda_data"]
    assert all(v.exists is False for v in volumenes)


async def test_con_daemon_sin_esos_recursos_no_existen(mock_docker):
    """El caso normal: se listan, no existen, y el plan dice que se crearán."""
    datos = {
        "networks": {"front": {"name": "tienda_front"}},
        "volumes": {"data": {"name": "tienda_data"}},
    }

    from app.services.compose_service import _nombres_existentes

    existentes = await _nombres_existentes(mock_docker, datos)
    assert existentes["networks"] == set()
    assert existentes["volumes"] == set()
