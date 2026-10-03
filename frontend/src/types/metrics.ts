// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Una medición en un instante, tal y como la deja el backend.
 *
 * Los contadores van en **absolutos** y las tasas se derivan en `utils/rates.ts`.
 * Es la razón por la que aquí no hay ningún campo que sea una media: un promedio
 * guardado es una segunda verdad que deja de cuadrar en cuanto llega la muestra
 * siguiente.
 */
export interface MetricSample {
  /** Epoch en segundos, del reloj del backend. No un ISO: la serie se come por diferencias. */
  t: number;
  cpu_percent: number;
  memory_percent: number;
  network_rx_bytes: number;
  network_tx_bytes: number;
  block_read_bytes: number;
  block_write_bytes: number;
}

/**
 * Una tasa derivada entre dos muestras consecutivas.
 *
 * `bytes_per_second` es `null` y no 0 cuando el par no es comparable: la primera
 * muestra no tiene con quién compararse, y tras un salto los contadores volvieron
 * a cero. Un 0 ahí sería una tasa medida, y no lo es.
 */
export interface RateSample {
  t: number;
  bytes_per_second: number | null;
  /** El contador bajó: el contenedor se reinició y el trazo tiene que partirse. */
  broken: boolean;
}

/**
 * La serie de un contenedor con lo que el panel sabe y con lo que no.
 *
 * Los cuatro de estado existen para que un vacío se entienda: `running` dice si
 * el contenedor está en marcha, `observed` si está fijado, `sampling` si se está
 * midiendo ahora, y `truncated` si el anillo descartó muestras por el tope. Un
 * estado vacío que no explica por qué está vacío se lee como un fallo del panel.
 */
export interface MetricsHistory {
  container_id: string;
  container_name: string;
  running: boolean;
  observed: boolean;
  sampling: boolean;
  interval_s: number;
  window_s: number;
  truncated: boolean;
  samples: MetricSample[];
}

export interface WatchResponse {
  container_id: string;
  observed: boolean;
}

/** Las tres ventanas que ofrece el selector. 900 s es el tope del anillo. */
export type RangeSeconds = 60 | 300 | 900;

/** Los seis trazados: cuatro absolutos y dos pares de tasa. */
export type MetricKey =
  | 'cpu_percent'
  | 'memory_percent'
  | 'network_rx'
  | 'network_tx'
  | 'block_read'
  | 'block_write';

/** Cuáles de los seis son tasas derivadas y no absolutos. */
export const METRIC_ANTES: readonly MetricKey[] = ['network_rx', 'network_tx', 'block_read', 'block_write'];

/** El contador acumulado del que sale cada tasa. */
export const CONTADOR_DE: Record<string, 'network_rx_bytes' | 'network_tx_bytes' | 'block_read_bytes' | 'block_write_bytes'> = {
  network_rx: 'network_rx_bytes',
  network_tx: 'network_tx_bytes',
  block_read: 'block_read_bytes',
  block_write: 'block_write_bytes',
};