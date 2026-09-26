import ipaddress
import re
from typing import Any

import aiodocker
from aiodocker.exceptions import DockerError
from fastapi import HTTPException

from app.core.docker import docker_error_message
from app.schemas.network import (
    CreateNetworkRequest,
    NetworkDeleteResponse,
    NetworkDetail,
    NetworkPruneResult,
    NetworkSubnet,
    NetworkSummary,
)

# Docker gestiona estas tres y las recrea en cada arranque: borrarlas es un error.
BUILTIN_NETWORKS = frozenset({"none", "host", "bridge"})

NAME_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]*$")
MAX_NAME_LENGTH = 63
RESERVED_PREFIX = "docker_"
SUPPORTED_DRIVERS = frozenset({"bridge"})


class NetworkService:
    """Inventario, detalle, creación, borrado y limpieza de redes Docker."""

    @staticmethod
    async def list_networks(docker: aiodocker.Docker) -> list[NetworkSummary]:
        """Lista las redes del host con su recuento de contenedores.

        `networks.list()` no trae ningún recuento (SPEC-10 §3.1), así que se
        cuenta desde `GET /containers/json`: una sola llamada para todas las
        redes, en lugar de un `show()` por red.
        """
        raw_networks = await NetworkService._fetch_list(docker)
        usage = await _container_usage(docker)

        summaries: list[NetworkSummary] = []
        for raw in raw_networks:
            info = _as_dict(raw)
            if not info:
                continue
            name = _as_str(info.get("Name"))
            if not name:
                continue
            summaries.append(_to_summary(info, usage.get(name, 0)))
        return summaries

    @staticmethod
    async def get_network(docker: aiodocker.Docker, name: str) -> NetworkDetail:
        """Detalle de una red, con los nombres de sus contenedores.

        `show()` es el único camino que trae `Containers`; `list()` no lo trae.
        """
        raw = await NetworkService._fetch_show(docker, name)
        usage = await _container_usage(docker)
        summary = _to_summary(raw, usage.get(name, 0))
        return NetworkDetail(
            **summary.model_dump(),
            options=_as_dict(raw.get("Options")),
            labels=_as_labels(raw.get("Labels")),
            containers=_connected_names(raw.get("Containers")),
        )

    @staticmethod
    async def create_network(
        docker: aiodocker.Docker, payload: CreateNetworkRequest
    ) -> NetworkDetail:
        """Crea una red, normalizando y validando antes de contactar al daemon."""
        name = payload.name.strip()
        _validate_name(name)
        _validate_driver(payload.driver)
        subnet, gateway = _validate_network_config(payload)

        config: dict[str, Any] = {
            "Name": name,
            "Driver": payload.driver,
            "CheckDuplicate": True,
            "Internal": payload.internal,
            "Labels": payload.labels or {},
        }
        if subnet:
            config["IPAM"] = {
                "Driver": "default",
                "Config": [{"Subnet": subnet, "Gateway": gateway}],
            }

        try:
            await docker.networks.create(config)
        except DockerError as e:
            raise HTTPException(
                status_code=_status_for_create(e),
                detail=_create_error_message(e, name),
            ) from e
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"Error inesperado al crear la red: {e!s}",
            ) from e

        return await NetworkService.get_network(docker, name)

    @staticmethod
    async def delete_network(
        docker: aiodocker.Docker, name: str, force: bool = False
    ) -> NetworkDeleteResponse:
        """Borra una red, rechazando las predefinidas antes de preguntar al daemon."""
        if name in BUILTIN_NETWORKS:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"La red '{name}' es una red predefinida de Docker y no se puede eliminar"
                ),
            )

        try:
            if force:
                # `DockerNetwork.delete()` no admite parámetros, así que el force
                # solo se puede pedir por la vía cruda (SPEC-10 §3.6).
                await docker._query_json(
                    f"networks/{name}", method="DELETE", params={"force": "true"}
                )
            else:
                network = await docker.networks.get(name)
                await network.delete()
        except DockerError as e:
            status = getattr(e, "status", 0)
            if status == 404:
                raise HTTPException(
                    status_code=404, detail=f"La red '{name}' no existe"
                ) from e
            if status == 409:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"La red '{name}' tiene contenedores conectados y no se puede "
                        "eliminar sin forzar"
                    ),
                ) from e
            raise HTTPException(
                status_code=503,
                detail=f"Error al eliminar la red: {docker_error_message(e)}",
            ) from e
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"Error inesperado al eliminar la red: {e!s}",
            ) from e

        return NetworkDeleteResponse(
            name=name,
            deleted=True,
            message=f"Red '{name}' eliminada",
        )

    @staticmethod
    async def prune_networks(docker: aiodocker.Docker) -> NetworkPruneResult:
        """Elimina las redes sin contenedores. Nunca toca las predefinidas.

        El propio daemon excluye `none`, `host` y `bridge`; el filtro se aplica
        además sobre la respuesta para no confiar en ello a ciegas.
        """
        try:
            raw = await docker.networks.prune()
        except DockerError as e:
            raise HTTPException(
                status_code=503,
                detail=f"Error al limpiar las redes: {docker_error_message(e)}",
            ) from e
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"Error inesperado al limpiar las redes: {e!s}",
            ) from e

        deleted = [
            name
            for name in (_as_str(n) for n in (raw or {}).get("NetworksDeleted") or [])
            if name and name not in BUILTIN_NETWORKS
        ]

        if not deleted:
            message = "No hay redes sin uso que eliminar"
        else:
            plural = "s" if len(deleted) != 1 else ""
            message = f"{len(deleted)} red{plural} eliminada{plural}: {', '.join(deleted)}"
        return NetworkPruneResult(deleted=deleted, message=message)

    # ------------------------------------------------------------------ internos

    @staticmethod
    async def _fetch_list(docker: aiodocker.Docker) -> Any:
        try:
            return await docker.networks.list()
        except DockerError as e:
            raise HTTPException(
                status_code=503,
                detail=f"Error al listar las redes: {docker_error_message(e)}",
            ) from e
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"Error inesperado al listar las redes: {e!s}",
            ) from e

    @staticmethod
    async def _fetch_show(docker: aiodocker.Docker, name: str) -> dict[str, Any]:
        try:
            network = await docker.networks.get(name)
            raw = await network.show()
        except DockerError as e:
            if getattr(e, "status", 0) == 404:
                raise HTTPException(
                    status_code=404, detail=f"La red '{name}' no existe"
                ) from e
            raise HTTPException(
                status_code=503,
                detail=f"Error al consultar la red: {docker_error_message(e)}",
            ) from e
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"Error inesperado al consultar la red: {e!s}",
            ) from e
        return _as_dict(raw)


