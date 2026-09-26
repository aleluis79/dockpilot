from fastapi import APIRouter

from app.api.v1.containers import router as containers_router
from app.api.v1.images import router as images_router

api_router = APIRouter()
api_router.include_router(containers_router)
api_router.include_router(images_router)
