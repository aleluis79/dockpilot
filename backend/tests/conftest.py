# SPDX-License-Identifier: AGPL-3.0-or-later
import asyncio
from dataclasses import dataclass
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from aiodocker.exceptions import DockerError, DockerStreamError
from httpx import ASGITransport, AsyncClient

from app.core.docker import get_docker
from app.main import app
from app.services.compose_cli import CHUNK
from tests.fake_volumes import FakeDockerVolumes


class FakeExecStream:
    def __init__(self):
        self.closed = False
        self.written_data = []
        self._output_queue = asyncio.Queue()

    async def _init(self):
        pass

    async def read_out(self):
        if self.closed and self._output_queue.empty():
            return None
        try:
            msg = await asyncio.wait_for(self._output_queue.get(), timeout=0.5)
            return msg
        except TimeoutError:
            return None

    async def write_in(self, data: bytes):
        self.written_data.append(data)
        if b"exit" in data:
            self.closed = True
        elif b"echo" in data:
            mock_msg = MagicMock()
            mock_msg.data = b"hola dockpilot\r\n"
            mock_msg.stream = 1
            await self._output_queue.put(mock_msg)

    async def close(self):
        self.closed = True


class FakeExec:
    def __init__(self, exec_id: str, tty: bool = True):
        self.id = exec_id
        self.tty = tty
        self.stream = FakeExecStream()
        self.resized_with = None

    async def resize(self, h: int | None = None, w: int | None = None):
        self.resized_with = {"h": h, "w": w}

    def start(self, timeout=None, detach=False):
        mock_prompt = MagicMock()
        mock_prompt.data = b"/ # "
        mock_prompt.stream = 1
        self.stream._output_queue.put_nowait(mock_prompt)
        return self.stream


class FakeDockerContainer:
    def __init__(
        self,
        cid: str,
        name: str,
        image: str,
        status: str,
        state: str,
        ports: list | None = None,
        mounts: list | None = None,
        networks: dict | None = None,
        labels: dict | None = None,
    ):
        self.id = cid
        self._name = name
        self._image = image
        self._status = status
        self._state = state
        self._ports = ports or []
        # Montajes de tipo volumen: es la unica fuente de que contenedor usa
        # que volumen, porque /volumes/{name} NO incluye campo Containers.
        self._mounts = mounts or []
        # Redes a las que esta conectado. Es la unica fuente para saber que
        # contenedor usa que red: `networks.list()` no trae ningun recuento
        # (SPEC-10 §3.1).
        self._networks = networks or {}
        # Etiquetas del resumen. El daemon real SI las incluye en
        # `/containers/json`; sin ellas no habria forma de saber a que proyecto
        # compose pertenece un contenedor (SPEC-11 §3.1).
        self._labels = labels or {}

    def _as_summary_dict(self):
        return {
            "Id": self.id,
            "Names": [self._name],
            "Image": self._image,
            "State": self._state,
            "Status": f"Up 2 hours ({self._status})" if self._status == "running" else f"Exited ({self._status})",
            "Created": 1727290000,
            "Ports": self._ports,
            "Mounts": self._mounts,
            "Labels": self._labels,
            "NetworkSettings": {"Networks": self._networks},
        }

    async def show(self):
        return {
            "Id": self.id,
            "Name": self._name,
            "Config": {
                "Image": self._image,
                "Cmd": ["nginx", "-g", "daemon off;"],
                "Env": ["PATH=/usr/local/sbin", "PORT=80"],
                "Labels": {"maintainer": "DockPilot"},
            },
            "State": {
                "Status": self._status,
                "Running": self._status == "running",
                "Paused": self._status == "paused",
                "Restarting": self._status == "restarting",
            },
            "Created": "2026-09-25T12:00:00Z",
            "HostConfig": {
                "PortBindings": {"80/tcp": [{"HostIp": "0.0.0.0", "HostPort": "8080"}]},
            },
            "Mounts": [{"Source": "/var/data", "Destination": "/app/data", "Mode": "rw"}],
            "NetworkSettings": {
                "Networks": {"bridge": {"IPAddress": "172.17.0.2"}}
            },
        }

    async def start(self):
        self._status = "running"
        self._state = "running"
        return True

    async def stop(self, t=10):
        self._status = "exited"
        self._state = "exited"
        return True

    async def restart(self, t=10):
        self._status = "running"
        self._state = "running"
        return True

    async def pause(self):
        self._status = "paused"
        self._state = "paused"
        return True

    async def unpause(self):
        self._status = "running"
        self._state = "running"
        return True

    async def delete(self, force=False, v=False):
        if self._status == "running" and not force:
            raise DockerError(
                409,
                {
                    "message": (
                        "You cannot remove a running container. "
                        "Stop the container before attempting removal or force remove"
                    )
                },
            )
        return True

    def _raw_stats_payload(self):
        """Payload crudo de /containers/{id}/stats con valores conocidos y calculables.

        CPU:        dCPU=1000, dSystem=10000, online_cpus=2 -> 20.0%
        Memoria:    usage=1000, inactive_file=500, limit=10000 -> 500 B (5.0%)
        Red:        eth0 rx=300, tx=700
        Bloque:     Read=111, Write=222
        """
        return {
            "read": "2026-09-26T10:00:00.000000000Z",
            "preread": "2026-09-26T09:59:58.000000000Z",
            "cpu_stats": {
                "cpu_usage": {"total_usage": 2000, "percpu_usage": [1000, 1000]},
                "system_cpu_usage": 20000,
                "online_cpus": 2,
            },
            "precpu_stats": {
                "cpu_usage": {"total_usage": 1000, "percpu_usage": [500, 500]},
                "system_cpu_usage": 10000,
                "online_cpus": 2,
            },
            "memory_stats": {
                "usage": 1000,
                "limit": 10000,
                "stats": {"inactive_file": 500},
            },
            "networks": {"eth0": {"rx_bytes": 300, "tx_bytes": 700}},
            "blkio_stats": {
                "io_service_bytes_recursive": [
                    {"op": "Read", "value": 111},
                    {"op": "Write", "value": 222},
                    {"op": "Sync", "value": 999},
                ]
            },
            "pids_stats": {"current": 5},
        }

    async def stats(self, stream=True, timeout=None):
        if self._status != "running":
            raise DockerError(409, {"message": f"Container {self.id} is not running"})
        if not stream:
            return [self._raw_stats_payload()]

        async def _stream():
            yield self._raw_stats_payload()
            yield self._raw_stats_payload()

        return _stream()

    async def log(self, stdout=True, stderr=True, follow=False, tail=100, timestamps=True):
        sample_logs = [
            "2026-09-25T12:00:01.000000000Z Server initializing...\n",
            "2026-09-25T12:00:02.000000000Z [info] Listening on 0.0.0.0:80\n",
            "2026-09-25T12:00:03.000000000Z [warn] High connection volume\n",
        ]
        if not follow:
            return sample_logs

        async def _stream():
            for line in sample_logs:
                yield line

        return _stream()

    async def exec(self, cmd, stdout=True, stderr=True, stdin=True, tty=True, **kwargs):
        if self._status != "running":
            raise DockerError(400, {"message": f"Container {self.id} is not running"})
        exec_instance = FakeExec(f"exec_{self.id}", tty=tty)
        return exec_instance


