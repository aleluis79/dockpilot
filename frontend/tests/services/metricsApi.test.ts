// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { dockerApi } from '../../src/services/dockerApi'
import type { MetricsHistory } from '../../src/types/metrics'

const history: MetricsHistory = {
  container_id: 'c123',
  container_name: 'web-app',
  running: true,
  observed: true,
  sampling: true,
  interval_s: 2,
  window_s: 900,
  truncated: false,
  samples: [],
}

describe('dockerApi · métricas (SPEC-17)', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.unstubAllGlobals()
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

  it('getContainerMetrics consume /metrics', async () => {
    const fetchMock = stubFetch(history)

    const result = await dockerApi.getContainerMetrics('c123')

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/containers/c123/metrics')
    expect(result.observed).toBe(true)
  })

  it('watchContainer hace POST al mismo path que unwatch', async () => {
    const fetchMock = stubFetch({ container_id: 'c123', observed: true })

    await dockerApi.watchContainer('c123')

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/containers/c123/watch', { method: 'POST' })
  })

  it('unwatchContainer hace DELETE', async () => {
    const fetchMock = stubFetch({ container_id: 'c123', observed: false })

    const result = await dockerApi.unwatchContainer('c123')

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/containers/c123/watch', { method: 'DELETE' })
    expect(result.observed).toBe(false)
  })

  it('propaga el mensaje de error del 409 del límite', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ detail: 'Ya se observan 12 contenedores, que es el máximo.' }),
      })
    )

    await expect(dockerApi.watchContainer('c123')).rejects.toThrow(/12 contenedores/)
  })
})