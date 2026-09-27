// SPDX-License-Identifier: AGPL-3.0-or-later
export interface NetworkSubnet {
  /** CIDR de la subred, p. ej. 172.18.0.0/16 */
  subnet: string
  gateway: string
}

export interface NetworkSummary {
  id: string
  name: string
  driver: string
  scope: string
  /** Sin salida a internet. */
  internal: boolean
  attachable: boolean
  enable_ipv6: boolean
  /** Fecha de creación en ISO 8601. */
  created: string
  subnets: NetworkSubnet[]
  /** Contenedores conectados; 0 = eliminable. */
  container_count: number
  /** Red predefinida de Docker (none, host, bridge); no se puede borrar. */
  is_builtin: boolean
  /** Proyecto Docker Compose al que pertenece, si la etiqueta existe. */
  compose_project?: string | null
}

export interface NetworkDetail extends NetworkSummary {
  options: Record<string, unknown>
  labels: Record<string, string>
  /** Nombres de los contenedores conectados. */
  containers: string[]
}

export interface CreateNetworkRequest {
  name: string
  driver: string
  subnet?: string | null
  gateway?: string | null
  internal: boolean
  labels: Record<string, string>
}

export interface NetworkDeleteResponse {
  name: string
  deleted: boolean
  message: string
}

export interface NetworkPruneResult {
  deleted: string[]
  message: string
}
