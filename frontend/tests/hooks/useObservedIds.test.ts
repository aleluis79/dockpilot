// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useObservedIds } from '../../src/hooks/useObservedIds'

/**
 * Lo que se fija aquí es que el panel se entere **solo**. El pin vive en el
 * backend y en memoria, y hay dos formas de que desaparezca sin que nadie avise:
 * el TTL se lleva el anillo con el pin dentro, y un reinicio del backend se
 * lleva todos de golpe. Ninguna de las dos pasa por un botón, así que un sondeo
 * es la única manera de enterarse.
 *
 * Y lo otro que se fija es que **la respuesta es la única que escribe**. No hay
 * valor optimista en ninguna parte a propósito: si el toggle escribiera a mano y
 * esta respuesta saliera con lo que sabía antes del POST, la marca parpadearía
 * al revés durante un ciclo entero. Con una sola fuente no hay carrera.
 */

let fijados: string[]
let falla = false
let llamadas = 0

beforeEach(() => {
  fijados = []
  falla = false
  llamadas = 0

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      llamadas += 1
      if (falla) throw new Error('no se pudo leer')
      return { ok: true, status: 200, json: async () => fijados } as unknown as Response
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useObservedIds', () => {
  it('pregunta al montarse y entrega lo que hay', async () => {
    fijados = ['c2', 'c1']

    const { result } = renderHook(() => useObservedIds())

    await waitFor(() => expect(result.current.ids).toHaveLength(2))
    // Ordenado, para que dos respuestas iguales den el mismo array y quien dependa
    // de él no se re-renderice por un cambio de orden.
    expect(result.current.ids).toEqual(['c1', 'c2'])
  })

  it('refresh() vuelve a preguntar y recoge el cambio', async () => {
    const { result } = renderHook(() => useObservedIds())
    await waitFor(() => expect(llamadas).toBe(1))

    fijados = ['c1']
    act(() => result.current.refresh())

    await waitFor(() => expect(result.current.ids).toEqual(['c1']))
  })

  it('mantiene la referencia si el contenido no cambia', async () => {
    fijados = ['c1']
    const { result } = renderHook(() => useObservedIds())
    await waitFor(() => expect(result.current.ids).toEqual(['c1']))
    const antes = result.current.ids

    act(() => result.current.refresh())

    await waitFor(() => expect(llamadas).toBe(2))
    // Un array nuevo con lo mismo dentro re-renderizaría a todo el que dependa de
    // él, en cada tic, para no cambiar nada.
    expect(result.current.ids).toBe(antes)
  })

  it('un fallo no borra lo que ya sabía ni propaga un error', async () => {
    fijados = ['c1']
    const { result } = renderHook(() => useObservedIds())
    await waitFor(() => expect(result.current.ids).toEqual(['c1']))

    falla = true
    act(() => result.current.refresh())

    await waitFor(() => expect(llamadas).toBe(2))
    expect(result.current.ids).toEqual(['c1'])
  })

  it('con la vista oculta no pregunta ni al montar', async () => {
    renderHook(() => useObservedIds({ activo: false }))

    await new Promise((r) => setTimeout(r, 30))
    expect(llamadas).toBe(0)
  })

  it('al volver a mirar la vista pregunta otra vez', async () => {
    const { rerender } = renderHook(
      ({ activo }: { activo: boolean }) => useObservedIds({ activo }),
      { initialProps: { activo: true } }
    )
    await waitFor(() => expect(llamadas).toBe(1))

    fijados = ['c1']
    rerender({ activo: false })
    await new Promise((r) => setTimeout(r, 20))
    expect(llamadas).toBe(1)

    rerender({ activo: true })

    await waitFor(() => expect(llamadas).toBeGreaterThan(1))
  })

  it('no pinta nada tras desmontar', async () => {
    let resolver: (() => void) | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolver = () => resolve({ ok: true, status: 200, json: async () => ['c1'] } as unknown as Response)
          })
      )
    )

    const { result, unmount } = renderHook(() => useObservedIds())
    unmount()
    await act(async () => {
      resolver?.()
      await Promise.resolve()
    })

    expect(result.current.ids).toEqual([])
  })
})