class FakeDockerImages:
    """Doble de `aiodocker.DockerImages` con la semántica observada en el daemon real.

    Detalles de fidelidad relevantes para SPEC-07:
    - `images.list()` incluye `Containers` y `RepoDigests`.
    - `inspect()` lanza `DockerError(404)` si la referencia no existe.
    - `delete()` lanza `DockerError(409)` si la imagen está en uso y no se fuerza.
    - `pull(stream=True)` es un método **síncrono** que devuelve un generador
      asíncrono, y el error del registro emerge **durante la iteración**, no al
      invocar `pull()` (comportamiento real de aiodocker 0.27.0).
    """

    def __init__(self):
        self.list_payload = [
            {
                "Id": "sha256:img1",
                "RepoTags": ["nginx:alpine", "nginx:latest"],
                "RepoDigests": ["nginx@sha256:aaa1"],
                "Size": 25000000,
                "Created": 1727290000,
                "Containers": 0,
            },
            {
                "Id": "sha256:img2",
                "RepoTags": ["redis:alpine"],
                "RepoDigests": [],
                "Size": 35000000,
                "Created": 1727280000,
                "Containers": 2,
            },
            {
                "Id": "sha256:img3",
                "RepoTags": ["<none>:<none>"],
                "RepoDigests": ["<none>@<none>"],
                "Size": 1000,
                "Created": 1727270000,
                "Containers": 0,
            },
        ]

        self.details = {
            "nginx:alpine": {
                "Id": "sha256:img1",
                "RepoTags": ["nginx:alpine", "nginx:latest"],
                "RepoDigests": ["nginx@sha256:aaa1"],
                "Size": 25000000,
                "Created": "2026-09-25T12:00:00Z",
                "Architecture": "amd64",
                "Os": "linux",
                "Config": {
                    "Cmd": ["nginx", "-g", "daemon off;"],
                    "Entrypoint": ["/docker-entrypoint.sh"],
                    "Env": ["PATH=/usr/local/sbin", "NGINX_VERSION=1.27"],
                    "ExposedPorts": {"80/tcp": {}, "443/tcp": {}},
                    "WorkingDir": "",
                    "User": "nginx",
                    "Labels": {"maintainer": "NGINX Docker Maintainers"},
                },
                "RootFS": {"Type": "layers", "Layers": ["l1", "l2", "l3"]},
            },
            "redis:alpine": {
                "Id": "sha256:img2",
                "RepoTags": ["redis:alpine"],
                "RepoDigests": [],
                "Size": 35000000,
                "Created": "2026-09-24T09:00:00Z",
                "Architecture": "amd64",
                "Os": "linux",
                "Config": {
                    "Cmd": ["redis-server"],
                    "Entrypoint": ["docker-entrypoint.sh"],
                    "Env": ["PATH=/usr/local/bin"],
                    "ExposedPorts": {"6379/tcp": {}},
                    "WorkingDir": "/data",
                    "User": "",
                    "Labels": {},
                },
                "RootFS": {"Type": "layers", "Layers": ["l1", "l2"]},
            },
        }

        self.histories = {
            "nginx:alpine": [
                {
                    "Id": "l3",
                    "Created": 1727290000,
                    "CreatedBy": "/bin/sh -c #(nop)  CMD [\"nginx\" \"-g\" \"daemon off;\"]",
                    "Size": 1200,
                    "Comment": "",
                    "Tags": None,
                },
                {
                    "Id": "l2",
                    "Created": 1727289000,
                    "CreatedBy": "RUN /bin/sh -c apk add --no-cache nginx",
                    "Size": 24000000,
                    "Comment": "",
                    "Tags": None,
                },
            ]
        }

        # Referencias que el "registro" no conoce, para probar el error del pull
        self.unknown_refs = {"no-existe-este-repo-xyz123"}
        # Referencias cuya historia falla, para probar la tolerancia del detalle
        self.history_error_refs: set = set()

    async def list(self, **kwargs):
        return self.list_payload

    def _resolve(self, name: str):
        if name in self.details:
            return self.details[name]
        for _ref, detail in self.details.items():
            if name == detail["Id"] or (name and name in detail["RepoTags"]):
                return detail
        return None

    async def inspect(self, name: str):
        detail = self._resolve(name)
        if detail is None:
            raise DockerError(404, {"message": f"No such image: {name}"})
        return detail

    async def history(self, name: str):
        detail = self._resolve(name)
        if detail is None:
            raise DockerError(404, {"message": f"No such image: {name}"})
        if any(name == ref or name in self.details[ref]["RepoTags"] for ref in self.history_error_refs):
            raise DockerError(500, {"message": "history no disponible"})
        return self.histories.get(name, [])

    async def delete(self, name: str, *, force: bool = False, noprune: bool = False):
        detail = self._resolve(name)
        if detail is None:
            raise DockerError(404, {"message": f"No such image: {name}"})
        in_use = False
        for entry in self.list_payload:
            if entry["Id"] == detail["Id"]:
                in_use = entry.get("Containers", 0) > 0
        if in_use and not force:
            raise DockerError(
                409,
                {
                    "message": (
                        f"conflict: unable to delete {name} (must be forced) - "
                        "image is being used by running container"
                    )
                },
            )
        return [{"Untagged": detail["RepoTags"][1:]}] if len(detail["RepoTags"]) > 1 else []

    def _progress_events(self, ref: str) -> list:
        """Eventos con la misma forma que emite el daemon real (verificado)."""
        return [
            {"status": f"Pulling from library/{ref.split(':')[0]}", "id": ref.split(":")[-1]},
            {"status": "Pulling fs layer", "progressDetail": {}, "id": "4f55086f7dd0"},
            {
                "status": "Downloading",
                "progressDetail": {"current": 1024, "total": 4096},
                "id": "4f55086f7dd0",
            },
            {"status": "Download complete", "progressDetail": {}, "id": "4f55086f7dd0"},
            {"status": "Extracting", "progressDetail": {"current": 4096, "total": 4096}, "id": "4f55086f7dd0"},
            {"status": "Pull complete", "progressDetail": {}, "id": "4f55086f7dd0"},
            {"status": "Digest: sha256:5e23090353324d887c48ad5e5c56d294eab81588df9605b07d1afe895f9cc8f8"},
            {"status": f"Status: Downloaded newer image for {ref}"},
        ]

    def pull(
        self,
        from_image: str,
        *,
        tag: str | None = None,
        repo: str | None = None,
        platform: str | None = None,
        auth=None,
        stream: bool = False,
        timeout=None,
    ):
        ref = from_image if not tag else f"{from_image}:{tag}"
        base = ref.split(":")[0]

        # El error emerge durante la iteración, igual que con aiodocker real
        async def _stream():
            if base in self.unknown_refs:
                # Esto es lo que hace aiodocker 0.27 de verdad: el daemon
                # responde 200 y mete el error como chunk del stream, así que
                # lo que se levanta es `DockerStreamError` con `status=0` (para
                # la petición HTTP no hubo fallo) y el código real en
                # `error_detail`. Levantar `DockerError(404, ...)` era la forma
                # de las versiones antiguas y enmascaraba el bug del `code: 0`.
                raise DockerStreamError(
                    f"pull access denied for {base}, "
                    "repository does not exist or may require 'docker login'",
                    error_detail={"code": 404},
                )
            for event in self._progress_events(ref):
                yield event

        if stream:
            return _stream()
        return _collect(_stream())


