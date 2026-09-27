// SPDX-License-Identifier: AGPL-3.0-or-later
export interface PortMapping {
  ip?: string;
  private_port: number;
  public_port?: number;
  type: string;
}

export type ContainerState = 'running' | 'exited' | 'paused' | 'restarting' | 'created' | 'dead';

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
}

export interface ContainerDetail extends ContainerSummary {
  command?: string;
  env: string[];
  labels: Record<string, string>;
  mounts: Array<Record<string, unknown>>;
  networks: string[];
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