# ---------------------------------------------------------------------elpers


def _to_summary(raw: dict[str, Any], container_count: int) -> NetworkSummary:
    name = _as_str(raw.get("Name"))
    return NetworkSummary(
        id=_as_str(raw.get("Id")),
        name=name,
        driver=_as_str(raw.get("Driver")),
        scope=_as_str(raw.get("Scope")) or "local",
        internal=bool(raw.get("Internal")),
        attachable=bool(raw.get("Attachable")),
        enable_ipv6=bool(raw.get("EnableIPv6")),
        created=_as_str(raw.get("Created")),
        subnets=_subnets(raw.get("IPAM")),
        container_count=container_count,
        is_builtin=name in BUILTIN_NETWORKS,
    )


def _subnets(ipam: Any) -> list[NetworkSubnet]:
    """Extrae las subredes de `IPAM.Config`.

    El daemon devuelve `null` en las redes `none` y `host`, y una lista de dicts
    en el resto: hay que tolerar ambos casos (SPEC-10 §3.1).
    """
    config = _as_dict(ipam).get("Config")
    if not isinstance(config, list):
        return []

    subnets: list[NetworkSubnet] = []
    for entry in config:
        item = _as_dict(entry)
        if not item:
            continue
        subnet = _as_str(item.get("Subnet"))
        if not subnet:
            continue
        subnets.append(
            NetworkSubnet(subnet=subnet, gateway=_as_str(item.get("Gateway")))
        )
    return subnets