class FakeDockerNetwork:
    """Devuelto por `await networks.get(nombre)`; imita a `DockerNetwork`."""

    def __init__(self, payload: dict, owner: "FakeDockerNetworks"):
        self._payload = payload
        self._owner = owner

    async def show(self) -> dict:
        if self._payload["Name"] not in self._owner.networks:
            raise DockerError(404, {"message": "network not found"})
        return self._owner.show_payload(self._payload["Name"])

    async def delete(self) -> bool:
        return self._owner.delete(self._payload["Name"])


class FakeDockerNetworks:
    """Doble de `aiodocker.DockerNetworks` con la semántica observada en el daemon real.

    Detalles de fidelidad relevantes para SPEC-10:
    - `list()` devuelve una **lista de dicts** (a diferencia de `volumes.list()`,
      que devuelve un dict) y **sin ningun campo `Containers` ni recuento**.
    - `get()` es una **corrutina**: hay que hacer `await` antes de encadenar.
    - No hay `delete` en el nivel de `DockerNetworks`; se borra via `get().delete()`.
    - `DockerNetwork.delete()` **no admite parametros**: no hay forma de pedir `force`.
    - `IPAM.Config` es `null` en `none` y `host`, y una lista de dicts en el resto.
    """

    BUILTIN = ("none", "host", "bridge")

    def __init__(self):
        self.networks = {
            "bridge": {
                "Name": "bridge", "Id": "net-bridge", "Created": "2026-06-07T09:34:28.089537938-03:00",
                "Scope": "local", "Driver": "bridge", "EnableIPv4": True, "EnableIPv6": False,
                "IPAM": {"Driver": "default", "Options": None,
                         "Config": [{"Subnet": "172.17.0.0/16", "Gateway": "172.17.0.1"}]},
                "Internal": False, "Attachable": False, "Ingress": False,
                "ConfigFrom": {"Network": ""}, "ConfigOnly": False,
                "Options": {}, "Labels": {},
            },
            "host": {
                "Name": "host", "Id": "net-host", "Created": "2026-06-07T09:34:28.089537938-03:00",
                "Scope": "local", "Driver": "host", "EnableIPv4": True, "EnableIPv6": False,
                "IPAM": {"Driver": "default", "Options": None, "Config": None},
                "Internal": False, "Attachable": False, "Ingress": False,
                "ConfigFrom": {"Network": ""}, "ConfigOnly": False,
                "Options": {}, "Labels": {},
            },
            "none": {
                "Name": "none", "Id": "net-none", "Created": "2026-06-07T09:34:28.089537938-03:00",
                "Scope": "local", "Driver": None, "EnableIPv4": True, "EnableIPv6": False,
                "IPAM": {"Driver": "default", "Options": None, "Config": None},
                "Internal": False, "Attachable": False, "Ingress": False,
                "ConfigFrom": {"Network": ""}, "ConfigOnly": False,
                "Options": {}, "Labels": {},
            },
            "app-net": {
                "Name": "app-net", "Id": "net-app", "Created": "2026-07-01T10:00:00.000000000-03:00",
                "Scope": "local", "Driver": "bridge", "EnableIPv4": True, "EnableIPv6": False,
                "IPAM": {"Driver": "default", "Options": None,
                         "Config": [{"Subnet": "172.18.0.0/16", "Gateway": "172.18.0.1"}]},
                "Internal": False, "Attachable": True, "Ingress": False,
                "ConfigFrom": {"Network": ""}, "ConfigOnly": False,
                "Options": {"com.docker.network.bridge.default_bridge": "true"},
                "Labels": {"com.docker.compose.project": "app"},
            },
            "huerfana": {
                "Name": "huerfana", "Id": "net-huerfana", "Created": "2026-08-15T18:20:00.000000000-03:00",
                "Scope": "local", "Driver": "bridge", "EnableIPv4": True, "EnableIPv6": False,
                "IPAM": {"Driver": "default", "Options": None,
                         "Config": [{"Subnet": "172.19.0.0/16", "Gateway": "172.19.0.1"}]},
                "Internal": True, "Attachable": False, "Ingress": False,
                "ConfigFrom": {"Network": ""}, "ConfigOnly": False,
                "Options": {}, "Labels": {},
            },
        }
        # Contenedores por red, para que show() sepa a quienNombrar
        self.connected = {
            "bridge": {"c123": "web-app"},
            "app-net": {"c123": "web-app"},
        }
        self.create_error = None
        self.create_calls = []

    async def list(self, **kwargs) -> list:
        # Devuelve una copia superficial: el codigo de produccion no debe poder
        # mutar el estado del doble a traves de la respuesta.
        return [dict(item) for item in self.networks.values()]

    async def get(self, name: str) -> FakeDockerNetwork:
        if name not in self.networks:
            raise DockerError(404, {"message": "network not found"})
        return FakeDockerNetwork(self.networks[name], self)

    async def create(self, config: dict) -> FakeDockerNetwork:
        if self.create_error is not None:
            raise self.create_error
        self.create_calls.append(config)
        name = config["Name"]
        if name in self.networks:
            raise DockerError(409, {"message": f"network with name {name} already exists"})
        subnet = (config.get("IPAM") or {}).get("Config") or [{}]
        self.networks[name] = {
            "Name": name, "Id": f"net-{name}", "Created": "2026-09-26T12:00:00.000000000-03:00",
            "Scope": "local", "Driver": config.get("Driver", "bridge"),
            "EnableIPv4": True, "EnableIPv6": False,
            "IPAM": {"Driver": "default", "Options": None,
                     "Config": [{"Subnet": subnet[0].get("Subnet", ""),
                                 "Gateway": subnet[0].get("Gateway", "")}]},
            "Internal": bool(config.get("Internal")),
            "Attachable": False, "Ingress": False,
            "ConfigFrom": {"Network": ""}, "ConfigOnly": False,
            "Options": {}, "Labels": config.get("Labels") or {},
        }
        self.connected.setdefault(name, {})
        return FakeDockerNetwork(self.networks[name], self)

    async def prune(self, *, filters=None) -> dict:
        deleted = []
        for name in list(self.networks):
            if name in self.BUILTIN:
                continue
            if self.connected.get(name):
                continue
            del self.networks[name]
            self.connected.pop(name, None)
            deleted.append(name)
        return {"NetworksDeleted": deleted}

    def show_payload(self, name: str) -> dict:
        payload = dict(self.networks[name])
        payload["Containers"] = {
            cid: {
                "Name": name_c,
                "EndpointID": f"ep-{cid}",
                "MacAddress": "02:42:ac:11:00:02",
                "IPv4Address": "172.18.0.2/16",
                "IPv6Address": "",
            }
            for cid, name_c in (self.connected.get(name) or {}).items()
        }
        payload["Status"] = {"IPAM": {}}
        return payload

    def delete(self, name: str) -> bool:
        if name in self.BUILTIN:
            raise DockerError(403, {"message": "network is predefined and cannot be removed"})
        if self.connected.get(name):
            raise DockerError(409, {"message": "network has active endpoints"})
        del self.networks[name]
        self.connected.pop(name, None)
        return True


