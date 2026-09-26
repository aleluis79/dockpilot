import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { SystemDetailPanel } from '../../src/components/system/SystemDetailPanel'
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
  return vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => datos })
  )
}

describe('SystemDetailPanel', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('desglosa el uso por tipo de recurso', async () => {
    mockOverview()
    render(<SystemDetailPanel />)

    await waitFor(() => expect(screen.getByTestId('usage-blocks')).toBeInTheDocument())
    const bloques = within(screen.getByTestId('usage-blocks'))
    expect(bloques.getByText('Imágenes')).toBeInTheDocument()
    expect(bloques.getByText('Contenedores')).toBeInTheDocument()
    expect(bloques.getByText('Volúmenes')).toBeInTheDocument()
    // El desglose acompaña a cada etiqueta
    expect(bloques.getByText(/4 en total · 2 en uso/)).toBeInTheDocument()
  })

  it('separa las capas compartidas del total de imágenes', async () => {
    // `layers_size` son capas compartidas: sumarlas al total de imágenes
    // contaría el mismo espacio dos veces.
    mockOverview()
    render(<SystemDetailPanel />)

    await waitFor(() => expect(screen.getByTestId('layers-size')).toBeInTheDocument())
    expect(screen.getByTestId('layers-size')).toHaveTextContent('1.0 GB')
  })

  it('lista los mayores consumidores en orden', async () => {
    mockOverview()
    render(<SystemDetailPanel />)

    await waitFor(() => expect(screen.getByText('tmp/builder-leftover:latest')).toBeInTheDocument())
    const elementos = screen.getAllByTestId('top-consumer')
    expect(elementos[0]).toHaveTextContent('tmp/builder-leftover:latest')
    expect(elementos[1]).toHaveTextContent('postgres:16-alpine')
  })

  it('indica cuando no hay informacion de consumo que mostrar', async () => {
    mockOverview({ ...overview, top_images: [], top_volumes: [] })
    render(<SystemDetailPanel />)

    // El panel no repite la versión (ya está en la franja); se identifica por el host
    await waitFor(() => expect(screen.getByText('dockpilot-test')).toBeInTheDocument())
    expect(screen.getByText(/sin datos de consumo/i)).toBeInTheDocument()
  })
})
