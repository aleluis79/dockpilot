import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { dockerApi, isValidImageRef } from '../../src/services/dockerApi'
import type { ImageDetail, LocalImageSummary } from '../../src/types/image'

const localImage: LocalImageSummary = {
  id: 'sha256:img1',
  tags: ['nginx:alpine'],
  size: 100,
  created: 1,
  containers: 0,
  repo_digests: [],
}

const detail: ImageDetail = {
  id: 'sha256:img1',
  tags: ['nginx:alpine'],
  repo_digests: [],
  size: 100,
  created: 1,
  architecture: 'amd64',
  os: 'linux',
  env: [],
  exposed_ports: {},
  working_dir: '',
  user: '',
  labels: {},
  layer_count: 1,
  history: [],
}

describe('dockerApi · imágenes', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  const stubFetch = (payload: unknown, ok = true) => {
    const mock = vi.fn().mockResolvedValue({
      ok,
      status: ok ? 200 : 500,
      json: async () => payload,
    })
    vi.stubGlobal('fetch', mock)
    return mock
  }

  it('getLocalImages consume /images/local', async () => {
    const fetchMock = stubFetch([localImage])

    const result = await dockerApi.getLocalImages()

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/images/local')
    expect(result).toEqual([localImage])
  })

  it('getImage consume /images/{id}', async () => {
    const fetchMock = stubFetch(detail)

    const result = await dockerApi.getImage('nginx:alpine')

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/images/nginx:alpine')
    expect(result.layer_count).toBe(1)
  })

  it('deleteImage propaga force', async () => {
    const fetchMock = stubFetch({ id: 'nginx:alpine', deleted: true, untagged: [], message: 'ok' })

    await dockerApi.deleteImage('nginx:alpine', true)

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/images/nginx:alpine?force=true', {
      method: 'DELETE',
    })
  })

  it('deleteImage sin force usa force=false', async () => {
    const fetchMock = stubFetch({ id: 'nginx:alpine', deleted: true, untagged: [], message: 'ok' })

    await dockerApi.deleteImage('nginx:alpine')

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/images/nginx:alpine?force=false', {
      method: 'DELETE',
    })
  })

  it('propaga el mensaje de error del backend', async () => {
    stubFetch({ detail: 'Imagen nginx:alpine no encontrada' }, false)

    await expect(dockerApi.getImage('nginx:alpine')).rejects.toThrow(
      'Imagen nginx:alpine no encontrada'
    )
  })

  it('isValidImageRef replica el patrón del backend', () => {
    expect(isValidImageRef('nginx:alpine')).toBe(true)
    expect(isValidImageRef('localhost:5000/app:dev')).toBe(true)
    expect(isValidImageRef(`x@sha256:${'a'.repeat(64)}`)).toBe(true)
    expect(isValidImageRef('nginx alpine')).toBe(false)
    expect(isValidImageRef('nginx/alpine/../etc')).toBe(false)
    expect(isValidImageRef('a'.repeat(300))).toBe(false)
  })
})