class FakeDockerSystem:
    """Doble de `docker.system`, que solo expone `info()`."""

    def __init__(self):
        self.error = None

    async def info(self):
        if self.error is not None:
            raise self.error
        return {
            "ID": "XVSR:QMVO:GH7L:6N2D:KLOM:5YHZ:EQ5A:F2UX:RS5U:3ZQ7",
            "Containers": 2,
            "ContainersRunning": 1,
            "ContainersPaused": 0,
            "ContainersStopped": 1,
            "Images": 2,
            "Driver": "overlayfs",
            "DockerRootDir": "/var/lib/docker",
            "Name": "dockpilot-test",
            "ServerVersion": "29.8.1",
            "OperatingSystem": "Debian GNU/Linux 13 (trixie)",
            "OSType": "linux",
            "Architecture": "x86_64",
            "NCPU": 12,
            "MemTotal": 32827215872,
            "KernelVersion": "6.12.0",
        }


async def _collect(agen):
    return [event async for event in agen]


@pytest.fixture
def mock_docker():
    mock = MagicMock()

    # Setup mock containers repository
    c_running = FakeDockerContainer(
        cid="c123",
        name="/web-app",
        image="nginx:alpine",
        status="running",
        state="running",
        ports=[{"IP": "0.0.0.0", "PrivatePort": 80, "PublicPort": 8080, "Type": "tcp"}],
        mounts=[
            {
                "Type": "volume",
                "Name": "datos-app",
                "Source": "/var/lib/docker/volumes/datos-app/_data",
                "Destination": "/var/lib/postgresql/data",
                "RW": True,
            }
        ],
        networks={
            "bridge": {"IPAddress": "172.17.0.2", "Gateway": "172.17.0.1"},
            "app-net": {"IPAddress": "172.18.0.2", "Gateway": "172.18.0.1"},
        },
    )
    c_exited = FakeDockerContainer(
        cid="c456",
        name="/db-postgres",
        image="postgres:16",
        status="exited",
        state="exited",
        ports=[],
    )

    containers_db = {"c123": c_running, "c456": c_exited}

    async def fake_list(all=True, filters=None):
        res = []
        status_filter = None
        if filters and "status" in filters:
            status_filter = filters["status"]
            if isinstance(status_filter, list):
                status_filter = status_filter[0]

        for c in containers_db.values():
            if status_filter and c._status != status_filter:
                continue
            if not all and c._status != "running":
                continue
            res.append(c._as_summary_dict())
        return res

    async def fake_get(cid: str):
        if cid in containers_db:
            return containers_db[cid]
        raise DockerError(404, {"message": f"No such container: {cid}"})

    async def fake_create(config: dict, name: str | None = None):
        c_name = f"/{name}" if name else f"/mock-{len(containers_db)+1}"
        for existing in containers_db.values():
            if existing._name == c_name:
                raise DockerError(409, {"message": f"Conflict. The container name \"{c_name}\" is already in use"})

        cid = f"new_{len(containers_db)+1:04d}"
        new_c = FakeDockerContainer(
            cid=cid,
            name=c_name,
            image=config.get("Image", "unknown"),
            status="created",
            state="created",
            ports=[],
        )
        containers_db[cid] = new_c
        return new_c

    mock.containers = MagicMock()
    mock.containers.list = AsyncMock(side_effect=fake_list)
    mock.containers.get = AsyncMock(side_effect=fake_get)
    mock.containers.create = AsyncMock(side_effect=fake_create)
    mock.containers_db = containers_db

    # Setup mock images repository (doble con semántica de daemon, SPEC-07)
    fake_images = FakeDockerImages()

    # Setup mock volumes repository (doble con semántica de aiodocker, SPEC-08)
    fake_volumes = FakeDockerVolumes()

    async def fake_query_json(
        endpoint: str, method: str = "GET", params: dict | None = None
    ):
        if endpoint == "images/search":
            term = (params or {}).get("term", "")
            return [
                {"name": f"{term}", "description": f"Official {term} image", "is_official": True, "star_count": 15000},
                {"name": f"bitnami/{term}", "description": f"Bitnami {term}", "is_official": False, "star_count": 1200},
            ]
        if endpoint == "system/df":
            # /system/df: el tamaño de cada volumen vive bajo UsageData (SPEC-08 §3.1)
            return {
                "LayersSize": 5106255209,
                "Images": [],
                "Containers": [],
                "Volumes": [],
                "BuildCache": [],
                # El daemon devuelve este bloque como OBJETO (`TotalCount`,
                # `ActiveCount`, `TotalSize`, `Reclaimable`, `Items`), igual que
                # los demás `<X>Usage`. Poner aquí un entero fue lo que dejó
                # `build_cache_size` en 0 sin que ningún test se enterase.
                "BuildCacheUsage": {
                    "TotalCount": 3,
                    "ActiveCount": 1,
                    "TotalSize": 123456789,
                    "Reclaimable": 98765432,
                    "Items": [],
                },
                "ImageUsage": {
                    "TotalCount": 2,
                    "ActiveCount": 1,
                    "TotalSize": 5106255209,
                    "Reclaimable": 4223809473,
                    "Items": [
                        {
                            "Id": "sha256:aaa111",
                            "Names": ["postgres:16-alpine"],
                            "Size": 883261440,
                            "SharedSize": 0,
                            "Containers": 1,
                        },
                        {
                            "Id": "sha256:bbb222",
                            "Names": ["tmp/builder-leftover:latest"],
                            "Size": 4222993769,
                            "SharedSize": 0,
                            "Containers": 0,
                        },
                    ],
                },
                "ContainerUsage": {
                    "TotalCount": 2,
                    "ActiveCount": 1,
                    "TotalSize": 106496,
                    "Reclaimable": 24576,
                    "Items": [
                        {
                            "Id": "c123000000001",
                            "Names": ["web-app"],
                            "Size": 90112,
                            "SharedSize": 0,
                        },
                        {
                            "Id": "c456000000002",
                            "Names": ["web-app-cache"],
                            "Size": 16384,
                            "SharedSize": 0,
                        },
                    ],
                },
                "VolumeUsage": {
                    "TotalCount": len(fake_volumes.list_payload["Volumes"]),
                    "ActiveCount": 1,
                    "TotalSize": 158478691,
                    "Reclaimable": 53747987,
                    "Items": [
                        {
                            "Name": item["Name"],
                            "UsageData": item["UsageData"],
                        }
                        for item in fake_volumes.usage_items
                    ],
                },
            }
        return []

    fake_system = FakeDockerSystem()
    mock.images = fake_images
    mock.volumes = fake_volumes
    fake_networks_obj = FakeDockerNetworks()
    mock.networks = fake_networks_obj
    mock.system = fake_system
    mock._query_json = AsyncMock(side_effect=fake_query_json)
    mock.close = AsyncMock()
    return mock


