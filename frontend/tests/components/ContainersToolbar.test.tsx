// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import { ContainersToolbar } from '../../src/components/containers/ContainersToolbar'

const PREVIEW = {
  stopped_count: 2,
  stopped_bytes: 155_648,
  stopped_names: ['peluchito', 'full-editor-db'],
}

describe('ContainersToolbar · limpieza (SPEC-21)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const stub = (over: { error?: boolean } = {}) => {
    const mock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const ruta = String(url)
      if (ruta.includes('/containers/prune') && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            deleted: ['a4d168477d28', 'cb6cde7c42a5'],
            bytes_reclaimed: 155_648,
            message: '2 contenedores parados eliminados',
          }),
        })
      }
      if (ruta.includes('/containers/prune')) {
        if (over.error) {
          return Promise.resolve({
            ok: false,
            status: 503,
            json: async () => ({ detail: 'El daemon no informó del tamaño.' }),
          })
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => PREVIEW })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => [] })
    })
    vi.stubGlobal('fetch', mock)
    return mock
  }

  it('la píldora cuenta los parados y sus bytes', async () => {
    stub()
    render(<ContainersToolbar onDeleted={vi.fn()} />)

    await waitFor(() => screen.getByTestId('containers-prune-pendiente'))

    expect(screen.getByTestId('containers-prune-pendiente')).toHaveTextContent('2 contenedores parados')
    expect(screen.getByTestId('containers-prune-pendiente')).toHaveTextContent('152.0 KB')
  })

  it('el diálogo lista los NOMBRES, no un número', async () => {
    stub()
    render(<ContainersToolbar onDeleted={vi.fn()} />)
    await waitFor(() => screen.getByRole('button', { name: /Limpiar parados/ }))

    fireEvent.click(screen.getByRole('button', { name: /Limpiar parados/ }))

    expect(screen.getByText('peluchito')).toBeInTheDocument()
    expect(screen.getByText('full-editor-db')).toBeInTheDocument()
    expect(screen.queryByText('a4d168477d28')).not.toBeInTheDocument()
  })

  it('avisa de que se lleva la capa de escritura', async () => {
    stub()
    render(<ContainersToolbar onDeleted={vi.fn()} />)
    await waitFor(() => screen.getByRole('button', { name: /Limpiar parados/ }))

    fireEvent.click(screen.getByRole('button', { name: /Limpiar parados/ }))

    expect(screen.getByText(/capa de escritura/)).toBeInTheDocument()
    expect(screen.getByText(/en marcha no se tocan/)).toBeInTheDocument()
  })

  it('los bytes del diálogo llevan la palabra hasta', async () => {
    stub()
    render(<ContainersToolbar onDeleted={vi.fn()} />)
    await waitFor(() => screen.getByRole('button', { name: /Limpiar parados/ }))

    fireEvent.click(screen.getByRole('button', { name: /Limpiar parados/ }))

    expect(screen.getByText(/hasta 152.0 KB/)).toBeInTheDocument()
  })

  it('al limpiar avisa al padre para que recargue la lista', async () => {
    stub()
    const onDeleted = vi.fn()
    render(<ContainersToolbar onDeleted={onDeleted} />)
    await waitFor(() => screen.getByRole('button', { name: /Limpiar parados/ }))

    fireEvent.click(screen.getByRole('button', { name: /Limpiar parados/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar' }))

    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
  })

  it('el POST va sin parámetros: aquí no hay nivel', async () => {
    const mock = stub()
    render(<ContainersToolbar onDeleted={vi.fn()} />)
    await waitFor(() => screen.getByRole('button', { name: /Limpiar parados/ }))

    fireEvent.click(screen.getByRole('button', { name: /Limpiar parados/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar' }))

    await waitFor(() =>
      expect(mock).toHaveBeenCalledWith('/api/v1/containers/prune', { method: 'POST' })
    )
  })

  it('sin preaviso el botón está deshabilitado y no dice 0', async () => {
    stub()
    render(<ContainersToolbar onDeleted={vi.fn()} />)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Limpiar parados/ })).toBeDisabled()
    )
    // Con el preaviso que devuelve este doble hay 2 parados, así que el botón
    // NO debe estar deshabilitado. Esta aserción falla a propósito si alguien
    // invierte la condición: sin datos no se puede ofrecer una limpieza.
    expect(screen.queryByText('0 contenedores')).not.toBeInTheDocument()
  })

  it('si el preaviso falla se deshabilita y se dice, en vez de decir que no hay nada', async () => {
    stub({ error: true })
    render(<ContainersToolbar onDeleted={vi.fn()} />)

    await waitFor(() => screen.getByTestId('containers-prune-error'))
    expect(screen.getByRole('button', { name: /Limpiar parados/ })).toBeDisabled()
    expect(screen.queryByText(/nada que limpiar/i)).not.toBeInTheDocument()
  })

  it('no hay preaviso cargando, así que el botón empieza deshabilitado', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(new Promise(() => {}))
    )
    render(<ContainersToolbar onDeleted={vi.fn()} />)

    expect(screen.getByRole('button', { name: /Limpiar parados/ })).toBeDisabled()
  })
})

