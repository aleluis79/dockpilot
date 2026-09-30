# SPDX-License-Identifier: AGPL-3.0-or-later
from typing import Annotated

import aiodocker
from aiodocker.exceptions import DockerError
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile

from app.core.config import settings
from app.core.docker import docker_error_message, docker_error_status, get_docker
from app.schemas.container import (
    ContainerActionResponse,
    ContainerDetail,
    ContainerSummary,
    CreateContainerRequest,
    CreateContainerResponse,
    RenameContainerRequest,
    RenameContainerResponse,
)
from app.schemas.filesystem import ListDirectoryResult
from app.schemas.stats import ContainerStats
from app.services import container_files_service as ContainerFiles
from app.services.container_files_service import ContainerFilesService
from app.services.container_service import ContainerService
from app.services.stats_service import StatsService

DockerDep = Annotated[aiodocker.Docker, Depends(get_docker)]

router = APIRouter(prefix="/containers", tags=["containers"])


def _mb(bytes_: int) -> str:
    return ContainerFiles.formatear_bytes(bytes_)


def _traducir(exc: Exception, ruta: str) -> HTTPException:
    """Un `DockerError` del daemon, como error HTTP servible.

    Sin esto, un `DockerError(404, {'message': ...})` de aiodocker sube por la
    ruta y FastAPI lo responde como un error interno sin mensaje utilizable: el
    panel se queda con un 500 mudo y el listado no se puede explicar. Es el
    mismo criterio de `docker_error_status` que ya usan las otras rutas.
    """
    status = docker_error_status(exc)
    mensaje = docker_error_message(exc)
    return HTTPException(status_code=status, detail=mensaje or f"Error del daemon al operar en {ruta}")


@router.post("", response_model=CreateContainerResponse, status_code=201)
async def create_container(
    docker: DockerDep,
    payload: CreateContainerRequest,
):
    """Crea y opcionalmente arranca un nuevo contenedor Docker."""
    return await ContainerService.create_container(docker=docker, payload=payload)


@router.get("", response_model=list[ContainerSummary])
async def list_containers(
    docker: DockerDep,
    all: bool = Query(True, description="Mostrar todos los contenedores (incluyendo detenidos)"),
    status: str | None = Query(None, description="Filtrar por estado: running, exited, etc."),
    health: Annotated[
        list[str] | None,
        Query(
            description=(
                "Filtrar por salud. Admite varios: unhealthy, starting, healthy, "
                "none. Los une con OR, como hace el daemon (SPEC-18 §3.2)"
            )
        ),
    ] = None,
):
    """Lista todos los contenedores con soporte para filtrado."""
    return await ContainerService.list_containers(
        docker=docker, all=all, status=status, health=health
    )


@router.get("/{container_id}", response_model=ContainerDetail)
async def get_container(
    docker: DockerDep,
    container_id: str,
):
    """Obtiene los detalles e inspección completa de un contenedor."""
    return await ContainerService.get_container(docker=docker, container_id=container_id)


@router.get("/{container_id}/logs")
async def get_container_logs(
    docker: DockerDep,
    container_id: str,
    tail: int = Query(100, description="Número de líneas recientes"),
    timestamps: bool = Query(True, description="Incluir marcas de tiempo"),
):
    """Obtiene una instantánea reciente de los logs del contenedor."""
    return await ContainerService.get_logs_snapshot(
        docker=docker, container_id=container_id, tail=tail, timestamps=timestamps
    )


@router.get("/{container_id}/stats", response_model=ContainerStats)
async def get_container_stats(
    docker: DockerDep,
    container_id: str,
):
    """Obtiene una instantánea de las métricas de CPU, memoria, red y disco del contenedor."""
    return await StatsService.get_stats(docker=docker, container_id=container_id)


@router.post("/{container_id}/rename", response_model=RenameContainerResponse)
async def rename_container(
    docker: DockerDep,
    container_id: str,
    payload: RenameContainerRequest,
):
    """Cambia el nombre del contenedor. No recrea nada: sólo cambia el nombre.

    En una red personalizada el nombre **es** el nombre DNS del contenedor, así
    que esto rompe a quien resolvía el anterior (SPEC-19).
    """
    return await ContainerService.rename_container(
        docker=docker, container_id=container_id, nombre=payload.name
    )


@router.get("/{container_id}/files", response_model=ListDirectoryResult)
async def list_container_files(
    docker: DockerDep,
    container_id: str,
    path: str = Query("/", description="Directorio DENTRO del contenedor"),
):
    """Lista un directorio del contenedor.

    Va por `exec` con `ls` y no por el archive API porque listar por el archive
    es descargar: sobre un directorio, Docker devuelve el árbol entero con el
    contenido de los ficheros (`/usr/lib` son 51 MB para 177 nombres).
    """
    try:
        return await ContainerFilesService.list_directory(
            docker=docker, container_id=container_id, path=path
        )
    except ContainerFiles.ArchivoNoEncontrado as exc:
        raise HTTPException(status_code=404, detail=f"No existe esa ruta en el contenedor: {exc}") from exc
    except DockerError as exc:
        raise _traducir(exc, path) from exc


