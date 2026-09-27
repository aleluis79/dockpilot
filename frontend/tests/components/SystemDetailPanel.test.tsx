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

describe('SystemDetailPanel', () => {
  beforeEach(() => vi.restoreAllMocks())

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
    // `ConsumerBars` normaliza contra el mayor y ordena de mayor a menor, así que
    // el primero tiene la barra llena.
    const elementos = screen.getAllByTestId(/^consumer-fila-/)
    expect(elementos[0]).toHaveTextContent('tmp/builder-leftover:latest')
    expect(elementos[0].querySelector('[data-testid^="consumer-barra-"]')).toHaveStyle({ width: '100%' })
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

/**
 * Host con cifras distintas del de arriba a propósito: 5 contenedores y 6 GB de
 * imágenes permiten comprobar proportions que el otro fixture no cubre.
 */
const resumen: SystemOverview = {
  info: {
    server_version: '29.8.1',
    os_name: 'Debian',
    os_type: 'linux',
    architecture: 'x86_64',
    kernel_version: '6.12.0',
    hostname: 'host',
    ncpu: 12,
    memory_total: 32_827_215_872,
    storage_driver: 'overlayfs',
    docker_root_dir: '/var/lib/docker',
    containers_total: 5,
    containers_running: 3,
    containers_stopped: 1,
    containers_paused: 1,
    images_total: 8,
  },
  usage: {
    layers_size: 4_000_000_000,
    build_cache_size: 1_000_000_000,
    images: { total_count: 8, active_count: 3, total_size: 6_000_000_000, reclaimable: 2_000_000_000 },
    containers: { total_count: 5, active_count: 3, total_size: 500_000_000, reclaimable: 0 },
    volumes: { total_count: 4, active_count: 2, total_size: 300_000_000, reclaimable: 300_000_000 },
  },
  top_images: [
    { kind: 'image', name: 'elasticsearch:9.1.3', size: 3_000_000_000, detail: '1.1 GB' },
    { kind: 'image', name: 'alpine:3.20', size: 500_000, detail: '8.0 MB' },
  ],
  top_volumes: [
    { kind: 'volume', name: 'elasticsearch_data', size: 1_200_000_000, detail: '' },
    { kind: 'volume', name: 'cache', size: 100_000, detail: '' },
  ],
}

describe('SystemDetailPanel · resumen visual', () => {
  it('muestra los estados de los contenedores en una barra', () => {
    render(<SystemDetailPanel overview={resumen} />)

    const grafica = screen.getByRole('img', { name: /estados de los contenedores/i })
    // El desglose viene de `/info` y no pide nada nuevo al backend.
    expect(grafica.getAttribute('aria-label')).toContain('3')
    expect(grafica.getAttribute('aria-label')).toContain('1')
  })

  it('los tramos de estado suman el total de contenedores', () => {
    render(<SystemDetailPanel overview={resumen} />)

    const seccion = screen.getByTestId('chart-estados')
    const corriendo = within(seccion).getByTestId('stacked-tramo-Corriendo')
    // 3 corriendo de 5 en total.
    expect(corriendo).toHaveStyle({ width: '60%' })
  })

  it('reparte el disco por categoría', () => {
    render(<SystemDetailPanel overview={resumen} />)

    const seccion = screen.getByTestId('chart-disco')
    // 6 GB de imágenes contra 11,8 GB de total: la mayor categoría, y por el
    // orden de mayor a menor tiene que ir la primera.
    const primero = within(seccion).getAllByTestId(/^stacked-leyenda-/)[0]
    expect(primero).toHaveTextContent('Imágenes')
  })

  it('distingue lo ocupado de lo recuperable', () => {
    render(<SystemDetailPanel overview={resumen} />)

    // Es la cifra accionable de la spec: las imágenes tienen casi 2 GB liberables.
    // `formatBytes` usa unidades binarias, así que 2.000.000.000 son 1,9 GB.
    expect(screen.getByTestId('chart-disco')).toHaveTextContent(/1\.9 GB/)
    expect(screen.getByTestId('chart-disco')).toHaveTextContent(/recuperable/i)
  })

  it('los mayores consumidores salen como barras', () => {
    render(<SystemDetailPanel overview={resumen} />)

    const imagenes = screen.getByTestId('chart-top-images')
    const barras = within(imagenes).getAllByTestId(/^consumer-barra-/)
    expect(barras.length).toBe(2)
    // La mayor ocupa el ancho completo.
    expect(barras[0]).toHaveStyle({ width: '100%' })
  })

  it('sin contenedores en el host lo dice en vez de dibujar una barra vacía', () => {
    render(
      <SystemDetailPanel
        overview={{
          ...resumen,
          info: {
            ...resumen.info,
            containers_total: 0,
            containers_running: 0,
            containers_stopped: 0,
            containers_paused: 0,
          },
        }}
      />
    )

    // El mensaje dice qué falta, que es más útil que un "sin datos" genérico.
    expect(
      within(screen.getByTestId('chart-estados')).getByText(/sin contenedores/i)
    ).toBeInTheDocument()
    expect(within(screen.getByTestId('chart-estados')).queryByTestId('stacked-barra')).toBeNull()
  })

  it('mantiene el enlace a la vista de la que se puede limpiar', () => {
    const onNavigateTab = vi.fn()
    render(<SystemDetailPanel overview={resumen} onNavigateTab={onNavigateTab} />)

    // Las gráficas no ejecutan nada: siguen llevando a la vista que ya lo hace.
    const enlace = screen.getAllByRole('button', { name: /ir a la vista de imágenes/i })[0]
    expect(enlace).toBeInTheDocument()
  })

  it('no pinta colores literales en las gráficas', () => {
    const { container } = render(<SystemDetailPanel overview={resumen} />)

    // Si un color se escribiera a mano, no seguiría al tema. El guard de tokens
    // lo caza en el código, y esto lo confirma en el DOM renderizado.
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,6}/i)
  })
})
})