@pytest_asyncio.fixture
async def async_client(mock_docker):
    app.dependency_overrides[get_docker] = lambda: mock_docker
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
    app.dependency_overrides.clear()


# --- Escenario de Docker Compose (SPEC-11) -------------------------------------
#
# Replica el host de referencia, con sus tres proyectos y los dos casos que
# rompian una implementacion ingenua:
#   - `elasticsearch-local`: vivo, 2 servicios, 1 red, 1 volumen.
#   - `simp-sica` y `tickets-app`: SIN contenedores pero con volumenes, que es
#     exactamente lo que `docker compose ls` no muestra (SPEC-11 §3.2).
#   - un contenedor sin etiqueta de proyecto y un volumen con `Labels: None`.

def _compose_labels(project: str, service: str = "", number: str = "1") -> dict:
    labels = {
        "com.docker.compose.project": project,
        "com.docker.compose.version": "5.5.1",
        "com.docker.compose.config-hash": f"hash-{project}",
        "com.docker.compose.oneoff": "False",
        "com.docker.compose.container-number": number,
    }
    if service:
        labels["com.docker.compose.service"] = service
        labels["com.docker.compose.image"] = f"sha256:{'a' * 8}{project}{service}"[:71]
        labels["com.docker.compose.project.config_files"] = (
            f"/home/usuario/proyectos/{project}/docker-compose.yml"
        )
        labels["com.docker.compose.project.working_dir"] = (
            f"/home/usuario/proyectos/{project}"
        )
    return labels


