# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests del modo streaming del runner (SPEC-13 §3.3 y §3.7).

Los pipes se leen por trozos, como un proceso real. Ningún test ejecuta el
binario: `fake_spawn` sustituye `_crear_proceso`.
"""

import asyncio

import pytest

from app.services.compose_cli import (
    ACCIONES_CON_SERVICIO,
    ComposeCliAusente,
    ResultadoAccion,
    argumentos_accion,
    ejecutar_accion,
    timeout_de,
)

pytestmark = pytest.mark.asyncio

ARCHIVO = "/home/usuario/proyectos/tienda/docker-compose.yml"


async def _recorrer(accion, **kwargs):
    """Ejecuta la acción y devuelve (trozos, resultado)."""
    resultado = ResultadoAccion()
    trozos = [t async for t in ejecutar_accion(accion, ARCHIVO, resultado=resultado, **kwargs)]
    return trozos, resultado


# --- Argumentos ----------------------------------------------------------------


async def test_up_lleva_detach_y_remove_orphans():
    args = argumentos_accion("up", ARCHIVO)

    assert args == [
        "docker", "compose", "-f", ARCHIVO, "up", "-d", "--remove-orphans",
    ]


async def test_up_no_lleva_build():
    # `build` queda fuera de la spec: es el flujo más largo y el que más falla.
    assert "--build" not in argumentos_accion("up", ARCHIVO)


async def test_stop_no_lleva_volumes():
    # `stop` no borra nada: el proyecto se puede relanzar con `up -d`.
    assert "stop" in argumentos_accion("stop", ARCHIVO)
    assert "--volumes" not in argumentos_accion("stop", ARCHIVO)


async def test_down_sin_volumes_es_el_valor_por_defecto():
    assert argumentos_accion("down", ARCHIVO) == [
        "docker", "compose", "-f", ARCHIVO, "down",
    ]


async def test_down_con_volumes_siempre_lleva_el_flag():
    assert "--volumes" in argumentos_accion("down", ARCHIVO, volumes=True)


async def test_down_no_lleva_remove_orphans():
    # `down` ya se lleva todo lo del proyecto; `--remove-orphans` aquí sería
    # redundante y engañoso.
    assert "--remove-orphans" not in argumentos_accion("down", ARCHIVO, volumes=True)


async def test_el_servicio_va_posicional_y_no_como_flag():
    # Compose v2 no tiene `--service`: `docker compose logs --service web` responde
    # `unknown flag: --service`. Ponerlo haría fallar la acción.
    for accion in ("logs", "pull", "stop"):
        args = argumentos_accion(accion, ARCHIVO, service="web")
        assert "--service" not in args
        assert args[-1] == "web"


async def test_up_y_down_ignoran_el_servicio():
    # Ninguna de las dos acepta un servicio suelto.
    for accion in ("up", "down"):
        assert argumentos_accion(accion, ARCHIVO, service="web")[-1] == (
            "--remove-orphans" if accion == "up" else "down"
        )


async def test_acciones_con_servicio():
    assert ACCIONES_CON_SERVICIO == frozenset({"logs", "pull", "stop"})


async def test_logs_sin_follow_no_lleva_el_flag():
    assert "--follow" not in argumentos_accion("logs", ARCHIVO, follow=False)
    assert "--follow" in argumentos_accion("logs", ARCHIVO, follow=True)


async def test_accion_fuera_de_la_lista_se_rechaza():
    with pytest.raises(ValueError, match="no soportada"):
        argumentos_accion("rm", ARCHIVO)


async def test_no_pasa_perfiles_como_en_el_preview():
    # A diferencia del preview, aquí se quiere el comportamiento real: un `up`
    # arranca el perfil por defecto, no todos.
    assert "--profile" not in argumentos_accion("up", ARCHIVO)


async def test_timeout_por_accion():
    # Un plazo global tendría que ser el de `up` (900 s) y entonces un `down`
    # colgado tardaría quince minutos en avisar.
    assert timeout_de("stop") == 60.0
    assert timeout_de("down") == 60.0
    assert timeout_de("logs") == 60.0
    assert timeout_de("pull") == 600.0
    assert timeout_de("up") == 900.0


# --- Streaming -----------------------------------------------------------------


async def test_emite_los_trozos_hasta_el_fin(fake_spawn):
    fake_spawn.devolver(
        stdout_trozos=[b"Container tienda-web  Started\n", b"Container tienda-db  Started\n"]
    )

    trozos, resultado = await _recorrer("up")

    assert [t.data for t in trozos] == [
        "Container tienda-web  Started\n",
        "Container tienda-db  Started\n",
    ]
    assert all(t.stream == "stdout" for t in trozos)
    assert resultado.codigo == 0
    assert resultado.terminada is True


async def test_distingue_stdout_de_stderr(fake_spawn):
    fake_spawn.devolver(
        stdout_trozos=[b"salida\n"],
        stderr_trozos=[b"aviso\n"],
    )

    trozos, _ = await _recorrer("up")

    por_stream = {t.stream: t.data for t in trozos}
    assert por_stream["stdout"] == "salida\n"
    assert por_stream["stderr"] == "aviso\n"


async def test_lee_los_dos_pipes_en_paralelo(fake_spawn):
    # Leerlos en serie deja el otro lleno: un compose que escribe mucho a `stderr`
    # mientras se drena `stdout` se bloquea a sí mismo. Con dos lectores
    # concurrentes, los dos pipes avanzan.
    fake_spawn.devolver(
        stdout_trozos=[b"a" * 1000 for _ in range(20)],
        stderr_trozos=[b"b" * 1000 for _ in range(20)],
    )

    trozos, resultado = await _recorrer("up")

    assert resultado.codigo == 0
    assert sum(1 for t in trozos if t.stream == "stdout") >= 20
    assert sum(1 for t in trozos if t.stream == "stderr") >= 20


async def test_el_codigo_de_salida_llega_a_resultado(fake_spawn):
    # El generador no puede devolver un valor, así que el código se deja en el
    # objeto que el llamante pasa.
    fake_spawn.devolver(codigo=7, stdout_trozos=[b"falla\n"])

    _, resultado = await _recorrer("up")

    assert resultado.codigo == 7
    assert resultado.cancelada is False


async def test_elimina_los_codigos_de_escape_ansi(fake_spawn):
    # Sin TTY compose no colorea, pero si la versión del CLI cambia eso, el panel
    # acabaría pintando escapes dentro de un `<pre>`.
    fake_spawn.devolver(
        stdout_trozos=[b"\x1b[32mContainer web Started\x1b[0m\n"]
    )

    trozos, _ = await _recorrer("up")

    assert "\x1b" not in trozos[0].data
    assert "Container web Started" in trozos[0].data


async def test_normaliza_los_retornos_de_carro(fake_spawn):
    # Las líneas de progreso de compose usan un `\r` SUELO, sin `\n`. Si solo se
    # normalizaran los `\r\n`, el panel mostraría las tres superpuestas en vez de
    # la última.
    fake_spawn.devolver(stdout_trozos=[b"progreso 50%\rprogreso 100%\rlisto\n"])

    trozos, _ = await _recorrer("pull")

    assert "\r" not in trozos[0].data
    assert trozos[0].data.count("progreso") == 2


async def test_los_bytes_invalidos_no_tumban_el_streaming(fake_spawn):
    fake_spawn.devolver(stdout_trozos=[b"nombre=\xff\xfe\n"])

    trozos, resultado = await _recorrer("up")

    assert resultado.codigo == 0
    assert "nombre=" in trozos[0].data


async def test_cancelar_cierra_el_proceso(fake_spawn):
    # Es lo que hace el botón «Cancelar»: cortar el generador mata el proceso.
    # El caso realista es `logs --follow`: entrega líneas y luego se queda
    # esperando para siempre, sin EOF.
    fake_spawn.devolver(
        stdout_trozos=[b"una linea\n"],
        cuelga_solo="stdout",
    )

    resultado = ResultadoAccion()
    generador = ejecutar_accion("logs", ARCHIVO, resultado=resultado, follow=True)

    primero = await generador.__anext__()
    assert primero.data == "una linea\n"

    await generador.aclose()

    assert fake_spawn.proceso.killed is True
    assert fake_spawn.proceso.waited is True
    assert resultado.terminada is True


async def test_la_cancelacion_no_deja_procesos_vivos(fake_spawn):
    fake_spawn.devolver(cuelga_solo="stdout")

    generador = ejecutar_accion("up", ARCHIVO, resultado=ResultadoAccion())
    tarea = asyncio.create_task(generador.__anext__())
    await asyncio.sleep(0)
    tarea.cancel()
    with pytest.raises(asyncio.CancelledError):
        await tarea

    assert fake_spawn.proceso.killed is True


async def test_cli_ausente_durante_el_streaming(fake_spawn):
    fake_spawn.fallar_con(FileNotFoundError("docker"))

    with pytest.raises(ComposeCliAusente, match="Compose"):
        await _recorrer("up")


async def test_los_lectores_se_paran_al_cancelar(fake_spawn):
    # Si los lectores siguieran vivos después de cancelar, seguirían drenando un
    # proceso ya muerto y nadie los esperaría nunca.
    fake_spawn.devolver(cuelga_solo="stdout")

    generador = ejecutar_accion("logs", ARCHIVO, resultado=ResultadoAccion())
    tarea = asyncio.create_task(generador.__anext__())
    await asyncio.sleep(0.01)

    tarea.cancel()
    with pytest.raises(asyncio.CancelledError):
        await tarea

    pipe = fake_spawn.proceso.stdout
    lecturas = pipe.peticiones
    await asyncio.sleep(0.01)
    # Nadie vuelve a pedirle nada: los lectores están parados.
    assert pipe.peticiones == lecturas
    assert fake_spawn.proceso.killed is True