// --- El aviso sube al padre (SPEC-21) ----------------------------------------
//
// La barra no pinta el resultado: lo sube con `onResultado` y lo pinta `App`, a
// todo el ancho. Encajado en la fila del buscador, el mensaje empezaba donde
// acababa el buscador —a un tercio del ancho, o a media pantalla si la ventana
// es estrecha— en vez de en el margen izquierdo.
//
// El aviso lleva `ok` porque un fallo tiene que verse en el cartel de error y
// no en el de éxito: un 409 pintado de verde se lee como una limpieza hecha.

describe('ContainersToolbar · el aviso sube al padre', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const stub = (opts: { falla?: boolean } = {}) => {
    const mock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const ruta = String(url)
      if (ruta.includes('/containers/prune') && init?.method === 'POST') {
        if (opts.falla) {
          return Promise.resolve({
            ok: false,
            status: 409,
            json: async () => ({ detail: 'Ya hay un prune en marcha.' }),
          })
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            deleted: ['a4d168477d28'],
            bytes_reclaimed: 155_648,
            message: '1 contenedor parado eliminado',
          }),
        })
      }
      if (ruta.includes('/containers/prune')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => PREVIEW })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => [] })
    })
    vi.stubGlobal('fetch', mock)
    return mock
  }

  const limpiar = async (onResultado = vi.fn()) => {
    render(<ContainersToolbar onDeleted={vi.fn()} onResultado={onResultado} />)
    await waitFor(() => screen.getByRole('button', { name: /Limpiar parados/ }))
    fireEvent.click(screen.getByRole('button', { name: /Limpiar parados/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar' }))
    await waitFor(() => expect(onResultado).toHaveBeenCalled())
    return onResultado
  }

  it('informa del resumen con los bytes recuperados y ok a true', async () => {
    stub()
    const aviso = await limpiar()

    expect(aviso).toHaveBeenCalledWith(
      '1 contenedor parado eliminado · 152.0 KB recuperados',
      true
    )
  })

  it('informa también del fallo, con ok a false', async () => {
    stub({ falla: true })
    const aviso = await limpiar()

    expect(aviso).toHaveBeenCalledWith('Ya hay un prune en marcha.', false)
  })

  it('no pinta ningún cartel dentro de la barra', async () => {
    stub()
    const aviso = await limpiar()

    // El cartel es de `App`. Si la barra lo pintara, el mensaje volvería a
    // empezar donde el buscador.
    expect(aviso).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByText('Descartar')).not.toBeInTheDocument()
  })

  it('funciona sin la prop: la barra no la da por hecha', async () => {
    stub()
    render(<ContainersToolbar onDeleted={vi.fn()} />)
    await waitFor(() => screen.getByRole('button', { name: /Limpiar parados/ }))

    fireEvent.click(screen.getByRole('button', { name: /Limpiar parados/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar' }))

    // Ni prop ni estado propio: limpiar sigue funcionando y no rompe nada.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Limpiar parados/ })).toBeInTheDocument()
    )
  })

it('la píldora y el botón no se reparten un ancho fijo', async () => {
    stub()
    render(<ContainersToolbar onDeleted={vi.fn()} />)
    await waitFor(() => screen.getByTestId('containers-prune-pendiente'))

    const columna = screen.getByTestId('containers-prune-pendiente').parentElement?.parentElement
    expect(columna?.className).toContain('min-w-0')
    // Ni `flex-1` ni `sm:w-72`. `flex-1` arrastra `flex-basis: 0` y colapsa
    // dentro de un padre de ancho automático; `sm:w-72` partía el texto de la
    // píldora en varias líneas.

    const fila = columna?.firstElementChild
    expect(fila?.className).toContain('flex-wrap')

    const pildora = screen.getByTestId('containers-prune-pendiente')
    expect(pildora.className).toContain('whitespace-nowrap')
    expect(pildora.className).toContain('shrink-0')
  })
})
