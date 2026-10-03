// SPDX-License-Identifier: AGPL-3.0-or-later
export interface ImageSearchResult {
  name: string;
  description: string;
  is_official: boolean;
  star_count: number;
}

export interface LocalImageSummary {
  id: string;
  tags: string[];
  size: number;
  created: number;
  containers: number;
  repo_digests: string[];
}

export interface ImageHistoryEntry {
  id: string;
  created: number;
  created_by: string;
  size: number;
  comment: string;
  tags?: string[] | null;
}

export interface ImageDetail {
  id: string;
  tags: string[];
  repo_digests: string[];
  size: number;
  created: number;
  architecture: string;
  os: string;
  entrypoint?: string[] | null;
  cmd?: string[] | null;
  env: string[];
  exposed_ports: Record<string, unknown>;
  working_dir: string;
  user: string;
  labels: Record<string, string>;
  layer_count: number;
  history: ImageHistoryEntry[];
}

export type ImagePullMessageType = 'start' | 'layer' | 'digest' | 'done' | 'error';

export interface ImagePullMessage {
  type: ImagePullMessageType;
  image: string;
  id?: string;
  status?: string;
  current?: number;
  total?: number;
  progress?: string;
  digest?: string;
  tags?: string[];
  code?: number;
  message?: string;
}

export type ImageLayerState = 'pending' | 'downloading' | 'extracting' | 'done';

export interface ImagePullLayer {
  id: string;
  status: string;
  current: number;
  total: number;
  state: ImageLayerState;
}

export interface ImageDeleteResponse {
  id: string;
  deleted: boolean;
  untagged: string[];
  message: string;
}

/**
 * Qué se borraría con cada nivel de limpieza, y cuánto (SPEC-21).
 *
 * Los `bytes` son una **cota superior**, no una promesa: el backend suma el
 * `Size` de cada imagen y dos imágenes pueden compartir capas. Por eso la
 * interfaz escribe «hasta» delante del número, igual que el plan de un build
 * de SPEC-15.
 */
export interface ImagePrunePreview {
  /** Sin etiqueta y sin contenedores que la usen: el nivel seguro. */
  dangling_count: number;
  dangling_bytes: number;
  dangling_ids: string[];
  /** Con etiqueta y sin uso: borrarlas obliga a volver a descargarlas. */
  tagged_count: number;
  tagged_bytes: number;
  tagged_refs: string[];
  /** Sin etiqueta pero en uso: el daemon no las borrará. */
  in_use_dangling: number;
}

export interface ImagePruneResult {
  deleted: string[];
  /** En el nivel agresivo es una **estimación** (la suma de los `Size`), no lo que
   *  el daemon dice que recuperó: un borrado uno a uno no lleva ese dato. */
  bytes_reclaimed: number;
  message: string;
  /**
   * Etiquetas que el daemon no dejó borrar, con su motivo.
   *
   * Existe porque el nivel agresivo es un bucle y puede fallar a medias: el caso
   * normal es que alguien haya arrancado un contenedor con esa imagen entre el
   * preaviso y el botón. Sin esta lista, un «3 de 6» obligaría a adivinar
   * cuáles y el usuario podría creer que se han borrado seis.
   */
  kept: string[];
}
