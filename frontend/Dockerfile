# DockPilot · frontend (SPEC-00, imagen)
#
# Dos etapas porque el que sirve y el que compila no son el mismo programa: el
# runtime es nginx y no Node, y esto no es una optimización sino una decisión.
# `vite preview` y `node dist/server.js` saldrían más cortas, pero el navegador
# acabaría hablando con un servidor de desarrollo, y el día que cambie un
# `import.meta.env` el síntoma aparece solo en producción.
#
# Lo que obliga a este fichero a existir es el PROXY. `dockerApi.ts` usa
# `BASE_URL = '/api/v1'` y `wsUrl()` deriva de `window.location`, así que el
# cliente da por hecho que su servidor es el de la API. En desarrollo lo
# resolvía `server.proxy` de Vite, que es una opción de desarrollo y no se
# aplica al `dist`. Por eso hay nginx: para que `/api` y `/ws` salgan hacia el
# backend y el SPA se sirva desde el mismo origen.

# ---------------------------------------------------------------------------
# Etapa 1: compilar
# ---------------------------------------------------------------------------
FROM node:24.21.0-alpine AS build

# corepack habilita pnpm desde el propio Node. La versión se fija aquí y no en
# `package.json` a propósito: `packageManager` ataría también a quien developing
# con otro gestor, y esto es una imagen que se construye una vez.
RUN corepack enable && corepack prepare pnpm@12.4.1 --activate

WORKDIR /srv/app

# `package.json` y el lockfile van solos y antes que el código, para que un
# cambio en un componente no reinstale el árbol entero. `--frozen-lockfile` para
# que la imagen no resuelva versiones por su cuenta: una build que hoy compila y
# mañana no, sin que nadie toque nada, es la peor forma de fallar.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY vite.config.ts index.html ./
COPY src ./src

# `pnpm build` es `tsc -b && vite build`. Los typecheck vienen de serie y no se
# saltan: una imagen que compila TypeScript roto sirve un bundle roto igual.
RUN pnpm build

# ---------------------------------------------------------------------------
# Etapa 2: servir
# ---------------------------------------------------------------------------
FROM nginx:1.31.6-alpine

# La configuración va a `conf.d` y no sustituyendo el `nginx.conf` de la imagen:
# el de la base trae `user`, `events` y `http`, y reemplazarlo entero obliga a
# reescribir esas piezas para no perderlas.
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /srv/app/dist /usr/share/nginx/html

EXPOSE 80

# No se declara HEALTHCHECK a propósito: nginx sirve el SPA aunque el backend
# esté caído, así que un sondeo HTTP a `/` daría `ok` con el panel sin poder hacer
# nada. El healthcheck útil es el del backend, y el compose lo espera con
# `depends_on: condition: service_healthy`; quien velez por el sitio entero es
# el gateway, no esta imagen.