def _añadir_volumen(repo, name: str, labels, driver: str = "local") -> None:
    repo.list_payload["Volumes"].append(
        {
            "Name": name,
            "Driver": driver,
            "Scope": "local",
            "Mountpoint": f"/var/lib/docker/volumes/{name}/_data",
            "CreatedAt": "2026-09-01T10:00:00-03:00",
            "Labels": labels,
            "Options": None,
        }
    )
    repo.details[name] = {
        **repo.list_payload["Volumes"][-1],
        "Options": {},
    }


@pytest.fixture
def mock_compose_docker(mock_docker):
    """Extiende `mock_docker` con el escenario compose del host de referencia.

    Los dobles de red y volumen son mutables y se leen por iteracion, asi que
    basta con anadir entradas: `networks.list()` y `volumes.list()` las recogen
    sin tocar el resto de tests.
    """
    # Proyecto vivo: dos servicios, como `elasticsearch` y `elasticvue`.
    for cid, nombre, servicio in (
        ("c901", "elasticsearch", "elasticsearch"),
        ("c902", "elasticvue", "elasticvue"),
    ):
        mock_docker.containers_db[cid] = FakeDockerContainer(
            cid=cid,
            name=f"/{nombre}",
            image="docker.elastic.co/elasticsearch/elasticsearch:9.1.3",
            status="running",
            state="running",
            labels=_compose_labels("elasticsearch-local", servicio),
        )

    # Proyecto con el contenedor parado: NO es huerfano, tiene recursos vivos.
    mock_docker.containers_db["c903"] = FakeDockerContainer(
        cid="c903",
        name="/web-stopped",
        image="nginx:alpine",
        status="exited",
        state="exited",
        labels=_compose_labels("tienda", "web"),
    )

    # Servicio con tres replicas: se agrupan bajo un mismo servicio.
    for numero in ("1", "2", "3"):
        cid = f"c91{numero}"
        mock_docker.containers_db[cid] = FakeDockerContainer(
            cid=cid,
            name=f"/tienda-api-{numero}",
            image="mi/api:1.0",
            status="running" if numero != "3" else "exited",
            state="running" if numero != "3" else "exited",
            labels=_compose_labels("tienda", "api", numero),
        )

    # Contenedor sin etiqueta de proyecto: cuenta como `unlabelled_containers`.
    mock_docker.containers_db["c999"] = FakeDockerContainer(
        cid="c999",
        name="/full-editor-db",
        image="postgres:16",
        status="exited",
        state="exited",
    )

    # Red con nombre logico `elastic` y nombre real prefijado (SPEC-11 §3.2).
    mock_docker.networks.networks["elasticsearch-local_elastic"] = {
        "Name": "elasticsearch-local_elastic",
        "Id": "net-elastic",
        "Created": "2026-09-20T09:00:00.000000000-03:00",
        "Scope": "local",
        "Driver": "bridge",
        "EnableIPv4": True,
        "EnableIPv6": False,
        "IPAM": {
            "Driver": "default",
            "Options": None,
            "Config": [{"Subnet": "172.20.0.0/16", "Gateway": "172.20.0.1"}],
        },
        "Internal": False,
        "Attachable": True,
        "Ingress": False,
        "ConfigFrom": {"Network": ""},
        "ConfigOnly": False,
        "Options": {},
        "Labels": {
            "com.docker.compose.project": "elasticsearch-local",
            "com.docker.compose.network": "elastic",
            "com.docker.compose.version": "5.5.1",
        },
    }

    # Volumenes de los dos proyectos huerfanos: 3 + 4, sin un solo contenedor.
    for nombre in ("postgres_data", "app_data", "cache"):
        _añadir_volumen(
            mock_docker.volumes,
            f"simp-sica_{nombre}",
            {
                "com.docker.compose.project": "simp-sica",
                "com.docker.compose.volume": nombre,
                "com.docker.compose.version": "5.5.1",
            },
        )
    for nombre in ("api-data", "api-db-data", "api-uploads", "keycloak-db-data"):
        _añadir_volumen(
            mock_docker.volumes,
            f"tickets-app_{nombre}",
            {
                "com.docker.compose.project": "tickets-app",
                "com.docker.compose.volume": nombre,
                "com.docker.compose.version": "5.5.1",
            },
        )

    # Volumen del proyecto vivo, con su nombre logico sin prefijo en la etiqueta.
    _añadir_volumen(
        mock_docker.volumes,
        "elasticsearch-local_elasticsearch_data",
        {
            "com.docker.compose.project": "elasticsearch-local",
            "com.docker.compose.volume": "elasticsearch_data",
            "com.docker.compose.version": "5.5.1",
        },
    )

    # Tiene etiquetas pero NO es de compose: no debe crear un proyecto (SPEC-11 §3.2).
    _añadir_volumen(
        mock_docker.volumes,
        "aa342f746404c4a57823f40a9bccdc6cc78a2520701d2507f050b5aa5dcc9c09",
        {"com.docker.volume.anonymous": ""},
    )

    return mock_docker


