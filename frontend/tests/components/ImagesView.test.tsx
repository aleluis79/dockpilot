import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ImagesView } from '../../src/components/images/ImagesView'
import type { LocalImageSummary } from '../../src/types/image'

const nginx: LocalImageSummary = {
  id: 'sha256:img1',
  tags: ['nginx:alpine', 'nginx:latest'],
  size: 25000000,
  created: 1727290000,
  containers: 0,
  repo_digests: [],
}

const redis: LocalImageSummary = {
  id: 'sha256:img2',
  tags: ['redis:alpine'],
  size: 35000000,
  created: 1727280000,
  containers: 1,
  repo_digests: [],
}

const postgres: LocalImageSummary = {
  id: 'sha256:img3',
  tags: ['postgres:16-alpine'],
  size: 40000000,
  created: 1727270000,
  containers: 0,
  repo_digests: [],
}

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

const stubImages = (images: LocalImageSummary[]) => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => images,
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const ALL = [nginx, redis, postgres]

describe('ImagesView · buscador', () => {
  const originalWebSocket = global.WebSocket

  beforeEach(() => {
    MockWebSocket.instances = []
    // @ts-expect-error Mocking WebSocket
    global.WebSocket = MockWebSocket
  })

  afterEach(() => {
    global.WebSocket = originalWebSocket
    vi.unstubAllGlobals()
  })

  const renderView = (images: LocalImageSummary[] = ALL) => {
    stubImages(images)
    return render(<ImagesView onRunImage={vi.fn()} onDeleted={vi.fn()} />)
  }

  const search = (value: string) =>
    fireEvent.change(screen.getByLabelText('Buscar imágenes'), { target: { value } })

  it('filtra por tag sin distinguir mayúsculas', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('nginx:alpine')).toBeInTheDocument())

    search('NGIN')

    expect(screen.getByText('nginx:alpine')).toBeInTheDocument()
    expect(screen.getByText('nginx:latest')).toBeInTheDocument()
    expect(screen.queryByText('redis:alpine')).not.toBeInTheDocument()
    expect(screen.queryByText('postgres:16-alpine')).not.toBeInTheDocument()
  })

  it('filtra por cualquier tag, no solo por el principal', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('nginx:alpine')).toBeInTheDocument())

    // "nginx:latest" es el tag secundario de la primera imagen
    search('latest')

    expect(screen.getByText('nginx:alpine')).toBeInTheDocument()
    expect(screen.queryByText('redis:alpine')).not.toBeInTheDocument()
  })

  it('filtra por ID de imagen', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('nginx:alpine')).toBeInTheDocument())

    search('img2')

    expect(screen.getByText('redis:alpine')).toBeInTheDocument()
    expect(screen.queryByText('nginx:alpine')).not.toBeInTheDocument()
  })

  it('el contador muestra las coincidencias sobre el total', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('nginx:alpine')).toBeInTheDocument())

    // Sin búsqueda, el contador es el total simple
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.queryByText(/de 3/)).not.toBeInTheDocument()

    search('redis')
    expect(screen.getByText('1 de 3')).toBeInTheDocument()

    // Las tres contienen "alpine" en algún tag
    search('alpine')
    expect(screen.getByText('3 de 3')).toBeInTheDocument()
  })

  it('muestra un estado de sin coincidencias distinto del host vacío', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('nginx:alpine')).toBeInTheDocument())

    search('no-existe-esta-imagen')

    expect(screen.getByText(/Ninguna imagen coincide/)).toBeInTheDocument()
    expect(screen.queryByText('No hay imágenes locales')).not.toBeInTheDocument()
  })

  it('el host vacío sigue mostrando su propio mensaje', async () => {
    renderView([])
    await waitFor(() => expect(screen.getByText('No hay imágenes locales')).toBeInTheDocument())

    // Sin imágenes, el buscador no debe inventar un estado de "sin coincidencias"
    expect(screen.queryByText(/Ninguna imagen coincide/)).not.toBeInTheDocument()
  })

  it('al borrar el texto se restaura el inventario completo', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('nginx:alpine')).toBeInTheDocument())

    search('redis')
    expect(screen.queryByText('nginx:alpine')).not.toBeInTheDocument()

    search('')

    expect(screen.getByText('nginx:alpine')).toBeInTheDocument()
    expect(screen.getByText('redis:alpine')).toBeInTheDocument()
    expect(screen.getByText('postgres:16-alpine')).toBeInTheDocument()
    expect(screen.queryByText(/de 3/)).not.toBeInTheDocument()
  })

  it('las acciones de la tabla siguen funcionando con el filtro activo', async () => {
    const onRunImage = vi.fn()
    stubImages(ALL)
    render(<ImagesView onRunImage={onRunImage} onDeleted={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('nginx:alpine')).toBeInTheDocument())

    search('redis')
    fireEvent.click(screen.getByTitle('Ejecutar un contenedor con redis:alpine'))

    expect(onRunImage).toHaveBeenCalledWith(redis)
  })
})
