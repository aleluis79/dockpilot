#!/usr/bin/env bash
# El puerto sale del Makefile, que es donde vive la única declaración.
#
# Escribirlo aquí a mano fue lo que dejó el backend escuchando en 8000 mientras
# el proxy de Vite apuntaba a 8181: la app carga, `/api` y `/ws` no llegan, y el
# único síntoma visible es un WebSocket que no establece la conexión al abrir las
# métricas. Derivar el número en vez de repetirlo hace que esa desincronización
# no pueda volver a existir.
set -euo pipefail

cd "$(dirname "$0")"

PUERTO=$(sed -n 's/^PORT_BACKEND[[:space:]]*:*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' ../Makefile)

if [ -z "$PUERTO" ]; then
  echo "run.sh: no se encontró PORT_BACKEND en ../Makefile" >&2
  exit 1
fi

source .venv/bin/activate
exec uvicorn app.main:app --reload --host 127.0.0.1 --port "$PUERTO"