async def _container_usage(docker: aiodocker.Docker) -> dict[str, int]:
    """Recuento de contenedores por red, desde `GET /containers/json`.

    Se usa `all=True`: un contenedor detenido sigue conectado a su red y cuenta
    para el borrado de la misma.
    """
    try:
        raw = await docker.containers.list(all=True)
    except Exception:
        return {}

    usage: dict[str, int] = {}
    for entry in _raw_container_entries(raw):
        networks = _as_dict(_as_dict(entry.get("NetworkSettings")).get("Networks"))
        for network_name in networks:
            usage[network_name] = usage.get(network_name, 0) + 1
    return usage


def _raw_container_entries(raw: Any) -> list[dict]:
    """Normaliza la lista de contenedores a dicts, tolerando envolturas."""
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for item in raw:
        info = getattr(item, "_container", None)
        if isinstance(info, dict):
            out.append(info)
        elif isinstance(item, dict):
            out.append(item)
    return out


def _connected_names(containers: Any) -> list[str]:
    """Nombres de los contenedores de `show()["Containers"]`.

    El daemon lo entrega como dict indexado por id de contenedor; se acepta
    también una lista por si cambia la forma.
    """
    names: list[str] = []
    if isinstance(containers, dict):
        values: list[Any] = list(containers.values())
    elif isinstance(containers, list):
        values = containers
    else:
        return names

    for entry in values:
        name = _as_str(_as_dict(entry).get("Name"))
        if name:
            names.append(name)
    return names


def _validate_name(name: str) -> None:
    if not name:
        raise HTTPException(status_code=400, detail="El nombre de la red no puede estar vacío")
    if len(name) > MAX_NAME_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"El nombre no puede superar {MAX_NAME_LENGTH} caracteres",
        )
    if name.lower().startswith(RESERVED_PREFIX):
        raise HTTPException(
            status_code=400,
            detail=f"El prefijo '{RESERVED_PREFIX}' está reservado por Docker",
        )
    if not NAME_PATTERN.match(name):
        raise HTTPException(
            status_code=400,
            detail=(
                "El nombre solo puede llevar letras, dígitos, punto, guion y guion bajo, "
                "y debe empezar por letra o dígito"
            ),
        )


def _validate_driver(driver: str) -> None:
    if driver not in SUPPORTED_DRIVERS:
        admitidos = ", ".join(sorted(SUPPORTED_DRIVERS))
        raise HTTPException(
            status_code=400,
            detail=f"Solo se admite el driver '{admitidos}' en esta versión",
        )


def _validate_network_config(payload: CreateNetworkRequest) -> tuple[str, str]:
    """Valida subred y puerta de enlace, normalizando el CIDR.

    `ip_network(..., strict=False)` convierte `172.20.0.5/16` en
    `172.20.0.0/16` en lugar de rechazarlo. El daemon no admite puerta de enlace
    sin subred, así que se rechaza aquí.
    """
    subnet_raw = (payload.subnet or "").strip()
    gateway = (payload.gateway or "").strip()

    if not subnet_raw:
        if gateway:
            raise HTTPException(
                status_code=400,
                detail="No se puede indicar una puerta de enlace sin una subred",
            )
        return "", ""

    try:
        network = ipaddress.ip_network(subnet_raw, strict=False)
    except ValueError as e:
        raise HTTPException(
            status_code=400,
            detail=f"El campo 'subnet' no es un CIDR válido: {subnet_raw} ({e})",
        ) from e

    if network.version != 4:
        raise HTTPException(
            status_code=400, detail="Solo se admiten subredes IPv4 en esta versión"
        )

    return str(network), gateway


def _status_for_create(error: DockerError) -> int:
    status = getattr(error, "status", 0)
    if status == 409:
        return 409
    if status == 400:
        return 400
    if status == 403:
        return 400
    return 503


def _create_error_message(error: DockerError, name: str) -> str:
    status = getattr(error, "status", 0)
    message = docker_error_message(error)
    if status == 409:
        return f"Ya existe una red llamada '{name}': {message}"
    if status in (400, 403):
        return f"El daemon rechazó la red '{name}': {message}"
    return f"Error al crear la red '{name}': {message}"


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_labels(value: Any) -> dict[str, str]:
    raw = _as_dict(value)
    return {str(k): _as_str(v) for k, v in raw.items()}


def _as_str(value: Any) -> str:
    return value if isinstance(value, str) else ""
