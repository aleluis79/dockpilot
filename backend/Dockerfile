# DockPilot · backend (SPEC-00, imagen)
#
# Esta imagen es el caso difícil de los dos, y no por el Python: porque el
# backend NO habla solo con la API de Docker. `compose_cli.py` lanza el binario
# `docker compose` de verdad con `create_subprocess_exec`, así que la imagen
# necesita el CLI y el plugin compose instalados. Montar el socket sin el CLI
# levanta el panel entero salvo SPEC-13, y el fallo aparece como un 500 en el
# WebSocket de compose, no como un error de arranque.
#
# Se instala desde el repositorio oficial de Docker en lugar de copiar binarios
# desde la imagen `docker:cli`: esa imagen es Debian bookworm y la de Python
# puede venir de otra generación, y copiar /usr/local entre glibc distintas
# falla en runtime con un error que no dice nada de glibc.
#
# NO hay Dockerfile para el frontend aquí todavía: en producción el SPA necesita
# un reverse proxy que sirva el dist y reenvíe /api y /ws, y `server.proxy` de
# Vite es solo de desarrollo. Es un fichero aparte, no una etapa más.

FROM python:3.14-slim

# Los logs a stdout y no a un búfer: `PYTHONUNBUFFERED` es lo que evita el
# síntoma de "el contenedor está parado" cuando en realidad uvicorn tiene la
# salida acumulada en memoria y `docker logs` no muestra nada.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# `ca-certificates` y `curl` para el repositorio; `gnupg` solo para la clave y se
# va en la misma capa, porque dejarlo instalado suma superficie sin uso.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc; \
    chmod a+r /etc/apt/keyrings/docker.asc; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      > /etc/apt/sources.list.d/docker.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin; \
    apt-get purge -y --auto-remove gnupg; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /srv/app

# Las dependencias van en su propia capa y antes que el código, para que un
# cambio en `app/` no reinstale FastAPI entero. Es la razón principal para que
# exista el Dockerfile.
#
# `requirements.txt` trae pytest y httpx dentro, así que la imagen de runtime los
# lleva. No se separan porque ese fichero es también el que usa
# `make backend-install`, y partirlo tocaría el flujo de desarrollo a cambio de
# unos cuantos MB.
COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY app ./app

# `pyproject.toml` se copia porque ruff lo lee de ahí, aunque el runtime no
# linterice. `run.sh` NO se copia a propósito: hace `source .venv/bin/activate`
# y en la imagen no hay venv, así que dentro sería un script roto.
COPY pyproject.toml ./

# El usuario es root a propósito, y conviene decir por qué en lugar de
# dejarlo como si fuera un descuido:
#
# - El socket es de grupo `docker` con un GID que depende de la máquina
#   (973 en la de referencia). Un usuario no-root con un GID fijo dejaría de
#   hablar con el daemon en cuanto el host tuviera otro GID, y el panel
#   arrancaría sin que nada fallara visiblemente.
# - SPEC-15 escribe el temporal de un despliegue JUNTO al archivo compose del
#   usuario. Con un usuario no-root, cualquier directorio de proyecto que no sea
#   suyo devuelve un error de permisos.
# - Y sobre todo: montar el socket ya equivale a root en el host. Un usuario
#   no-root dentro del contenedor no añade una barrera real, solo un escalón.
#
# El endurecimiento de verdad, si se quiere, va en el compose y no aquí:
# `--user "$(id -u):$(id -g)"` junto a `--group-add <GID del grupo docker>`.
EXPOSE 8181

# Sin `curl` en la imagen, así que el sondeo usa la biblioteca estándar. Es el
# mismo endpoint que sirve el compose para su `depends_on: condition`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8181/health', timeout=4).status == 200 else 1)"]

# `0.0.0.0` y no `127.0.0.1`: dentro de un contenedor, escuchar en el loopback
# deja el puerto publicado sin nada detrás.
#
# El `--reload` de `make up` NO se reproduce aquí a propósito. El watcher de
# uvicorn y un sistema de ficheros de montaje son la peor pareja que hay, y en
# desarrollo el backend ya corre en el host.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8181"]