import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { dockerApi } from '../../src/services/dockerApi'
import type { SystemInfo, DiskUsage, SystemOverview } from '../../src/types/system'

const info: SystemInfo = {
  server_version: '29.8.1', os_name: 'Debian', os_type: 'linux', architecture: 'x86_64',
  kernel_version: '6.12.0', hostname: 'test', ncpu: 12, memory_total: 32827215872,
  storage_driver: 'overlayfs', docker_root_dir: '/var/lib/docker', containers_total: 1,
  containers_running: 1, containers_stopped: 0, containers_paused: 0, images_total: 1,
}

const usage: DiskUsage = {
  layers_size: 0,
  images: { total_count: 1, active_count: 1, total_size: 1, reclaimable: 0 },
  containers: { total_count: 1, active_count: 1, total_size: 0, reclaimable: 0 },
  volumes: { total_count: 0, active_count: 0, total_size: 0, reclaimable: 0 },
  build_cache_size: 0,
}

const overview: SystemOverview = { info, usage, top_images: [], top_volumes: [] }

describe('dockerApi · sistema', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.restoreAllMocks())

  it('getSystemOverview consulta /system/overview', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => overview })
    vi.stubGlobal('fetch', fetchMock)

    const data = await dockerApi.getSystemOverview()

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/system/overview')
    expect(data.info.server_version).toBe('29.8.1')
    expect(data.usage.volumes.total_count).toBe(0)
  })

  it('getSystemInfo consulta /system/info', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => info })
    vi.stubGlobal('fetch', fetchMock)

    const data = await dockerApi.getSystemInfo()

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/system/info')
    expect(data.ncpu).toBe(12)
  })

  it('getDiskUsage consulta /system/df', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => usage })
    vi.stubGlobal('fetch', fetchMock)

    const data = await dockerApi.getDiskUsage()

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/system/df')
    expect(data.images.total_count).toBe(1)
  })

  it('propaga el mensaje de error del daemon', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ detail: 'daemon no disponible' }) })
    )

    await expect(dockerApi.getSystemOverview()).rejects.toThrow('daemon no disponible')
    await expect(dockerApi.getSystemInfo()).rejects.toThrow('daemon no disponible')
    await expect(dockerApi.getDiskUsage()).rejects.toThrow('daemon no disponible')
  })
})