@pytest_asyncio.fixture
async def compose_client(mock_compose_docker):
    app.dependency_overrides[get_docker] = lambda: mock_compose_docker
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
    app.dependency_overrides.clear()


@pytest.fixture
def test_client(mock_docker):
    from starlette.testclient import TestClient
    app.dependency_overrides[get_docker] = lambda: mock_docker
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()


# --- SPEC-12: doble del proceso de compose ------------------------------------
#
# Sustituye el PUNTO DE INYECCIÓN (`compose_cli._spawn`), no el binario: los
# tests no ejecutan `docker compose` nunca. El doble modela el contrato del
# proceso que asyncio entrega, porque eso es justo lo que hay que probar (los
# dos pipes por separado, `wait()` y `kill()`), no el binario de Docker.


class FakePipe:
    """Un pipe del proceso.

    `read(n)` entrega los trozos que se le pidan, como un stream real. SPEC-12
    lee el pipe entero de una vez y SPEC-13 lo lee por trozos, así que se
    implementa el caso general y ambos modos funcionan.
    """

    def __init__(self, trozos: list[bytes] | bytes | None = None) -> None:
        if isinstance(trozos, bytes):
            self._trozos = [trozos] if trozos else []
        else:
            self._trozos = list(trozos or [])
        self.peticiones = 0

    async def read(self, n: int = CHUNK) -> bytes:
        self.peticiones += 1
        if not self._trozos:
            return b""
        if len(self._trozos) == 1:
            return self._trozos.pop(0)
        return self._trozos.pop(0)[:n]


class PipeColgado(FakePipe):
    """Un pipe que nunca entrega nada ni EOF: para probar la cancelación."""

    async def read(self, n: int = CHUNK) -> bytes:
        await asyncio.Event().wait()
        return b""  # pragma: no cover - inalcanzable a propósito


class PipeQueEmiteYNoTermina(FakePipe):
    """Entrega sus trozos y luego se queda esperando para siempre.

    Es lo que hace de verdad `logs --follow`: llegan líneas, el proceso no muere
    y el EOF no llega nunca. Es el caso que justifica el botón «Cancelar».
    """

    async def read(self, n: int = CHUNK) -> bytes:
        if self._trozos:
            return self._trozos.pop(0)
        await asyncio.Event().wait()
        return b""  # pragma: no cover - inalcanzable a propósito


