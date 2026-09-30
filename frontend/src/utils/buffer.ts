// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Búfer circular acotado para la salida acumulada de un stream.
 *
 * Los visores de logs y de compose se quedan abiertos mientras la aplicación
 * escribe, así que el array crece sin tope si nadie lo recorta. Y no es sólo
 * memoria: `ComposeLogsViewer` vuelve a trocear el historial entero en cada
 * fragmento nuevo, así que un `logs --follow` de un servicio que parle mucho se
 * convertía en O(n²) de CPU además de un heap sin límite.
 *
 * `empujar` es una función pura a propósito: con el mismo array de entrada
 * devuelve siempre el mismo resultado, y eso es lo que permite que el estado de
 * React no se re-renderice cuando el fragmento ya no aporta nada.
 */
export function acumular<T>(buffer: T[], elemento: T, tope: number): T[] {
  const siguiente = buffer.length >= tope ? buffer.slice(buffer.length - tope + 1) : buffer.slice()
  siguiente.push(elemento)
  return siguiente
}