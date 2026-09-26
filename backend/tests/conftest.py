# SPDX-License-Identifier: AGPL-3.0-or-later
import asyncio
import pytest
import pytest_asyncio
from unittest.mock import AsyncMock, MagicMock
from httpx import AsyncClient, ASGITransport
from aiodocker.exceptions import DockerError

from app.main import app
from app.core.docker import get_docker
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
        except (asyncio.TimeoutError, TimeoutError):
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

    async def resize(self, h: int = None, w: int = None):
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
        ports: list = None,
        mounts: list = None,
        networks: dict = None,
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
            raise DockerError(409, {"message": "You cannot remove a running container. Stop the container before attempting removal or force remove"})
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
        for ref, detail in self.details.items():
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
                {"message": f"conflict: unable to delete {name} (must be forced) - image is being used by running container"},
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
                raise DockerError(
                    404,
                    {
                        "message": f"pull access denied for {base}, repository does not exist or may require 'docker login'"
                    },
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

    async def fake_create(config: dict, name: str = None):
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

    async def fake_query_json(endpoint: str, method: str = "GET", params: dict = None):
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
                "BuildCacheUsage": 123456789,
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


@pytest.fixture
def test_client(mock_docker):
    from starlette.testclient import TestClient
    app.dependency_overrides[get_docker] = lambda: mock_docker
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()
