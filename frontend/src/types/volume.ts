// SPDX-License-Identifier: AGPL-3.0-or-later
export interface VolumeSummary {
  name: string;
  driver: string;
  mountpoint: string;
  scope: string;
  created_at: string;
  size: number;
  ref_count: number;
  /**
   * False si el daemon no pudo informar del uso. Entonces `ref_count` vale 0 por
   * defecto y NO significa que el volumen esté libre: no se puede afirmar que
   * sea eliminable.
   */
  usage_known: boolean;
  is_anonymous: boolean;
  labels: Record<string, string>;
  /** Proyecto Docker Compose al que pertenece, si la etiqueta existe. */
  compose_project?: string | null;
}

export interface VolumeDetail extends VolumeSummary {
  options: Record<string, unknown>;
  containers: string[];
}

export interface VolumePruneResult {
  deleted: string[];
  bytes_reclaimed: number;
  message: string;
}

export interface VolumeDeleteResponse {
  name: string;
  deleted: boolean;
  message: string;
}
