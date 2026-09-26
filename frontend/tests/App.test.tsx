import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import App from '../src/App'
import { ThemeProvider } from '../src/components/layout/ThemeProvider'

class MockWebSocket {
  static instances: MockWebSocket[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn()

  constructor(url: string) {
    MockWebSocket.instances.push(this)
    void url
  }
}

class MockMediaQueryList {
  media: string
  matches = false
  constructor(media: string) {
    this.media = media
  }
  addEventListener() {}
  removeEventListener() {}
}

const containers = [
  {
    id: 'c123',
    name: 'web-app',
    image: 'nginx:alpine',
    status: 'running',
    state: 'Up 2 hours',
    created: 1727290000,
    ports: [],
  },
]

const images = [
  {
    id: 'sha256:img1',
    tags: ['nginx:alpine'],
    size: 25000000,
    created: 1727290000,
    containers: 1,
    repo_digests: [],
  },
]

const systemOverview = {
  info: {
    server_version: '29.8.1', os_name: 'Debian', os_type: 'linux', architecture: 'x86_64',
    kernel_version: '6.12.0', hostname: 'test', ncpu: 12, memory_total: 32827215872,
    storage_driver: 'overlayfs', docker_root_dir: '/var/lib/docker', containers_total: 1,
    containers_running: 1, containers_stopped: 0, containers_paused: 0, images_total: 1,
  },
  usage: {
    layers_size: 0,
    images: { total_count: 1, active_count: 1, total_size: 25000000, reclaimable: 0 },
    containers: { total_count: 1, active_count: 1, total_size: 0, reclaimable: 0 },
    volumes: { total_count: 0, active_count: 0, total_size: 0, reclaimable: 0 },
    build_cache_size: 0,
  },
  top_images: [],
  top_volumes: [],
}

const stubFetch = () => {
  const fetchMock = vi.fn(async (url: string) => {
    const body = String(url).includes('/images/local')
      ? images
      : String(url).includes('/containers')
        ? containers
        : String(url).includes('/system/overview')
          ? systemOverview
          : []
    return { ok: true, status: 200, json: async () => body } as unknown as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('App · conmutador de vista', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    stubFetch()
    // @ts-expect-error Mocking WebSocket
    global.WebSocket = MockWebSocket
    vi.stubGlobal('matchMedia', (query: string) => new MockMediaQueryList(query))
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('acota la franja de resumen al mismo ancho que el contenido', async () => {
    render(
      <ThemeProvider>
        <App />
      </ThemeProvider>
    )

    // La barra y el contenido deben compartir la columna centrada; si la barra
    // queda fuera, ocupa todo el ancho de la pagina y desentona.
    const barra = await screen.findByTestId('system-summary')
    const contenedor = barra.parentElement as HTMLElement
    const main = document.querySelector('main') as HTMLElement

    for (const clase of ['max-w-7xl', 'mx-auto', 'w-full']) {
      expect(contenedor.className).toContain(clase)
      expect(main.className).toContain(clase)
    }
  })

  it('muestra los filtros y el buscador en la pestaña de contenedores', async () => {
    render(
      <ThemeProvider>
        <App />
      </ThemeProvider>
    )

    await waitFor(() => expect(screen.getByText('web-app')).toBeInTheDocument())

    expect(screen.getByRole('button', { name: /Todos/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Activos/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Detenidos/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Pausados/ })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Buscar por nombre, imagen o ID...')).toBeInTheDocument()
  })

  it('oculta los filtros de contenedores al cambiar a la pestaña de imágenes', async () => {
    render(
      <ThemeProvider>
        <App />
      </ThemeProvider>
    )
    await waitFor(() => expect(screen.getByText('web-app')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Imágenes' }))

    await waitFor(() => expect(screen.getByText('nginx:alpine')).toBeInTheDocument())

    // Los filtros por estado son de contenedores: no deben aparecer aquí
    expect(screen.queryByRole('button', { name: /Activos/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Detenidos/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Pausados/ })).not.toBeInTheDocument()
    // Tampoco el buscador, que filtra por nombre/imagen/ID de contenedor
    expect(
      screen.queryByPlaceholderText('Buscar por nombre, imagen o ID...')
    ).not.toBeInTheDocument()
  })

  it('recupera los filtros al volver a la pestaña de contenedores', async () => {
    render(
      <ThemeProvider>
        <App />
      </ThemeProvider>
    )
    await waitFor(() => expect(screen.getByText('web-app')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Imágenes' }))
    await waitFor(() => expect(screen.getByText('nginx:alpine')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Contenedores' }))

    await waitFor(() => expect(screen.getByText('web-app')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Activos/ })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Buscar por nombre, imagen o ID...')).toBeInTheDocument()
  })
})