class FakeProcess:
    """Proceso falso con la misma superficie que `asyncio.subprocess.Process`.

    Solo implementa lo que el runner usa: `stdout`, `stderr`, `wait()` y
    `kill()`. Modelar el contrato del proceso, y no el binario de Docker, es lo
    que permite probar la lógica sin ejecutar nada.
    """

    def __init__(
        self,
        *,
        codigo: int = 0,
        stdout: bytes = b"",
        stderr: bytes = b"",
        stdout_trozos: list[bytes] | None = None,
        stderr_trozos: list[bytes] | None = None,
        cuelga: bool = False,
        cuelga_solo: str | None = None,
        sin_kill: bool = False,
    ) -> None:
        self._codigo = codigo
        self._cuelga = cuelga
        self.sin_kill = sin_kill
        self.returncode: int | None = None
        self.killed = False
        self.waited = False

        # `cuelga` cuelga los dos pipes (SPEC-12, donde se leen enteros).
        # `cuelga_solo` cuelga uno: es el caso de `logs --follow`, donde `stdout`
        # entrega líneas pero nunca termina y `stderr` sí cierra.
        if cuelga:
            self.stdout = PipeColgado()
            self.stderr = PipeColgado()
        else:
            self.stdout = self._pipe("stdout", cuelga_solo, stdout_trozos, stdout)
            self.stderr = self._pipe("stderr", cuelga_solo, stderr_trozos, stderr)

    @staticmethod
    def _pipe(nombre, cuelga_solo, trozos, plano):
        """Elige el tipo de pipe según lo que se le pida.

        `cuelga_solo="<pipe>"` con trozos = emite y luego no termina (`--follow`).
        `cuelga_solo="<pipe>"` sin trozos = no entrega nada (cancelación temprana).
        """
        solo = cuelga_solo == nombre
        if solo and trozos:
            return PipeQueEmiteYNoTermina(trozos)
        if solo:
            return PipeColgado()
        return FakePipe(trozos if trozos is not None else plano)

    async def wait(self) -> int:
        if self._cuelga and not self.killed:
            # Sin `kill()` un proceso colgado no termina nunca: es el caso que
            # obliga al runner a tener un temporizador.
            await asyncio.Event().wait()
        self.waited = True
        if self.killed:
            self.returncode = -9
        else:
            self.returncode = self._codigo
        return self.returncode

    def kill(self) -> None:
        if self.sin_kill:
            return
        self.killed = True


@dataclass
class SpawnCall:
    """Una invocación registrada, para asertar sobre argumentos y entorno."""

    args: list[str]
    cwd: str
    env: dict[str, str]


class ManejadorSpawn:
    """Programa la respuesta del proceso falso y expone lo registrado."""

    def __init__(self) -> None:
        self.calls: list[SpawnCall] = []
        self.proceso: FakeProcess | None = None
        self.error: Exception | None = None
        self._por_defecto = True

    def devolver(self, **kwargs) -> None:
        self.proceso = FakeProcess(**kwargs)
        self.error = None
        self._por_defecto = False

    def fallar_con(self, error: Exception) -> None:
        self.error = error

    @property
    def ultima(self) -> SpawnCall:
        return self.calls[-1]


@pytest.fixture
def fake_spawn(monkeypatch) -> ManejadorSpawn:
    """Sustituye `compose_cli._crear_proceso` por un proceso falso.

    Sin programar nada, responde con `{}` y código 0, que es lo que devuelve un
    compose al que no le pasa nada. Nunca se ejecuta el binario real.
    """
    from app.services import compose_cli

    manejador = ManejadorSpawn()
    manejador.proceso = FakeProcess(stdout=b"{}")

    async def _falso(args, cwd, env):
        manejador.calls.append(SpawnCall(args=list(args), cwd=cwd, env=dict(env)))
        if manejador.error is not None:
            raise manejador.error
        if manejador._por_defecto:
            manejador.proceso = FakeProcess(stdout=b"{}")
        return manejador.proceso

    monkeypatch.setattr(compose_cli, "_crear_proceso", _falso)
    return manejador


@pytest.fixture
def spawn_call(monkeypatch) -> list[dict]:
    """Captura los argumentos reales con los que se crea el proceso.

    Permite comprobar `stdin`, `stdout`, `stderr` y la ausencia de `shell`, que
    son obligaciones del runner que el doble de proceso no puede observar.
    """
    from app.services import compose_cli

    capturados: list[dict] = []

    async def _falso(*args, **kwargs):
        capturados.append({"args": list(args), **kwargs})
        return FakeProcess(stdout=b"{}")

    monkeypatch.setattr(compose_cli.asyncio, "create_subprocess_exec", _falso)
    return capturados


@pytest_asyncio.fixture
async def plan_client(mock_docker):
    """Cliente HTTP para el endpoint de previsualización.

    El plan no necesita el daemon: el doble de compose es el que responde. Se
    usa `mock_docker` igualmente porque el router completo se construye al
    importar la app.
    """
    app.dependency_overrides[get_docker] = lambda: mock_docker
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
    app.dependency_overrides.clear()


@pytest.fixture
def archivo(tmp_path, monkeypatch):
    """Un compose válido en disco, dentro de la raíz del explorador.

    Las rutas se validan **antes** de contactar con el CLI, así que cualquier test
    que vaya al comando necesita un archivo real. Lo comparten SPEC-12 y SPEC-13.

    Se ancla `COMPOSE_BROWSE_ROOT` a `tmp_path` porque las rutas de estos specs
    pasan por el mismo confinamiento que el explorador (SPEC-14 §3.2): sin esto,
    un archivo de `/tmp/pytest-...` quedaba fuera de la raíz y el endpoint
    respondía 403 antes de llegar al CLI.
    """
    from app.core import config

    monkeypatch.setattr(config.settings, "COMPOSE_BROWSE_ROOT", str(tmp_path))

    ruta = tmp_path / "docker-compose.yml"
    ruta.write_text("services:\n  web:\n    image: nginx:1.27\n")
    return ruta
