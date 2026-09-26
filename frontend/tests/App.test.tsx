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

const stubFetch = () => {
  const fetchMock = vi.fn(async (url: string) => {
    const body = String(url).includes('/images/local')
      ? images
      : String(url).includes('/containers')
        ? containers
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
