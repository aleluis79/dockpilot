// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useContainers } from '../../src/hooks/useContainers'
import type { ContainerSummary } from '../../src/types/docker'

/**
 * El `observed` de la tabla no sale de la lista de contenedores: sale de
 * `GET /containers/observed`, y aquí se superpone.
 *
 * Dos cosas se fijan, y las dos importan:
 *
 * 1. **Superponer, no escribir.** Si el toggle del modal escribiera el valor en
 *    la lista, habría dos escritores del mismo dato y una respuesta del sondeo
 *    salida antes del POST podría llegar después y dejar la marca al revés un
 *    ciclo entero. Con una sola fuente no hay carrera que ganar.
 * 2. **Lo que no se relectura, no se arregla.** El pin puede desaparecer sin que
 *    nadie avise —el TTL se lleva el anillo con el pin, y un reinicio del
 *    backend se lleva todos—, y la lista tiene que enterarse por sí sola.
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
let fijados: string[]
let endpointFalla = false

beforeEach(() => {
  lista = [c({ id: 'c1' }), c({ id: 'c2' }), c({ id: 'c3' })]
  fijados = []
  endpointFalla = false

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const ruta = String(url)
      if (ruta.endsWith('/containers/observed')) {
        if (endpointFalla) throw new Error('no se pudo leer')
        return { ok: true, status: 200, json: async () => fijados } as unknown as Response
      }
      return { ok: true, status: 200, json: async () => lista } as unknown as Response
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const peticionesALista = () =>
  (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([url]: [string]) =>
    String(url).includes('/containers') && !String(url).includes('/observed')
  ).length

const marcas = (cs: ContainerSummary[]) => cs.map((x) => [x.id, x.observed ?? false])

describe('useContainers · el pin de observación', () => {
  it('marca lo que dice la ruta de observados, no lo que traía la lista', async () => {
    // La lista dice que c2 no está fijado y la ruta de observados que sí: si
    // leyera la lista, la marca se perdería.
    lista = [c({ id: 'c1' }), c({ id: 'c2' }), c({ id: 'c3', observed: true })]
    fijados = ['c2']

    const { result } = renderHook(() => useContainers())
    await waitFor(() => expect(result.current.rawContainers).toHaveLength(3))

    expect(marcas(result.current.rawContainers)).toEqual([
      ['c1', false],
      ['c2', true],
      ['c3', false],
    ])
  })

  it('la misma marca sale en la tabla y en el censo', async () => {
    fijados = ['c3']

    const { result } = renderHook(() => useContainers())
    await waitFor(() => expect(result.current.rawContainers).toHaveLength(3))

    const enTabla = Object.fromEntries(marcas(result.current.containers))
    const enCenso = Object.fromEntries(marcas(result.current.rawContainers))
    expect(enTabla).toEqual(enCenso)
  })

  it('soltar el pin en el servidor quita la marca sin tocar el resto de la fila', async () => {
    fijados = ['c2']
    const { result } = renderHook(() => useContainers())
    await waitFor(() => expect(marcas(result.current.rawContainers)[1][1]).toBe(true))

    // Es lo que pasa cuando el TTL expulsa el anillo o el backend se reinicia.
    fijados = []
    act(() => result.current.refreshObserved())

    await waitFor(() => expect(marcas(result.current.rawContainers)[1][1]).toBe(false))
    expect(result.current.rawContainers[1]?.name).toBe('app-c2')
    expect(result.current.rawContainers[1]?.image).toBe('nginx:alpine')
  })

  it('no refetchea la lista de contenedores al releer los pines', async () => {
    const { result } = renderHook(() => useContainers())
    await waitFor(() => expect(result.current.rawContainers).toHaveLength(3))
    const antes = peticionesALista()

    fijados = ['c1']
    act(() => result.current.refreshObserved())
    await waitFor(() => expect(marcas(result.current.rawContainers)[0][1]).toBe(true))

    // La razón de que exista la ruta aparte: esto no puede ser un
    // `containers.list()` por enterarse de un booleano.
    expect(peticionesALista()).toBe(antes)
  })

  it('sondea solo con la vista de contenedores delante', async () => {
    const { rerender, unmount } = renderHook(
      ({ activo }: { activo: boolean }) => useContainers({ activo }),
      { initialProps: { activo: true } }
    )
    await waitFor(() =>
      expect(
        (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([u]: [string]) =>
          String(u).includes('/observed')
        )
      ).toBe(true)
    )

    const antes =
      (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([u]: [string]) =>
        String(u).includes('/observed')
      ).length

    // Fuera de la vista: ni una más. Un panel en una pestaña en segundo plano no
    // debería preguntar nada.
    rerender({ activo: false })
    await new Promise((r) => setTimeout(r, 30))
    const durante =
      (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([u]: [string]) =>
        String(u).includes('/observed')
      ).length
    expect(durante).toBe(antes)

    unmount()
  })

  it('un fallo de la ruta no tira la lista ni pone una alerta roja', async () => {
    endpointFalla = true
    const { result } = renderHook(() => useContainers())

    await waitFor(() => expect(result.current.rawContainers).toHaveLength(3))

    // La lista sigue valiendo: es una marca lo único que puede quedar viejo.
    expect(result.current.error).toBeNull()
  })
})