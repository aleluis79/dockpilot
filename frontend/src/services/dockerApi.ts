/**
 * DockPilot - system.ts
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU Affero General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option) any
 * later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more
 * details.
 *
 * You should have received a copy of the GNU Affero General Public License along
 * with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * Licencia: AGPL-3.0-or-later. Titular del copyright: Alejandro.
 * Fecha: 2026.
 */

import type {
  ContainerSummary,
  ContainerDetail,
  ContainerActionResponse,
  CreateContainerRequest,
  CreateContainerResponse,
} from '../types/docker'
import type { ContainerStats } from '../types/stats'
import type {
  ImageDeleteResponse,
  ImageDetail,
  ImageSearchResult,
  LocalImageSummary,
} from '../types/image'
import type {
  CreateNetworkRequest,
  NetworkDeleteResponse,
  NetworkDetail,
  NetworkPruneResult,
  NetworkSummary,
} from '../types/network'
import type { DiskUsage, SystemInfo, SystemOverview } from '../types/system'
import type {
  VolumeDeleteResponse,
  VolumeDetail,
  VolumePruneResult,
  VolumeSummary,
} from '../types/volume'

const BASE_URL = '/api/v1'

/**
 * Patrón de referencia de imagen replicado del backend (SPEC-07 §3.2).
 * Se mantiene en cliente para dar feedback inmediato sin ir al servidor.
 */
const IMAGE_REF_PATTERN =
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?::\d+)?(?:\/[a-zA-Z0-9_][a-zA-Z0-9._-]*)*(?::[a-zA-Z0-9._-]+)?(?:@sha256:[a-f0-9]{64})?$/

const MAX_IMAGE_REF_LENGTH = 255

/** Resumen previo a la limpieza, para poder confirmar con cifras (SPEC-08 §3.4). */
export interface UnusedVolumesSummary {
  count: number
  bytes: number
  names: string[]
}

export function isValidImageRef(ref: string): boolean {
  const candidate = (ref ?? '').trim()
  if (!candidate || candidate.length > MAX_IMAGE_REF_LENGTH) return false
  return IMAGE_REF_PATTERN.test(candidate)
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let errorDetail = `Error ${res.status}: ${res.statusText}`
    try {
      const data = await res.json()
      if (data?.detail) {
        errorDetail = data.detail
      }
    } catch {
      // Ignorar si el cuerpo no es JSON
    }
    throw new Error(errorDetail)
  }
  return res.json()
}

