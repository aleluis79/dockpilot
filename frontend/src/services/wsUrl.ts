// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Construye la URL de un WebSocket del backend a partir de su ruta.
 *
 * Se deriva de `window.location` a proposito: la pagina la sirve el frontend y
 * el proxy de Vite reenvia `/ws` al backend, asi que el host correcto siempre
 * es el de la propia pagina. No existe el caso en el que haga falta un host de
 * reserva, y mantener uno escondia un puerto que ademas se desincronizaba con
 * el del proxy sin que nada lo indicara.
 */
export function wsUrl(path: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}${path}`
}