@router.get("/{container_id}/files/download")
async def download_container_file(
    docker: DockerDep,
    container_id: str,
    path: str = Query(..., description="Fichero DENTRO del contenedor"),
):
    """Descarga un fichero del contenedor. Lo guarda el navegador, no el backend.

    El backend devuelve los bytes y el nombre; donde acaben es cosa del
    cliente. Es lo que permite que esta ruta no escriba en el disco del host
    (SPEC-20 §3.2).
    """
    try:
        contenido, nombre = await ContainerFilesService.download_file(
            docker=docker, container_id=container_id, path=path
        )
    except ContainerFiles.ArchivoNoEncontrado as exc:
        raise HTTPException(status_code=404, detail=f"No existe ese fichero en el contenedor: {exc}") from exc
    except ContainerFiles.ArchivoNoEsFichero as exc:
        # 400 y no 404: el fichero SI existe, pero no es un fichero. Un 404
        # haría que el panel lo pintara como "se ha borrado".
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ContainerFiles.ArchivoDemasiadoGrande as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except DockerError as exc:
        raise _traducir(exc, path) from exc

    return Response(
        content=contenido,
        media_type="application/octet-stream",
        headers={
            # El nombre va en la cabecera y no en el cuerpo: así el navegador
            # puede nombrar el fichero sin que el backend lo vuelva a escribir.
            "content-disposition": f'attachment; filename="{nombre}"',
            "content-length": str(len(contenido)),
        },
    )


@router.post("/{container_id}/files/upload", status_code=201)
async def upload_container_files(
    docker: DockerDep,
    container_id: str,
    path: Annotated[str, Form(description="Directorio destino DENTRO del contenedor")],
    files: Annotated[
        list[UploadFile] | None,
        File(description="Ficheros a subir, con su ruta relativa"),
    ] = None,
):
    """Sube ficheros al contenedor.

    El navegador manda **contenido y nombre relativo**, nunca una ruta del host:
    `<input type="file">` no expone la ruta y no hace falta que lo haga. Por eso
    esta ruta no escribe en el disco del usuario, que es el principio del panel
    (SPEC-20 §3.2).
    """
    if not files:
        raise HTTPException(status_code=400, detail="No se ha enviado ningún fichero.")

    leidos: list[tuple[str, bytes]] = []
    total = 0
    for fichero in files:
        # El nombre lo pone el navegador: con `webkitdirectory` trae la ruta
        # relativa de la carpeta, y sin ella el nombre plano.
        nombre = getattr(fichero, "filename", None) or fichero.name or ""
        contenido = await fichero.read()
        total += len(contenido)
        if total > settings.FILES_UPLOAD_MAX_BYTES:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"La subida pesa más de {_mb(settings.FILES_UPLOAD_MAX_BYTES)}. "
                    "Docker no impone tope; el límite es del panel."
                ),
            )
        leidos.append((nombre, contenido))

    try:
        enviados = await ContainerFilesService.upload_files(
            docker=docker, container_id=container_id, path=path, archivos=leidos
        )
    except ContainerFiles.SubidaInvalida as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ContainerFiles.ArchivoDemasiadoGrande as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except DockerError as exc:
        raise _traducir(exc, path) from exc

    return {"enviados": enviados, "ruta": ContainerFilesService.normalizar_ruta(path)}


@router.post("/{container_id}/start", response_model=ContainerActionResponse)
async def start_container(
    docker: DockerDep,
    container_id: str,
):
    """Inicia un contenedor detenido."""
    return await ContainerService.start_container(docker=docker, container_id=container_id)


@router.post("/{container_id}/stop", response_model=ContainerActionResponse)
async def stop_container(
    docker: DockerDep,
    container_id: str,
    timeout: int = Query(10, description="Tiempo de espera en segundos antes de forzar la detención"),
):
    """Detiene un contenedor en ejecución."""
    return await ContainerService.stop_container(docker=docker, container_id=container_id, timeout=timeout)


@router.post("/{container_id}/restart", response_model=ContainerActionResponse)
async def restart_container(
    docker: DockerDep,
    container_id: str,
    timeout: int = Query(10, description="Tiempo de espera en segundos antes de reiniciar"),
):
    """Reinicia un contenedor."""
    return await ContainerService.restart_container(docker=docker, container_id=container_id, timeout=timeout)


@router.post("/{container_id}/pause", response_model=ContainerActionResponse)
async def pause_container(
    docker: DockerDep,
    container_id: str,
):
    """Pausa todos los procesos de un contenedor."""
    return await ContainerService.pause_container(docker=docker, container_id=container_id)


@router.post("/{container_id}/unpause", response_model=ContainerActionResponse)
async def unpause_container(
    docker: DockerDep,
    container_id: str,
):
    """Reanuda los procesos de un contenedor pausado."""
    return await ContainerService.unpause_container(docker=docker, container_id=container_id)


@router.delete("/{container_id}", response_model=ContainerActionResponse)
async def remove_container(
    docker: DockerDep,
    container_id: str,
    force: bool = Query(False, description="Forzar la eliminación incluso si está en ejecución"),
    v: bool = Query(False, description="Eliminar los volúmenes anónimos asociados al contenedor"),
):
    """Elimina un contenedor."""
    return await ContainerService.remove_container(
        docker=docker, container_id=container_id, force=force, v=v
    )
