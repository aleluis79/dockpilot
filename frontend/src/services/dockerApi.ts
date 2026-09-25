import type {
  ContainerSummary,
  ContainerDetail,
  ContainerActionResponse,
  ImageSearchResult,
  LocalImageSummary,
  CreateContainerRequest,
  CreateContainerResponse,
} from '../types/docker'

const BASE_URL = '/api/v1'

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

  async getLocalImages(): Promise<LocalImageSummary[]> {
    const res = await fetch(`${BASE_URL}/images/local`)
    return handleResponse<LocalImageSummary[]>(res)
  },

  async searchImages(term: string, limit: number = 10): Promise<ImageSearchResult[]> {
    const params = new URLSearchParams({ term, limit: String(limit) })
    const res = await fetch(`${BASE_URL}/images/search?${params.toString()}`)
    return handleResponse<ImageSearchResult[]>(res)
  },
}
