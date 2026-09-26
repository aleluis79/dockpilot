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

const BASE_URL = '/api/v1'

/**
 * Patrón de referencia de imagen replicado del backend (SPEC-07 §3.2).
 * Se mantiene en cliente para dar feedback inmediato sin往返 al servidor.
 */
const IMAGE_REF_PATTERN =
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?::\d+)?(?:\/[a-zA-Z0-9_][a-zA-Z0-9._-]*)*(?::[a-zA-Z0-9._-]+)?(?:@sha256:[a-f0-9]{64})?$/

const MAX_IMAGE_REF_LENGTH = 255

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
