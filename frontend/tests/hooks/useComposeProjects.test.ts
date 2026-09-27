import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useComposeProjects } from '../../src/hooks/useComposeProjects'
import type { ComposeOverview } from '../../src/types/compose'

const proyecto = {
  name: 'elasticsearch-local',
  services_count: 2,
  containers_total: 2,
  containers_running: 2,
  networks_count: 1,
  volumes_count: 1,
  config_files: ['/p/docker-compose.yml'],
  working_dir: '/p',
  compose_version: '5.5.1',
  orphaned: false,
}

const overview: ComposeOverview = {
  projects: [
    proyecto,
    { ...proyecto, name: 'simp-sica', containers_total: 0, containers_running: 0, services_count: 0, orphaned: true },
    { ...proyecto, name: 'tickets-app', containers_total: 0, containers_running: 0, services_count: 0, orphaned: true },
  ],
  total_projects: 3,
  running_projects: 1,
  orphaned_projects: 2,
  unlabelled_containers: 1,
  unlabelled_networks: 3,
  unlabelled_volumes: 7,
}

function mockOk(payload: unknown = overview) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => payload })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('useComposeProjects', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.restoreAllMocks())

  it('carga el inventario al montar', async () => {
    mockOk()
    const { result } = renderHook(() => useComposeProjects())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.overview?.total_projects).toBe(3)
    expect(result.current.error).toBeNull()
  })

  it('expone el error cuando el daemon no responde', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ detail: 'El daemon de Docker no responde' }),
      })
    )
    const { result } = renderHook(() => useComposeProjects())

    await waitFor(() => expect(result.current.error).toMatch(/no responde/i))
    expect(result.current.overview).toBeNull()
  })

  it('vuelve a pedir el inventario con refetch', async () => {
    const fetchMock = mockOk()
    const { result } = renderHook(() => useComposeProjects())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      await result.current.refetch()
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('filtra por huérfanos', async () => {
    mockOk()
    const { result } = renderHook(() => useComposeProjects())

    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.setFilter('orphaned'))

    expect(result.current.projects.map((p) => p.name)).toEqual([
      'simp-sica',
      'tickets-app',
    ])
  })

  it('filtra por proyectos en ejecución', async () => {
    mockOk()
    const { result } = renderHook(() => useComposeProjects())

    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.setFilter('running'))

    expect(result.current.projects.map((p) => p.name)).toEqual(['elasticsearch-local'])
  })

  it('busca por nombre conservando el filtro activo', async () => {
    mockOk()
    const { result } = renderHook(() => useComposeProjects())

    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.setFilter('orphaned'))
    act(() => result.current.setSearchQuery('sica'))

    expect(result.current.projects.map((p) => p.name)).toEqual(['simp-sica'])
  })

  it('cuenta los recursos de cada filtro', async () => {
    mockOk()
    const { result } = renderHook(() => useComposeProjects())

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.counts).toEqual({ all: 3, running: 1, orphaned: 2 })
  })
})
