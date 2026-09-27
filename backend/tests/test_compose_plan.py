# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests de la previsualización de archivos compose (SPEC-12).

Ninguno ejecuta `docker compose`: `fake_spawn` devuelve el JSON que el CLI
produciría. La forma de ese JSON está copiada de la salida real de
`docker compose config --format json` v5.5.1 verificada contra el host de
referencia, incluidas sus cuatro rarezas (§3.2).
"""

import json
import os
from pathlib import Path

import pytest

pytestmark = pytest.mark.asyncio

# --- JSON reales ---------------------------------------------------------------

CONFIG_SIMPLE = {
    "name": "tienda",
    "services": {
        "web": {
            "image": "nginx:1.27",
            "container_name": "tienda-web",
            "restart": "unless-stopped",
            # `published` es una CADENA, y va con `mode` y `protocol`.
            "ports": [
                {"mode": "ingress", "target": 9200, "published": "9200", "protocol": "tcp"},
                {"mode": "ingress", "target": 80, "published": "8000-8010", "protocol": "tcp"},
            ],
            # Los montajes vienen en forma larga.
            "volumes": [
                {
                    "type": "volume",
                    "source": "app_data",
                    "target": "/srv/datos",
                    "volume": {},
                }
            ],
            # `networks` de un servicio es un MAPA con valor null, no una lista.
            "networks": {"front": None},
            "environment": {"DB_PASSWORD": "secreto", "DEBUG": "1"},
            "command": "nginx -g 'daemon off;'",
        },
        # Servicio sin secciones opcionales: `config` las omite enteras.
        "cache": {"image": "redis:7"},
    },
    # Las redes y los volúmenes de la raíz son MAPAS: la clave es el nombre
    # lógico del archivo y el valor trae el nombre real ya prefijado.
    "networks": {
        "front": {"name": "tienda_front", "driver": "bridge", "ipam": {}},
        "ext": {"name": "red-externa", "external": True},
    },
    "volumes": {
        "app_data": {"name": "tienda_app_data"},
        "legacy": {"name": "volumen-externo", "external": True},
    },
}

CONFIG_CON_BUILD = {
    "name": "app",
    "services": {
        "api": {
            "build": {"context": "/abs/app", "dockerfile": "Dockerfile"},
            "image": "mi/api:1.0",
            # `depends_on` es un MAPA con la condición por servicio, no una lista.
            "depends_on": {"db": {"condition": "service_healthy", "required": True}},
            "profiles": ["dev"],
        },
        "db": {"image": "postgres:16"},
    },
    "networks": {},
    "volumes": {},
}

AVISO = (
    b'time="2026-09-27T14:07:21-03:00" level=warning '
    b'msg="The \\"NO_EXISTE\\" variable is not set. Defaulting to a blank string."'
)


def _json(payload: dict) -> bytes:
    return json.dumps(payload).encode()


# --- Utilidades ----------------------------------------------------------------


async def _plan(client, path="/p/tienda/docker-compose.yml", **extra):
    cuerpo = {"path": path, **extra}
    return await client.post("/api/v1/compose/plan", json=cuerpo)


# --- Lectura del plan ----------------------------------------------------------


async def test_plan_lista_servicios_resueltos(plan_client, fake_spawn, archivo):
    fake_spawn.devolver(stdout=_json(CONFIG_SIMPLE))

    r = await _plan(plan_client, path=str(archivo))

    assert r.status_code == 200, r.text
    plan = r.json()
    assert [s["name"] for s in plan["services"]] == ["cache", "web"]
    assert plan["project_name"] == "tienda"
    assert plan["resolved_by"] == "docker-compose-cli"


async def test_plan_lee_published_como_cadena(plan_client, fake_spawn, archivo):
    # Tipar `published` como int revienta con cualquier rango de puertos, que es
    # un caso absolutamente normal.
    fake_spawn.devolver(stdout=_json(CONFIG_SIMPLE))

    r = await _plan(plan_client, path=str(archivo))

    web = next(s for s in r.json()["services"] if s["name"] == "web")
    publicados = {p["published"] for p in web["ports"]}
    assert "8000-8010" in publicados
    assert all(isinstance(p["published"], str) for p in web["ports"])


async def test_plan_mantiene_nombre_logico_y_real_de_redes_y_volumenes(
    plan_client, fake_spawn, archivo
):
    fake_spawn.devolver(stdout=_json(CONFIG_SIMPLE))

    r = await _plan(plan_client, path=str(archivo))

    plan = r.json()
    red = next(n for n in plan["networks"] if n["logical_name"] == "front")
    assert red["name"] == "tienda_front"
    volumen = next(v for v in plan["volumes"] if v["logical_name"] == "app_data")
    assert volumen["name"] == "tienda_app_data"


async def test_plan_marca_como_externas_lo_que_no_creara(plan_client, fake_spawn, archivo):
    # `external: true` significa que compose no la va a crear: ya existe.
    fake_spawn.devolver(stdout=_json(CONFIG_SIMPLE))

    r = await _plan(plan_client, path=str(archivo))

    plan = r.json()
    assert next(n for n in plan["networks"] if n["logical_name"] == "ext")["external"] is True
    assert next(v for v in plan["volumes"] if v["logical_name"] == "legacy")["external"] is True


async def test_plan_tolera_servicios_sin_secciones_opcionales(
    plan_client, fake_spawn, archivo
):
    # `config` omite enteras las secciones que el servicio no declara.
    fake_spawn.devolver(stdout=_json(CONFIG_SIMPLE))

    r = await _plan(plan_client, path=str(archivo))

    cache = next(s for s in r.json()["services"] if s["name"] == "cache")
    # Sin `build` no hay objeto de coste. Antes era `False`; ahora es `None`,
    # porque `None` y "cuesta cero" no son lo mismo (SPEC-15 §2.1).
    assert cache["build"] is None
    assert cache["depends_on"] == []
    assert cache["profiles"] == []
    assert cache["ports"] == []


async def test_plan_detecta_build_depends_on_y_profiles(plan_client, fake_spawn, archivo):
    fake_spawn.devolver(stdout=_json(CONFIG_CON_BUILD))

    r = await _plan(plan_client, path=str(archivo))

    api = next(s for s in r.json()["services"] if s["name"] == "api")
    # `build` pasó de booleano a coste estimado. La intención del test de SPEC-12
    # era detectar que el servicio construye; ahora además se afirma el contexto
    # que compose declaró, que es lo que el usuario necesita para decidir (SPEC-15).
    assert api["build"] is not None
    assert api["build"]["context"] == "/abs/app"
    # `/abs/app` no existe en el host de pruebas, así que la estimación lo dice en
    # vez de devolver un 0 que se leería como "no pesa".
    assert api["build"]["error"] is not None
    # `depends_on` llega como mapa con la condición; al usuario le importa qué
    # servicios espera, no la condición, así que se queda con las claves.
    assert api["depends_on"] == ["db"]
    assert api["profiles"] == ["dev"]


async def test_plan_acepta_depends_on_como_lista(plan_client, fake_spawn, archivo):
    # Tolerar las dos formas evita que un cambio de versión del CLI rompa el
    # preview entero.
    plano = {"name": "x", "services": {"a": {"image": "i", "depends_on": ["b"]}}, "networks": {}, "volumes": {}}
    fake_spawn.devolver(stdout=_json(plano))

    r = await _plan(plan_client, path=str(archivo))

    assert r.json()["services"][0]["depends_on"] == ["b"]


async def test_pide_todos_los_perfiles_del_archivo(plan_client, fake_spawn, archivo):
    # `docker compose config` EXCLUYE los servicios con `profiles` salvo que se
    # activen. Sin `--profile '*'` el plan pierde servicios sin avisar, que es
    # la misma traición que un preview incompleto (SPEC-12 §3.4).
    fake_spawn.devolver(stdout=_json(CONFIG_CON_BUILD))

    await _plan(plan_client, path=str(archivo))

    args = fake_spawn.ultima.args
    assert "--profile" in args
    assert args[args.index("--profile") + 1] == "*"


async def test_plan_lee_networks_de_servicio_como_mapa(plan_client, fake_spawn, archivo):
    # `{"front": null}` son las CLAVES del mapa; leerlo como lista da TypeError.
    fake_spawn.devolver(stdout=_json(CONFIG_SIMPLE))

    r = await _plan(plan_client, path=str(archivo))

    web = next(s for s in r.json()["services"] if s["name"] == "web")
    assert web["networks"] == ["front"]


async def test_plan_usa_el_nombre_real_del_proyecto_si_lo_piden(
    plan_client, fake_spawn, archivo
):
    fake_spawn.devolver(stdout=_json(CONFIG_SIMPLE))

    r = await _plan(plan_client, path=str(archivo), project_name="otro")

    assert r.status_code == 200, r.text
    # El `-p` llega al CLI, que es quien prefija los nombres reales.
    assert "-p" in fake_spawn.ultima.args
    assert "otro" in fake_spawn.ultima.args


async def test_plan_cuenta_variables_sin_devolver_valores(plan_client, fake_spawn, archivo):
    # Los valores pueden traer contraseñas y no hay motivo para sacarlos del
    # archivo: solo el recuento.
    fake_spawn.devolver(stdout=_json(CONFIG_SIMPLE))

    r = await _plan(plan_client, path=str(archivo))

    cuerpo = r.text
    web = next(s for s in r.json()["services"] if s["name"] == "web")
    assert web["environment_count"] == 2
    assert "secreto" not in cuerpo
    assert "DB_PASSWORD" not in cuerpo


async def test_plan_marca_lo_que_ya_existe_en_el_daemon(plan_client, fake_spawn, archivo):
    # Distinguir "esto ya está" de "esto se crearía" es la pregunta que hace que el
    # plan sirva de algo (SPEC-12 §3.7). `mock_docker` tiene la red `app-net` y el
    # volumen `datos-app`; el plan declara `tienda_app_data`, que no existe.
    fake_spawn.devolver(stdout=_json(CONFIG_SIMPLE))

    r = await _plan(plan_client, path=str(archivo))

    plan = r.json()
    front = next(n for n in plan["networks"] if n["logical_name"] == "front")
    assert front["exists"] is False
    assert front["external"] is False

    externa = next(n for n in plan["networks"] if n["logical_name"] == "ext")
    assert externa["external"] is True


async def test_plan_detecta_un_nombre_real_que_ya_existe(plan_client, fake_spawn, archivo):
    # Un plan que redeclara `app-net` la encontraría ya creada.
    config = {
        **CONFIG_SIMPLE,
        "networks": {"front": {"name": "app-net", "driver": "bridge"}},
    }
    fake_spawn.devolver(stdout=_json(config))

    r = await _plan(plan_client, path=str(archivo))

    front = next(n for n in r.json()["networks"] if n["logical_name"] == "front")
    assert front["name"] == "app-net"
    assert front["exists"] is True


async def test_plan_lee_montajes_en_forma_larga(plan_client, fake_spawn, archivo):
    fake_spawn.devolver(stdout=_json(CONFIG_SIMPLE))

    r = await _plan(plan_client, path=str(archivo))

    web = next(s for s in r.json()["services"] if s["name"] == "web")
    assert web["mounts"] == [
        {"type": "volume", "source": "app_data", "target": "/srv/datos", "read_only": False}
    ]


# --- Warnings ------------------------------------------------------------------


async def test_warnings_con_codigo_de_salida_cero(plan_client, fake_spawn, archivo):
    # El caso clave: compose valida el archivo y aun así avisa de una variable
    # sin definir, saliendo con 0. Un implementation que solo mire el código se
    # come el aviso y el usuario descubre tarde que su contraseña quedó vacía.
    fake_spawn.devolver(codigo=0, stdout=_json(CONFIG_SIMPLE), stderr=AVISO)

    r = await _plan(plan_client, path=str(archivo))

    assert r.status_code == 200, r.text
    plan = r.json()
    assert plan["warnings"], "el aviso de variable sin definir debe llegar al cliente"
    assert "NO_EXISTE" in plan["warnings"][0]
    # Y el plan sigue siendo utilizable.
    assert plan["services"]


# --- Errores de la petición ----------------------------------------------------


async def test_ruta_no_absoluta_devuelve_400(plan_client, fake_spawn):
    # Una ruta relativa se resolvería contra el directorio del backend, que no
    # es el del usuario, y el error aparecería más tarde y más confuso.
    r = await _plan(plan_client, path="docker-compose.yml")

    assert r.status_code == 400
    assert "absoluta" in r.json()["detail"].lower()
    assert fake_spawn.calls == [], "no se llama al CLI si la ruta no vale"


async def test_archivo_inexistente_devuelve_404(plan_client, fake_spawn):
    r = await _plan(plan_client, path="/no/existe/docker-compose.yml")

    assert r.status_code == 404
    assert fake_spawn.calls == []


async def test_archivo_demasiado_grande_devuelve_413(plan_client, fake_spawn):
    r = await _plan(plan_client, path="/p/grande/docker-compose.yml", content="x" * (1024 * 1024 + 1))

    assert r.status_code == 413
    assert fake_spawn.calls == []


async def test_contenido_demasiado_grande_devuelve_413(plan_client, fake_spawn):
    grande = "/p/grande/docker-compose.yml"

    r = await _plan(plan_client, path=grande, content="x" * (1024 * 1024 + 1))

    assert r.status_code == 413
    assert fake_spawn.calls == []


async def test_error_de_validacion_con_codigo_distinto_de_cero(plan_client, fake_spawn, archivo):
    mensaje = b"go-yaml load error in parser at L3.C11: did not find expected ','"
    fake_spawn.devolver(codigo=1, stdout=b"", stderr=mensaje)

    r = await _plan(plan_client, path=str(archivo))

    assert r.status_code == 422
    # El mensaje de compose es lo más útil que puede mostrar el panel.
    assert "go-yaml" in r.json()["detail"]


async def test_cli_ausente_devuelve_503(plan_client, fake_spawn, archivo):
    fake_spawn.fallar_con(FileNotFoundError("docker"))

    r = await _plan(plan_client, path=str(archivo))

    assert r.status_code == 503
    assert "Compose" in r.json()["detail"]


async def test_timeout_devuelve_504(plan_client, fake_spawn, archivo, monkeypatch):
    fake_spawn.devolver(cuelga=True)
    monkeypatch.setattr("app.services.compose_service.TIMEOUT_PLAN_S", 0.05)

    r = await _plan(plan_client, path=str(archivo))

    assert r.status_code == 504


async def test_cuerpo_invalido_devuelve_422(plan_client, fake_spawn):
    r = await plan_client.post("/api/v1/compose/plan", json={})

    assert r.status_code == 422
    assert fake_spawn.calls == []


# --- El contenido editado y el disco -------------------------------------------


async def test_contenido_editado_se_valida_sin_tocar_el_disco(
    plan_client, fake_spawn, archivo
):
    original = archivo.read_text()
    fake_spawn.devolver(stdout=_json(CONFIG_SIMPLE))

    r = await _plan(plan_client, path=str(archivo), content="services:\n  otro:\n    image: x\n")

    assert r.status_code == 200, r.text
    # El archivo del disco sigue igual: el contenido editado no se guarda nunca.
    assert archivo.read_text() == original


async def test_el_contenido_editado_es_el_que_se_resuelve(
    plan_client, fake_spawn, archivo
):
    otro = {**CONFIG_SIMPLE, "name": "editado"}
    fake_spawn.devolver(stdout=_json(otro))

    r = await _plan(plan_client, path=str(archivo), content="services: {}")

    assert r.json()["project_name"] == "editado"


async def test_temporal_se_borra_aun_si_falla(plan_client, fake_spawn, archivo, monkeypatch):
    # Si el temporal no se limpia, cada previsualización deja un archivo con
    # posibles secretos en /tmp.
    fake_spawn.devolver(codigo=1, stdout=b"", stderr=b"roto")

    r = await _plan(plan_client, path=str(archivo), content="services: [malformado")

    assert r.status_code == 422
    leftovers = [
        p
        for p in Path(os.environ.get("TMPDIR", "/tmp")).iterdir()
        if p.is_file() and p.name.startswith("dockpilot-compose-")
    ]
    assert leftovers == [], f"quedaron temporales sin borrar: {leftovers}"


async def test_sin_contenido_se_usa_el_archivo_de_disco(plan_client, fake_spawn, archivo):
    fake_spawn.devolver(stdout=_json(CONFIG_SIMPLE))

    r = await _plan(plan_client, path=str(archivo))

    assert r.status_code == 200
    # Se pasa la ruta del usuario, no un temporal.
    assert str(archivo) in fake_spawn.ultima.args
