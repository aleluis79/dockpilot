from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import api_router
from app.api.v1.ws import router as ws_router
from app.core.config import settings
from app.core.docker import close_docker, init_docker


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Inicialización de recursos (Docker client)
    try:
        await init_docker()
    except Exception as e:
        print(f"Advertencia: no se pudo inicializar Docker al arrancar: {e}")
    yield
    # Limpieza de recursos
    await close_docker()


app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.VERSION,
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
)

# Configuración de CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Inclusión de routers de la API
app.include_router(api_router, prefix=settings.API_V1_PREFIX)
app.include_router(ws_router)


@app.get("/")
async def root():
    return {"message": "DockPilot API is running", "version": settings.VERSION}


@app.get("/health")
async def health():
    return {"status": "ok"}
