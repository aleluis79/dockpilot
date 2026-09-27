import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SystemSummaryBar } from '../../src/components/system/SystemSummaryBar'
import type { SystemOverview } from '../../src/types/system'

const overview: SystemOverview = {
  info: {
    server_version: '29.8.1',
    os_name: 'Debian GNU/Linux 13 (trixie)',
    os_type: 'linux',
    architecture: 'x86_64',
    kernel_version: '6.12.0',
    hostname: 'dockpilot-test',
    ncpu: 12,
    memory_total: 32827215872,
    storage_driver: 'overlayfs',
    docker_root_dir: '/var/lib/docker',
    containers_total: 2,
    containers_running: 1,
    containers_stopped: 1,
    containers_paused: 0,
    images_total: 4,
  },
  usage: {
    layers_size: 1073741824,
    images: { total_count: 4, active_count: 2, total_size: 2147483648, reclaimable: 1073741824 },
    containers: { total_count: 2, active_count: 1, total_size: 1048576, reclaimable: 524288 },
    volumes: { total_count: 5, active_count: 1, total_size: 53747987, reclaimable: 53747987 },
    build_cache_size: 123456789,
  },
  top_images: [
    { kind: 'image', name: 'tmp/builder-leftover:latest', size: 1073741824, detail: 'Sin usar' },
    { kind: 'image', name: 'postgres:16-alpine', size: 536870912, detail: 'Usada por 1 contenedor' },
  ],
  top_volumes: [{ kind: 'volume', name: 'datos-app', size: 104857600, detail: 'Sin usar' }],
}

function mockOverview(datos: unknown = overview) {
  const fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, json: async () => datos })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('SystemSummaryBar', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.restoreAllMocks())

  it('muestra los datos clave del host', async () => {
    mockOverview()
    render(<SystemSummaryBar />)

    await waitFor(() => expect(screen.getByText('29.8.1')).toBeInTheDocument())
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText(/30\.6 GB/)).toBeInTheDocument()
    expect(screen.getByText('overlayfs')).toBeInTheDocument()
  })

  it('muestra el conteo de contenedores e imágenes', async () => {
    mockOverview()
    render(<SystemSummaryBar />)

    await waitFor(() => expect(screen.getByText('29.8.1')).toBeInTheDocument())
    expect(screen.getByText(/2 contenedores/)).toBeInTheDocument()
    expect(screen.getByText(/4 imágenes/)).toBeInTheDocument()
  })

  it('indica el espacio recuperable en vez del total', async () => {
    // Lo accionable es lo que se puede liberar, no el total ocupado.
    mockOverview()
    render(<SystemSummaryBar />)

    await waitFor(() => expect(screen.getByText('29.8.1')).toBeInTheDocument())
    expect(screen.getByText(/recuperable/i)).toBeInTheDocument()
    // 1 GiB de imágenes + 53747987 bytes de volúmenes = 1.05 GiB -> "1.1 GB"
    // El valor y la etiqueta comparten nodo, asi que se busca por fragmento
    expect(screen.getByText(/1\.1 GB/)).toBeInTheDocument()
  })

  it('permite abrir y cerrar el detalle', async () => {
    mockOverview()
    render(<SystemSummaryBar />)

    await waitFor(() => expect(screen.getByText('29.8.1')).toBeInTheDocument())
    expect(screen.queryByText('Debian GNU/Linux 13 (trixie)')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /detalle/i }))

    expect(
      await screen.findByText('Debian GNU/Linux 13 (trixie)')
    ).toBeInTheDocument()
    expect(screen.getByText('6.12.0')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /cerrar/i }))
    await waitFor(() =>
      expect(screen.queryByText('Debian GNU/Linux 13 (trixie)')).not.toBeInTheDocument()
    )
  })

  it('vuelve a pedir el resumen al pulsar el botón de refresco', async () => {
    const fetchMock = mockOverview()
    render(<SystemSummaryBar />)

    await waitFor(() => expect(screen.getByText('29.8.1')).toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /refrescar/i }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })

  it('no vacía la franja mientras refresca', async () => {
    // Regresión: el refresco ponía `loading` a true y la franja entera se
    // sustituía por "Leyendo el estado del host...", un parpadeo que hace
    // perder de vista las cifras que ya se tenían.
    let liberar: (() => void) | undefined
    const espera = new Promise<void>((resolve) => {
      liberar = resolve
    })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => overview })
      .mockImplementationOnce(async () => {
        await espera
        return { ok: true, status: 200, json: async () => overview }
      })
    vi.stubGlobal('fetch', fetchMock)

    render(<SystemSummaryBar />)
    await waitFor(() => expect(screen.getByText('29.8.1')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /refrescar/i }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    // La cifra sigue en pantalla mientras la petición está en vuelo
    expect(screen.getByText('29.8.1')).toBeInTheDocument()
    expect(screen.queryByText(/leyendo el estado del host/i)).not.toBeInTheDocument()

    liberar?.()
    await waitFor(() =>
      expect(screen.queryByText(/formato inesperado|no disponible/i)).not.toBeInTheDocument()
    )
  })

  it('ofrece el botón de refresco también cuando el daemon no responde', async () => {
    // Regresión: la rama de error no tenía ningún botón, así que un fallo de
    // red al cargar dejaba la franja bloqueada hasta recargar la página a mano.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ detail: 'no disponible' }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => overview })
    vi.stubGlobal('fetch', fetchMock)

    render(<SystemSummaryBar />)

    await waitFor(() => expect(screen.getByText(/no disponible/)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /refrescar/i }))

    // El reintento funciona y la franja sale del estado de error
    expect(await screen.findByText('29.8.1')).toBeInTheDocument()
    expect(screen.queryByText(/no disponible/)).not.toBeInTheDocument()
  })

  it('pide el resumen una sola vez aunque se abra y cierre el detalle', async () => {
    // El panel recibía el resumen por hook propio, así que montarlo disparaba una
    // segunda llamada idéntica al daemon.
    const fetchMock = mockOverview()
    render(<SystemSummaryBar />)

    await waitFor(() => expect(screen.getByText('29.8.1')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /detalle/i }))
    expect(await screen.findByText('6.12.0')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /cerrar/i }))
    await waitFor(() => expect(screen.queryByText('6.12.0')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /detalle/i }))
    expect(await screen.findByText('6.12.0')).toBeInTheDocument()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('no revienta si el daemon devuelve una forma inesperada', async () => {
    // Regresion: un `[]` con status 200 es truthy, y sin validacion el acceso a
    // `info.server_version` reventaba el arbol de React entero.
    mockOverview([])
    render(<SystemSummaryBar />)

    await waitFor(() => expect(screen.getByText(/formato inesperado/i)).toBeInTheDocument())
    expect(screen.getByTestId('system-summary')).toBeInTheDocument()
  })

  it('no revienta si el payload viene sin bloques info/usage', async () => {
    mockOverview({ top_images: [], top_volumes: [] })
    render(<SystemSummaryBar />)

    await waitFor(() => expect(screen.getByText(/formato inesperado/i)).toBeInTheDocument())
  })

  it('no rompe la vista si el daemon falla', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ detail: 'no disponible' }) })
    )
    render(<SystemSummaryBar />)

    // La franja se mantiene legible aunque el daemon no responda
    await waitFor(() => expect(screen.getByText(/no disponible/)).toBeInTheDocument())
    expect(screen.getByTestId('system-summary')).toBeInTheDocument()
  })
})
