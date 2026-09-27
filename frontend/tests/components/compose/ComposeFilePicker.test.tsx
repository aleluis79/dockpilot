// SPDX-License-Identifier: AGPL-3.0-or-later
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposeFilePicker } from '../../../src/components/compose/ComposeFilePicker'
import { dockerApi } from '../../../src/services/dockerApi'
import type { BrowseEntry, BrowseResult } from '../../../src/types/compose'

const raiz = '/home/usuario'

function dir(name: string, extra: Partial<BrowseEntry> = {}): BrowseEntry {
  return {
    name,
    path: `${raiz}/${name}`,
    kind: 'dir',
    es_compose: false,
    size: 0,
    modificado: 0,
    ...extra,
  }
}

function file(name: string, extra: Partial<BrowseEntry> = {}): BrowseEntry {
  return {
    name,
    path: `${raiz}/${name}`,
    kind: 'file',
    es_compose: name.includes('compose'),
    size: 120,
    modificado: 0,
    ...extra,
  }
}

function resultado(extra: Partial<BrowseResult> = {}): BrowseResult {
  return {
    path: raiz,
    root: raiz,
    parent: null,
    entries: [dir('sica'), file('docker-compose.yml')],
    total: 2,
    truncado: false,
    ocultos: 0,
    ...extra,
  }
}

const browseSpy = vi.spyOn(dockerApi, 'browseComposeFiles')

describe('ComposeFilePicker', () => {
  beforeEach(() => {
    browseSpy.mockReset()
    browseSpy.mockResolvedValue(resultado())
  })

  it('arranca en la raíz y pide el listado', async () => {
    const onSelect = vi.fn()
    render(<ComposeFilePicker open onClose={vi.fn()} onSelect={onSelect} />)

    // Sin ruta: la raíz la decide el backend, no el cliente.
    expect(browseSpy).toHaveBeenCalledWith()
    expect(await screen.findByText('sica')).toBeInTheDocument()
  })

  it('no elige nada por su cuenta al abrir', async () => {
    const onSelect = vi.fn()
    render(<ComposeFilePicker open onClose={vi.fn()} onSelect={onSelect} />)

    await screen.findByText('sica')

    // Elegir el fichero y previsualizarlo son pasos separados: abrir el
    // explorador no puede rellenar la ruta ni lanzar nada.
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('elige un fichero y cierra', async () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(<ComposeFilePicker open onClose={onClose} onSelect={onSelect} />)

    fireEvent.click(await screen.findByText('docker-compose.yml'))

    expect(onSelect).toHaveBeenCalledWith(`${raiz}/docker-compose.yml`)
    expect(onClose).toHaveBeenCalled()
  })

  it('un directorio navega en vez de elegir', async () => {
    const onSelect = vi.fn()
    browseSpy
      .mockResolvedValueOnce(resultado())
      .mockResolvedValueOnce(
        resultado({ path: `${raiz}/sica`, parent: raiz, entries: [file('docker-compose.yml')] })
      )
    render(<ComposeFilePicker open onClose={vi.fn()} onSelect={onSelect} />)

    fireEvent.click(await screen.findByText('sica'))

    expect(browseSpy).toHaveBeenLastCalledWith(`${raiz}/sica`)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('sube al padre y lo deshabilita en la raíz', async () => {
    browseSpy
      .mockResolvedValueOnce(resultado())
      .mockResolvedValueOnce(resultado({ path: `${raiz}/sica`, parent: raiz, entries: [] }))
    render(<ComposeFilePicker open onClose={vi.fn()} onSelect={vi.fn()} />)

    const subir = await screen.findByRole('button', { name: /subir/i })
    expect(subir).toBeDisabled()

    fireEvent.click(await screen.findByText('sica'))
    await waitFor(() => expect(screen.getByRole('button', { name: /subir/i })).toBeEnabled())
  })

  it('el botón de subir lleva al padre que dice el backend', async () => {
    browseSpy
      .mockResolvedValueOnce(resultado({ entries: [dir('sica')] }))
      .mockResolvedValueOnce(
        resultado({ path: `${raiz}/sica`, parent: raiz, entries: [file('compose.yaml')] })
      )
      .mockResolvedValueOnce(resultado())
    render(<ComposeFilePicker open onClose={vi.fn()} onSelect={vi.fn()} />)

    // Primero se entra al subdirectorio, y solo entonces "Subir" tiene sentido.
    fireEvent.click(await screen.findByText('sica'))
    await waitFor(() =>
      expect(screen.getByTestId('compose-browser-path')).toHaveTextContent(`${raiz}/sica`)
    )

    fireEvent.click(screen.getByRole('button', { name: /subir/i }))

    // El `parent` del backend es el que manda, no un `dirname` calculado en el
    // cliente: si el padre es la raíz, el siguiente paso es la raíz.
    expect(browseSpy).toHaveBeenLastCalledWith(raiz)
  })

  it('muestra el camino completo en las migas de pan', async () => {
    browseSpy.mockResolvedValue(
      resultado({ path: `${raiz}/proyectos/sica`, parent: `${raiz}/proyectos`, entries: [] })
    )
    render(<ComposeFilePicker open onClose={vi.fn()} onSelect={vi.fn()} />)

    await waitFor(() =>
      expect(screen.getByTestId('compose-browser-path')).toHaveTextContent(
        `${raiz}/proyectos/sica`
      )
    )
  })

  it('avisa cuando el listado llega truncado', async () => {
    browseSpy.mockResolvedValue(
      resultado({ entries: [file('docker-compose.yml')], total: 1200, truncado: true })
    )
    render(<ComposeFilePicker open onClose={vi.fn()} onSelect={vi.fn()} />)

    const aviso = await screen.findByText(/1200/)
    expect(aviso).toBeInTheDocument()
    expect(aviso.textContent).toMatch(/mostrando/i)
  })

  it('avisa de las entradas omitidas por salir de la raíz', async () => {
    browseSpy.mockResolvedValue(resultado({ ocultos: 3 }))
    render(<ComposeFilePicker open onClose={vi.fn()} onSelect={vi.fn()} />)

    const aviso = await screen.findByText(/3/)
    expect(aviso.textContent).toMatch(/omitid/i)
  })

  it('no avisa de nada cuando el listado está completo', async () => {
    render(<ComposeFilePicker open onClose={vi.fn()} onSelect={vi.fn()} />)

    await screen.findByText('sica')

    expect(screen.queryByText(/mostrando/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/omitid/i)).not.toBeInTheDocument()
  })

  it('muestra el error del backend sin romperse', async () => {
    browseSpy.mockRejectedValue(new Error('Esa ruta está fuera del explorador.'))
    render(<ComposeFilePicker open onClose={vi.fn()} onSelect={vi.fn()} />)

    expect(await screen.findByText(/fuera del explorador/i)).toBeInTheDocument()
  })

  it('un directorio vacío no es un error', async () => {
    browseSpy.mockResolvedValue(resultado({ entries: [], total: 0 }))
    render(<ComposeFilePicker open onClose={vi.fn()} onSelect={vi.fn()} />)

    expect(await screen.findByText(/vacío/i)).toBeInTheDocument()
  })

  it('no se renderiza si está cerrado', () => {
    render(<ComposeFilePicker open={false} onClose={vi.fn()} onSelect={vi.fn()} />)

    expect(browseSpy).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
