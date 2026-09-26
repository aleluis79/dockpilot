# SPDX-License-Identifier: AGPL-3.0-or-later
"""Doble de `aiodocker.volumes` con la semántica real de aiodocker 0.27.0.

Fidelidad relevante para SPEC-08:
- `list()` devuelve el **dict** completo `{"Volumes": [...], "Warnings": [...]}`
  (no una lista). Iterarlo directamente produce `'str' object has no attribute
  'get'`, que es exactamente el error que sufre una implementación ingenua.
- `DockerVolumes` **no tiene `delete`**: hay que usar `get(name).delete()`.
- El tamaño y el contador de referencias **no** vienen en `/volumes`, sino en
  `/system/df` y anidados bajo `UsageData`.
"""

from aiodocker.exceptions import DockerError

ANON_A = "aa342f746404c4a57823f40a9bccdc6cc78a2520701d2507f050b5aa5dcc9c09"
ANON_B = "79fcfb484649ca825bef98d38e6cb6c10d10066df40a9c48a767dff6de91bff0"


class FakeVolumeInstance:
    """Equivale a `aiodocker.volumes.DockerVolume`."""

    def __init__(self, repo: "FakeDockerVolumes", name: str) -> None:
        self._repo = repo
        self.name = name

    async def show(self) -> dict:
        return self._repo.details[self.name]

    async def delete(self, force: bool = False) -> bool:
        return self._repo._delete(self.name, force=force)


class FakeDockerVolumes:
    def __init__(self) -> None:
        # Claves reales de una entrada de GET /volumes (sin UsageData)
        self.list_payload = {
            "Volumes": [
                {
                    "Name": "datos-app",
                    "Driver": "local",
                    "Scope": "local",
                    "Mountpoint": "/var/lib/docker/volumes/datos-app/_data",
                    "CreatedAt": "2026-09-20T10:00:00-03:00",
                    "Labels": {"app": "dockpilot"},
                    "Options": None,
                },
                {
                    "Name": "temporal",
                    "Driver": "local",
                    "Scope": "local",
                    "Mountpoint": "/var/lib/docker/volumes/temporal/_data",
                    "CreatedAt": "2026-09-21T11:30:00-03:00",
                    "Labels": None,
                    "Options": None,
                },
                {
                    "Name": ANON_A,
                    "Driver": "local",
                    "Scope": "local",
                    "Mountpoint": f"/var/lib/docker/volumes/{ANON_A}/_data",
                    "CreatedAt": "2026-09-22T09:15:00-03:00",
                    "Labels": None,
                    "Options": None,
                },
                {
                    "Name": "sin-usage",
                    "Driver": "local",
                    "Scope": "local",
                    "Mountpoint": "/var/lib/docker/volumes/sin-usage/_data",
                    "CreatedAt": "2026-09-23T08:00:00-03:00",
                    "Labels": None,
                    "Options": None,
                },
            ],
            "Warnings": None,
        }

        # Detalle ampliado que devuelve DockerVolume.show()
        self.details = {
            entry["Name"]: {**entry, "Options": entry.get("Options") or {}}
            for entry in self.list_payload["Volumes"]
        }

        # Tamaño y referencias, que solo existen en /system/df bajo UsageData.
        # "sin-usage" no aparece a propósito: cubre el caso del daemon que no
        # conoce el tamaño de un volumen.
        self.usage_items = [
            {"Name": "datos-app", "UsageData": {"Size": 104857600, "RefCount": 1}},
            {"Name": "temporal", "UsageData": {"Size": 5242880, "RefCount": 0}},
            {"Name": ANON_A, "UsageData": {"Size": 48505107, "RefCount": 0}},
        ]

        # Volúmenes eliminados, para que prune no pueda repetirlos
        self.deleted: list[str] = []

    async def list(self, **kwargs) -> dict:
        """Devuelve el dict completo, igual que aiodocker: no una lista."""
        return self.list_payload

    async def get(self, name: str) -> FakeVolumeInstance:
        if name not in self.details:
            raise DockerError(404, {"message": f"get {name}: no such volume"})
        return FakeVolumeInstance(self, name)

    def _usage_index(self) -> dict:
        return {item["Name"]: item.get("UsageData") or {} for item in self.usage_items}

    def _delete(self, name: str, force: bool = False) -> bool:
        if name not in self.details:
            raise DockerError(404, {"message": f"get {name}: no such volume"})
        ref_count = self._usage_index().get(name, {}).get("RefCount", 0)
        if ref_count > 0 and not force:
            raise DockerError(
                409,
                {"message": f"volume is in use - [{name}]"},
            )
        self.deleted.append(name)
        return True

    async def prune(self, **kwargs) -> dict:
        """Replica `POST /volumes/prune`: solo elimina los no usados."""
        reclaimed = 0
        deleted: list[str] = []
        index = self._usage_index()
        for entry in self.list_payload["Volumes"]:
            name = entry["Name"]
            if index.get(name, {}).get("RefCount", 0) == 0:
                reclaimed += index.get(name, {}).get("Size", 0)
                deleted.append(name)
        return {"VolumesDeleted": deleted, "SpaceReclaimed": reclaimed}