export const dockerApi = {
  async listContainers(all: boolean = true, status?: string): Promise<ContainerSummary[]> {
    const params = new URLSearchParams()
    if (all) params.append('all', 'true')
    if (status) params.append('status', status)
    const url = `${BASE_URL}/containers${params.toString() ? `?${params.toString()}` : ''}`
    const res = await fetch(url)
    return handleResponse<ContainerSummary[]>(res)
  },

  async getContainer(id: string): Promise<ContainerDetail> {
    const res = await fetch(`${BASE_URL}/containers/${id}`)
    return handleResponse<ContainerDetail>(res)
  },

  async createContainer(data: CreateContainerRequest): Promise<CreateContainerResponse> {
    const res = await fetch(`${BASE_URL}/containers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    })
    return handleResponse<CreateContainerResponse>(res)
  },

  async startContainer(id: string): Promise<ContainerActionResponse> {
    const res = await fetch(`${BASE_URL}/containers/${id}/start`, { method: 'POST' })
    return handleResponse<ContainerActionResponse>(res)
  },

  async stopContainer(id: string, timeout: number = 10): Promise<ContainerActionResponse> {
    const res = await fetch(`${BASE_URL}/containers/${id}/stop?timeout=${timeout}`, {
      method: 'POST',
    })
    return handleResponse<ContainerActionResponse>(res)
  },

  async restartContainer(id: string, timeout: number = 10): Promise<ContainerActionResponse> {
    const res = await fetch(`${BASE_URL}/containers/${id}/restart?timeout=${timeout}`, {
      method: 'POST',
    })
    return handleResponse<ContainerActionResponse>(res)
  },

  async pauseContainer(id: string): Promise<ContainerActionResponse> {
    const res = await fetch(`${BASE_URL}/containers/${id}/pause`, { method: 'POST' })
    return handleResponse<ContainerActionResponse>(res)
  },

  async unpauseContainer(id: string): Promise<ContainerActionResponse> {
    const res = await fetch(`${BASE_URL}/containers/${id}/unpause`, { method: 'POST' })
    return handleResponse<ContainerActionResponse>(res)
  },

  async removeContainer(
    id: string,
    force: boolean = false,
    v: boolean = false
  ): Promise<ContainerActionResponse> {
    const res = await fetch(`${BASE_URL}/containers/${id}?force=${force}&v=${v}`, {
      method: 'DELETE',
    })
    return handleResponse<ContainerActionResponse>(res)
  },

  async getContainerStats(id: string): Promise<ContainerStats> {
    const res = await fetch(`${BASE_URL}/containers/${id}/stats`)
    return handleResponse<ContainerStats>(res)
  },

  async getVolumes(): Promise<VolumeSummary[]> {
    const res = await fetch(`${BASE_URL}/volumes`)
    return handleResponse<VolumeSummary[]>(res)
  },

  async getVolume(name: string): Promise<VolumeDetail> {
    const res = await fetch(`${BASE_URL}/volumes/${encodeURIComponent(name)}`)
    return handleResponse<VolumeDetail>(res)
  },

  /**
   * Vista completa del host en una sola peticion: informacion del sistema,
   * consumo de disco y mayores consumidores (SPEC-09).
   */
  async getSystemOverview(): Promise<SystemOverview> {
    const res = await fetch(`${BASE_URL}/system/overview`)
    return handleResponse<SystemOverview>(res)
  },

  async getSystemInfo(): Promise<SystemInfo> {
    const res = await fetch(`${BASE_URL}/system/info`)
    return handleResponse<SystemInfo>(res)
  },

  async getDiskUsage(): Promise<DiskUsage> {
    const res = await fetch(`${BASE_URL}/system/df`)
    return handleResponse<DiskUsage>(res)
  },

  async listNetworks(): Promise<NetworkSummary[]> {
    const res = await fetch(`${BASE_URL}/networks`)
    return handleResponse<NetworkSummary[]>(res)
  },

  async getNetwork(name: string): Promise<NetworkDetail> {
    const res = await fetch(`${BASE_URL}/networks/${encodeURIComponent(name)}`)
    return handleResponse<NetworkDetail>(res)
  },

  async createNetwork(payload: CreateNetworkRequest): Promise<NetworkDetail> {
    const res = await fetch(`${BASE_URL}/networks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return handleResponse<NetworkDetail>(res)
  },

  async deleteNetwork(name: string, force = false): Promise<NetworkDeleteResponse> {
    const res = await fetch(
      `${BASE_URL}/networks/${encodeURIComponent(name)}?force=${force}`,
      { method: 'DELETE' }
    )
    return handleResponse<NetworkDeleteResponse>(res)
  },

  async pruneNetworks(): Promise<NetworkPruneResult> {
    const res = await fetch(`${BASE_URL}/networks/prune`, { method: 'POST' })
    return handleResponse<NetworkPruneResult>(res)
  },

  async getUnusedVolumesSummary(): Promise<UnusedVolumesSummary> {
    const res = await fetch(`${BASE_URL}/volumes/prune`)
    return handleResponse<UnusedVolumesSummary>(res)
  },

  async pruneVolumes(): Promise<VolumePruneResult> {
    const res = await fetch(`${BASE_URL}/volumes/prune`, { method: 'POST' })
    return handleResponse<VolumePruneResult>(res)
  },

  async deleteVolume(name: string, force: boolean = false): Promise<VolumeDeleteResponse> {
    const res = await fetch(
      `${BASE_URL}/volumes/${encodeURIComponent(name)}?force=${force}`,
      { method: 'DELETE' }
    )
    return handleResponse<VolumeDeleteResponse>(res)
  },

  async getLocalImages(): Promise<LocalImageSummary[]> {
    const res = await fetch(`${BASE_URL}/images/local`)
    return handleResponse<LocalImageSummary[]>(res)
  },

  async getImage(id: string): Promise<ImageDetail> {
    const res = await fetch(`${BASE_URL}/images/${id}`)
    return handleResponse<ImageDetail>(res)
  },

  async deleteImage(id: string, force: boolean = false): Promise<ImageDeleteResponse> {
    const res = await fetch(`${BASE_URL}/images/${id}?force=${force}`, { method: 'DELETE' })
    return handleResponse<ImageDeleteResponse>(res)
  },

  async searchImages(term: string, limit: number = 10): Promise<ImageSearchResult[]> {
    const params = new URLSearchParams({ term, limit: String(limit) })
    const res = await fetch(`${BASE_URL}/images/search?${params.toString()}`)
    return handleResponse<ImageSearchResult[]>(res)
  },
}
