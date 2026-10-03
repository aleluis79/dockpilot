// SPDX-License-Identifier: AGPL-3.0-or-later
export interface PortMapping {
  ip?: string;
  private_port: number;
  public_port?: number;
  type: string;
}

export type ContainerState = 'running' | 'exited' | 'paused' | 'restarting' | 'created' | 'dead';

/**
 * Los cuatro estados que distingue el daemon.
 *
 * `none` NO es "sin sickness": es "no hay healthcheck declarado", que es la
 * ausencia del dato y no un estado más. Un contenedor sin sonda no se
 * distinguirá en la UI de uno al que nunca se le miró.
 */
export type HealthStatus = 'healthy' | 'unhealthy' | 'starting' | 'none';

export interface HealthSummary {
  status: HealthStatus;
  failing_streak: number;
}

/** Una sonda ya ejecutada por el daemon. */
export interface HealthProbe {
  started_at: string;
  finished_at: string;
  exit_code: number;
  output: string;
}

/**
 * Salud con el porqué. Solo en el detalle.
 *
 * El listado **no** trae `log`, así que un `HealthSummary` no puede llevarlo:
 * por eso es un tipo aparte y no un campo opcional del resumen.
 */
export interface HealthDetail extends HealthSummary {
  log: HealthProbe[];
  /** Comandos que se están midiendo; vacío si no hay healthcheck. */
  test: string[];
}

export interface ContainerSummary {
  id: string;
  name: string;
  image: string;
  status: ContainerState | string;
  state: string;
  created: number;
  ports: PortMapping[];
  /** Proyecto Docker Compose al que pertenece, si la etiqueta existe. */
  compose_project?: string | null;
  /**
   * Si el panel está midiendo su serie de métricas (SPEC-17).
   *
   * Opcional por la misma razón que `health`: un backend anterior no lo manda y
   * tratarlo como `false` es lo correcto. Es un estado del **panel**, no del
   * host, así que no debe influir en los contadores de las píldoras.
   */
  observed?: boolean;
  /**
   * Salud del healthcheck, si el contenedor lo declara.
   *
   * Opcional a propósito aunque el backend lo mande siempre: una respuesta sin
   * este campo debe pintarse como "sin healthcheck", no revantar. Y el
   * `StatusBadge` lo trata como ausencia igual que `"none"`, que es el mismo
   * caso. Un contenedor sin sonda es la mayoría y no puede romper la vista.
   */
  health?: HealthSummary;
}

export interface ContainerDetail extends ContainerSummary {
  command?: string;
  env: string[];
  labels: Record<string, string>;
  mounts: Array<Record<string, unknown>>;
  networks: string[];
  /**
   * El detalle re-declara el tipo para que `log` y `test` no se pierdan: si se
   * dejara el `HealthSummary` del padre, TypeScript no los dejaría leer.
   */
  health?: HealthDetail;
  /**
   * Redes a las que está conectado. En una red **propia** el nombre del
   * contenedor es su nombre DNS, así que renombrarlo rompe a quien resuelve el
   * anterior (SPEC-19 §3.3). En la red `bridge` por defecto no hay nombres.
   *
   * No hay un `network_mode`: `HostConfig.NetworkMode` es sólo la red principal
   * y dice `bridge` para un contenedor conectado además a una red propia.
   */
}

export interface RenameContainerRequest {
  name: string;
}

export interface RenameContainerResponse {
  id: string;
  old_name: string;
  new_name: string;
  message: string;
}

export interface ContainerActionResponse {
  id: string;
  action: string;
  success: boolean;
  message: string;
}

export interface PortBindingConfig {
  host_port: number;
  container_port: number;
  protocol: 'tcp' | 'udp';
}

export interface VolumeBindingConfig {
  host_path: string;
  container_path: string;
  mode: 'rw' | 'ro';
}

export interface CreateContainerRequest {
  image: string;
  name?: string;
  ports: PortBindingConfig[];
  env: Record<string, string>;
  volumes: VolumeBindingConfig[];
  command?: string;
  restart_policy: 'no' | 'always' | 'unless-stopped' | 'on-failure';
  start_now: boolean;
}

export interface CreateContainerResponse {
  id: string;
  name: string;
  image: string;
  status: string;
  started: boolean;
  message: string;
}

/**
 * Contenedores parados y lo que ocupan (SPEC-21).
 *
 * Nombres y no ids, porque un id no lo reconoce nadie y un contenedor parado
 * puede tener dentro lo único que hacía que mereciera la pena pararlo.
 */
export interface ContainerPrunePreview {
  stopped_count: number;
  stopped_bytes: number;
  stopped_names: string[];
}

export interface ContainerPruneResult {
  deleted: string[];
  bytes_reclaimed: number;
  message: string;
}
