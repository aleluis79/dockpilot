// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Ficheros de un contenedor (SPEC-20).
 *
 * Lo que se ve es el filesystem **del contenedor**, incluidos sus montajes. Los
 * `..` y los symlinks se resuelven dentro de su namespace: no hay traversal, y
 * el límite real es el mismo que tiene `docker exec`, que el panel ya expone.
 */

/**
 * `other` son sockets, fifos y dispositivos: se listan para que se vea que están
 * ahí, pero no se pueden ni abrir ni subir.
 */
export type FileKind = 'file' | 'dir' | 'symlink' | 'other';

export interface ContainerEntry {
  name: string;
  kind: FileKind;
  size: number;
  /** Sólo en symlinks. Nunca se sigue: copiar un enlace copia el enlace. */
  symlink_target: string | null;
}

export interface ListDirectoryResult {
  container_id: string;
  path: string;
  /** `null` en la raíz del contenedor: no hay botón de volver. */
  parent: string | null;
  entries: ContainerEntry[];
  /** El listado se cortó y `entries` no está completo. */
  truncated: boolean;
}

/**
 * Topes del panel. Docker NO impone ninguno —se comprobó con ficheros de
 * 120 MB— y una subida viaja por WebSocket y por la memoria del navegador,
 * mientras que una descarga es una descarga. No son el mismo número.
 */
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

const MB = 1024 * 1024;

export function formatearBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * MB) return `${(bytes / MB).toFixed(1)} MiB`;
  return `${(bytes / (1024 * MB)).toFixed(1)} GiB`;
}

/**
 * Explica un rechazo por tamaño sin dejar al usuario adivinar.
 *
 * Devuelve `null` cuando el tamaño está bien, y el texto del problema cuando
 * no. El panel lo enseña antes de transferir nada: es más útil que un error
 * genérico que llega después de haber subido el fichero entero.
 */
export function validarTamano(
  bytes: number,
  direccion: 'subida' | 'descarga'
): string | null {
  const tope = direccion === 'subida' ? MAX_UPLOAD_BYTES : MAX_DOWNLOAD_BYTES;
  if (bytes <= tope) return null;
  return (
    `Ese fichero pesa ${formatearBytes(bytes)} y el máximo para ${direccion} ` +
    `es ${formatearBytes(tope)}.`
  );
}

/**
 * Aplica el tope de tamaño de la CONFIGURACIÓN del backend, no el de la
 * constante de arriba.
 *
 * Las dos cosas tienen que existir porque los topes son configurables por
 * entorno (`FILES_UPLOAD_MAX_BYTES`), y un usuario que sube el suyo se
 * encontraría con que el panel le rechaza lo que el backend sí aceptaría.
 */
export function validarTamanoConTopes(
  bytes: number,
  direccion: 'subida' | 'descarga',
  topes: { subida?: number; descarga?: number } = {}
): string | null {
  const tope =
    (direccion === 'subida' ? topes.subida : topes.descarga) ??
    (direccion === 'subida' ? MAX_UPLOAD_BYTES : MAX_DOWNLOAD_BYTES);
  if (bytes <= tope) return null;
  return (
    `Ese fichero pesa ${formatearBytes(bytes)} y el máximo para ${direccion} ` +
    `es ${formatearBytes(tope)}.`
  );
}