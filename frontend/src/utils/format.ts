// SPDX-License-Identifier: AGPL-3.0-or-later
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

/**
 * Convierte un número de bytes en una cadena legible con unidades binarias.
 * Ej: 1536 -> "1.5 KB", 1048576 -> "1.0 MB"
 */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'

  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    BYTE_UNITS.length - 1
  )
  const value = bytes / 1024 ** exponent

  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${BYTE_UNITS[exponent]}`
}

/** Formatea un porcentaje con los decimales indicados. Ej: 20 -> "20.0%" */
export function formatPercent(value: number, digits: number = 1): string {
  return `${(value || 0).toFixed(digits)}%`
}

/**
 * Formatea una **tasa** de bytes por segundo (SPEC-17).
 *
 * No es `formatBytes`: un acumulado y una tasa son magnitudes distintas, y
 * reutilizar el formateador del acumulado haría que "1.0 KB" significara las dos
 * cosas. Por eso las unidades son KiB/s y MB/s, no KB/s.
 */
export function formatRate(bytesPerSecond: number): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return '0 B/s'

  const unidades: [number, string][] = [
    [1024 ** 2, 'MB/s'],
    [1024, 'KiB/s'],
  ]
  for (const [factor, unidad] of unidades) {
    if (bytesPerSecond >= factor) {
      return `${(bytesPerSecond / factor).toFixed(1)} ${unidad}`
    }
  }
  return `${Math.round(bytesPerSecond)} B/s`
}
