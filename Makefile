# ============================================================================
# DockPilot - Makefile
# ============================================================================

.PHONY: help backend frontend dev up down clean \
        backend-install backend-serve backend-test backend-lint \
        frontend-install frontend-serve frontend-test frontend-lint frontend-build \
        lint test build

# ---------------------------------------------------------------------------
# Default target
# ---------------------------------------------------------------------------
help:                       ## Muestra esta ayuda
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ---------------------------------------------------------------------------
# Entorno / Servicios
# ---------------------------------------------------------------------------
PORT_BACKEND  := 8000
PORT_FRONTEND := 5173

up:                       ## Inicia backend y frontend en modo desarrollo
	@echo "Starting DockPilot services..."
	@if lsof -ti $(PORT_BACKEND) >/dev/null 2>&1; then \
		echo "Backend already running on port $(PORT_BACKEND)"; \
	else \
		cd backend && .venv/bin/uvicorn app.main:app --reload --host 127.0.0.1 --port $(PORT_BACKEND) &> /tmp/dockpilot-backend.log & \
		sleep 1; \
		echo "Backend started on port $(PORT_BACKEND)"; \
	fi
	@if lsof -ti $(PORT_FRONTEND) >/dev/null 2>&1; then \
		echo "Frontend already running on port $(PORT_FRONTEND)"; \
	else \
		cd frontend && pnpm run dev &> /tmp/dockpilot-frontend.log & \
		sleep 2; \
		echo "Frontend started on port $(PORT_FRONTEND)"; \
	fi
	@echo ""
	@echo "  Backend:  http://localhost:$(PORT_BACKEND)"
	@echo "  Frontend: http://localhost:$(PORT_FRONTEND)"

down:                     ## Detiene todos los servicios
	@echo "Stopping DockPilot services..."
	@-fuser -k $(PORT_BACKEND)/tcp 2>/dev/null && echo "Backend stopped on port $(PORT_BACKEND)" || echo "Backend not running on port $(PORT_BACKEND)"
	@sleep 1
	@-fuser -k $(PORT_FRONTEND)/tcp 2>/dev/null && echo "Frontend stopped on port $(PORT_FRONTEND)" || echo "Frontend not running on port $(PORT_FRONTEND)"
	@sleep 1
	@echo "All services stopped."

# ============================================================================
# BACKEND  (FastAPI + Python)
# ============================================================================

backend-install:            ## Crea el virtualenv e instala dependencias
	cd backend && python3 -m venv .venv
	cd backend && .venv/bin/pip install -r requirements.txt

backend-serve:              ## Inicia el servidor (uvicorn --reload)
	cd backend && .venv/bin/uvicorn app.main:app --reload --host 127.0.0.1 --port 8000

backend-test:               ## Ejecuta la suite de pruebas (pytest)
	cd backend && PYTHONPATH=. .venv/bin/pytest -v

backend-lint:               ## Verifica el código con Ruff (config en backend/pyproject.toml)
	cd backend && .venv/bin/python -m ruff check app

backend: backend-install backend-serve  ## Prepara y levanta el backend

# ============================================================================
# FRONTEND  (React + TypeScript + Vite)
# ============================================================================

frontend-install:           ## Instala dependencias con pnpm
	cd frontend && pnpm install

frontend-serve:             ## Inicia el servidor de desarrollo (Vite)
	cd frontend && pnpm run dev

frontend-test:              ## Ejecuta las pruebas (Vitest)
	cd frontend && pnpm run test

frontend-lint:              ## Ejecuta el linter (Oxlint)
	cd frontend && pnpm run lint

frontend-build:             ## Typecheck + build de producción
	cd frontend && pnpm run build

frontend: frontend-install frontend-serve  ## Prepara y levanta el frontend

# ============================================================================
# Tareas globales
# ============================================================================

lint: backend-lint frontend-lint  ## Ejecuta lint en backend y frontend

test: backend-test frontend-test  ## Ejecuta tests en backend y frontend

build: frontend-build       ## Construye el frontend para producción

clean:                      ## Limpia caches y artefactos de build
	rm -rf backend/.pytest_cache
	rm -rf backend/__pycache__
	rm -rf backend/app/__pycache__
	rm -rf frontend/.vite
	rm -rf frontend/dist
	find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
