import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
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

describe('SystemDetailPanel', () => {  beforeEach(() => vi.restoreAllMocks())

  it('desglosa el uso por tipo de recurso', () => {
    render(<SystemDetailPanel overview={overview} />)

    const bloques = within(screen.getByTestId('usage-blocks'))
    expect(bloques.getByText('Imágenes')).toBeInTheDocument()
    expect(bloques.getByText('Contenedores')).toBeInTheDocument()
    expect(bloques.getByText('Volúmenes')).toBeInTheDocument()
    // El desglose acompaña a cada etiqueta
    expect(bloques.getByText(/4 en total · 2 en uso/)).toBeInTheDocument()
  })

  it('separa las capas compartidas del total de imágenes', () => {
    // `layers_size` son capas compartidas: sumarlas al total de imágenes
    // contaría el mismo espacio dos veces.
    render(<SystemDetailPanel overview={overview} />)

    expect(screen.getByTestId('layers-size')).toHaveTextContent('1.0 GB')
  })

  it('lista los mayores consumidores en orden', () => {
    render(<SystemDetailPanel overview={overview} />)

    expect(screen.getByText('tmp/builder-leftover:latest')).toBeInTheDocument()
    const elementos = screen.getAllByTestId('top-consumer')
    expect(elementos[0]).toHaveTextContent('tmp/builder-leftover:latest')
    expect(elementos[1]).toHaveTextContent('postgres:16-alpine')
  })

  it('indica cuando no hay informacion de consumo que mostrar', () => {
    render(<SystemDetailPanel overview={{ ...overview, top_images: [], top_volumes: [] }} />)

    // El panel no repite la versión (ya está en la franja); se identifica por el host
    expect(screen.getByText('dockpilot-test')).toBeInTheDocument()
    expect(screen.getByText(/sin datos de consumo/i)).toBeInTheDocument()
  })

  it('muestra el porcentaje recuperable de cada tipo sobre su propio total', () => {
    render(<SystemDetailPanel overview={overview} />)

    // 1 GiB de 2 GiB, 512 KiB de 1 MiB, 53747987 de 53747987
    expect(within(screen.getByTestId('usage-images')).getByText('50.0%')).toBeInTheDocument()
    expect(within(screen.getByTestId('usage-containers')).getByText('50.0%')).toBeInTheDocument()
    expect(within(screen.getByTestId('usage-volumes')).getByText('100.0%')).toBeInTheDocument()
  })

  it('trata un total cero como cero por ciento en vez de dividir entre cero', () => {
    // Regresión: `reclaimable / total_size` con `total_size = 0` es Infinity o
    // NaN, y eso se renderiza literally en la pantalla.
    render(
      <SystemDetailPanel
        overview={{
          ...overview,
          usage: {
            ...overview.usage,
            images: { total_count: 0, active_count: 0, total_size: 0, reclaimable: 0 },
          },
        }}
      />
    )

    const imagenes = within(screen.getByTestId('usage-images'))
    expect(imagenes.getByText('0.0%')).toBeInTheDocument()
    expect(imagenes.queryByText(/Infinity|NaN/)).not.toBeInTheDocument()
  })

  it('enlaza la cifra recuperable de imágenes a la vista de imágenes', () => {
    const onNavigateTab = vi.fn()
    render(<SystemDetailPanel overview={overview} onNavigateTab={onNavigateTab} />)

    fireEvent.click(
      within(screen.getByTestId('usage-images')).getByRole('button', { name: /imágenes/i })
    )

    expect(onNavigateTab).toHaveBeenCalledWith('images')
  })

  it('enlaza la cifra recuperable de volúmenes a la vista de volúmenes', () => {
    const onNavigateTab = vi.fn()
    render(<SystemDetailPanel overview={overview} onNavigateTab={onNavigateTab} />)

    fireEvent.click(
      within(screen.getByTestId('usage-volumes')).getByRole('button', { name: /volúmenes/i })
    )

    expect(onNavigateTab).toHaveBeenCalledWith('volumes')
  })

  it('no enliza los contenedores porque no hay una vista que los recicle', () => {
    // SPEC-09 solo enlaza a SPEC-07 (imágenes) y SPEC-08 (volúmenes): una
    // limpieza de contenedores no existe en el panel.
    render(<SystemDetailPanel overview={overview} onNavigateTab={vi.fn()} />)

    expect(
      within(screen.getByTestId('usage-containers')).queryByRole('button')
    ).not.toBeInTheDocument()
  })

  it('sigue mostrando el desglose aunque no se sepa navegar', () => {
    // El panel se monta también en tests yStorybook donde no hay navegación:
    // sin `onNavigateTab` las cifras se muestran como texto plano.
    render(<SystemDetailPanel overview={overview} />)

    const imagenes = within(screen.getByTestId('usage-images'))
    expect(imagenes.getByText(/1\.0 GB recuperables/)).toBeInTheDocument()
    expect(imagenes.queryByRole('button')).not.toBeInTheDocument()
  })
})
