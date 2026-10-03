// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useContainers } from '../../src/hooks/useContainers'
import type { ContainerSummary } from '../../src/types/docker'

/**
 * Lo que se fija aquí es una decisión de diseño, no una casualidad: el cambio de
 * la fila se hace **en memoria y sin refetch**, como el renombrado de SPEC-19.
 *
 * La razón es que el backend ya contestar el valor nuevo en la respuesta del
 * `watch`. Refetcheon por un booleano recorre el host entero para volver a
 * aprender lo que el servidor acaba de decir, y la lista parpadea mientras.
 *
 * La otra mitad del contrato es igual de importante: el aviso tiene que existir.
 * Sin él, la píldora «Observando» de la tabla se queda en lo que decía hasta
 * el refresco manual, que es lo que pasaba.
 */

const c = (over: Partial<ContainerSummary> & { id: string }): ContainerSummary => ({
  name: `app-${over.id}`,
  image: 'nginx:alpine',
  status: 'running',
  state: 'Up 2 hours',
  created: 1727290000,
  ports: [],
  ...over,
})

let lista: ContainerSummary[]

beforeEach(() => {
  lista = [c({ id: 'c1' }), c({ id: 'c2', observed: true }), c({ id: 'c3' })]
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => lista }) as unknown as Response)
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const peticiones = () =>
  (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
    ([url]: [string]) => String(url).includes('/containers')
  ).length

describe('useContainers · setObservedLocal', () => {
  it('cambia la fila del contenedor indicado y sólo esa', async () => {
    const { result } = renderHook(() => useContainers())
    await waitFor(() => expect(result.current.rawContainers).toHaveLength(3))

    act(() => result.current.setObservedLocal('c1', true))

    const porId = Object.fromEntries(result.current.rawContainers.map((x) => [x.id, x.observed]))
    expect(porId).toEqual({ c1: true, c2: true, c3: undefined })
  })

  it('soltar el pin quita la marca en vez de ponerla a false', async () => {
    const { result } = renderHook(() => useContainers())
    await waitFor(() => expect(result.current.rawContainers).toHaveLength(3))

    act(() => result.current.setObservedLocal('c2', false))

    expect(result.current.rawContainers.find((x) => x.id === 'c2')?.observed).toBe(false)
  })

  it('no refetchea: el valor ya lo confirmó el backend', async () => {
    const { result } = renderHook(() => useContainers())
    await waitFor(() => expect(result.current.rawContainers).toHaveLength(3))
    const antes = peticiones()

    act(() => result.current.setObservedLocal('c1', true))

    expect(peticiones()).toBe(antes)
  })

  it('un id que no está en la lista no rompe nada', async () => {
    const { result } = renderHook(() => useContainers())
    await waitFor(() => expect(result.current.rawContainers).toHaveLength(3))

    act(() => result.current.setObservedLocal('no-existe', true))

    expect(result.current.rawContainers).toHaveLength(3)
  })

  it('no toca el resto de campos de la fila', async () => {
    const { result } = renderHook(() => useContainers())
    await waitFor(() => expect(result.current.rawContainers).toHaveLength(3))
    const antes = result.current.rawContainers.find((x) => x.id === 'c3')

    act(() => result.current.setObservedLocal('c3', true))
    const despues = result.current.rawContainers.find((x) => x.id === 'c3')

    expect(despues?.name).toBe(antes?.name)
    expect(despues?.image).toBe(antes?.image)
    expect(despues?.status).toBe(antes?.status)
  })
})