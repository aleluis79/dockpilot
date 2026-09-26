# SPDX-License-Identifier: AGPL-3.0-or-later
from fastapi import APIRouter

from app.api.v1.containers import router as containers_router
from app.api.v1.images import router as images_router
from app.api.v1.networks import router as networks_router
from app.api.v1.system import router as system_router
from app.api.v1.volumes import router as volumes_router

api_router = APIRouter()
api_router.include_router(containers_router)
api_router.include_router(images_router)
api_router.include_router(volumes_router)
api_router.include_router(system_router)
api_router.include_router(networks_router)
