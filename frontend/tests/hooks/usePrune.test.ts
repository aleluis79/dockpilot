// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useContainerPrunePreview, useImagePrunePreview } from '../../src/hooks/usePrune'
import type { ContainerPrunePreview } from '../../src/types/docker'

/**
 * El fallo que estos tests fijan es un bucle, y un bucle no se ve en el código:
 * se ve en la consola del backend. `usePreview` recibía `cargar` como flecha
 * nueva en cada render y lo metía en las dependencias de `reload`, con lo que
 * el efecto se re-disparaba en cada render y cada respuesta renderizaba otra
 * vez. Resultado: un `GET /containers/prune` por render, indefinidamente, con
 * la consola del backend como único síntoma.
 *
 * Por eso la primera prueba no mira el resultado: mira **cuántas** veces se
 * pidió. Un test que sólo comprobara el dato habría pasado con el bucle.
 */

const PREVIEW: ContainerPrunePreview = {
  stopped_count: 2,
  stopped_bytes: 2048,
}

let pedir: ReturnType<typeof vi.fn>

beforeEach(() => {
  pedir = vi.fn().mockResolvedValue(PREVIEW)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      pedir(String(url))
      return { ok: true, status: 200, json: async () => PREVIEW } as unknown as Response
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const veces = (sufijo: string) =>
  pedir.mock.calls.filter(([url]: [string]) => url.endsWith(sufijo)).length

describe('usePreview', () => {
  it('pide el preaviso UNA vez y no una por render', async () => {
    const { rerender } = renderHook(() => useContainerPrunePreview())

    await waitFor(() => expect(veces('/containers/prune')).toBe(1))

    // Esto es lo que disparaba el bucle: renders que no cambian nada.
    for (let i = 0; i < 5; i++) rerender()
    await act(async () => {
      await Promise.resolve()
    })

    expect(veces('/containers/prune')).toBe(1)
  })

  it('publica el preaviso y deja de cargar', async () => {
    const { result } = renderHook(() => useContainerPrunePreview())

    await waitFor(() => expect(result.current.preview).toEqual(PREVIEW))
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('reload vuelve a pedir aunque el hook no se haya movido', async () => {
    const { result } = renderHook(() => useContainerPrunePreview())

    await waitFor(() => expect(veces('/containers/prune')).toBe(1))

    await act(async () => {
      await result.current.reload()
    })

    expect(veces('/containers/prune')).toBe(2)
  })

  it('un fallo se dice y no se convierte en lista vacía', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('el daemon no responde')
      })
    )

    const { result } = renderHook(() => useContainerPrunePreview())

    await waitFor(() => expect(result.current.error).toBe('el daemon no responde'))
    // `preview` a null significa «no se sabe», no «no hay nada que limpiar».
    expect(result.current.preview).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it('no pinta nada tras desmontar', async () => {
    let resolver: (() => void) | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolver = () => resolve({ ok: true, status: 200, json: async () => PREVIEW } as unknown as Response)
          })
      )
    )

    const { result, unmount } = renderHook(() => useContainerPrunePreview())
    const antes = result.current.preview
    unmount()
    await act(async () => {
      resolver?.()
      await Promise.resolve()
    })

    expect(result.current.preview).toBe(antes)
  })

  it('el preaviso de imágenes se pide una vez y por su propia ruta', async () => {
    const { result } = renderHook(() => useImagePrunePreview())

    // Se espera al ESTADO y no al número de llamadas: la llamada se cuenta en
    // cuanto sale, pero el `preview` aún no está hasta que la promesa resuelve.
    // Esperar sólo la cuenta hace que esta prueba SEA la intermitente.
    await waitFor(() => expect(result.current.preview).toEqual(PREVIEW))
    expect(veces('/images/prune')).toBe(1)
    expect(veces('/containers/prune')).toBe(0)
  })
})