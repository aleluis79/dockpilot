import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { PullImageModal } from '../../src/components/images/PullImageModal'
import { isValidImageRef } from '../../src/services/dockerApi'
import type { ImagePullMessage, LocalImageSummary } from '../../src/types/image'

class MockWebSocket {
  static instances: MockWebSocket[] = []

  url: string
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn()

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  emit(message: ImagePullMessage) {
    act(() => {
      this.onmessage?.({ data: JSON.stringify(message) })
    })
  }
}

const latest = () => MockWebSocket.instances[MockWebSocket.instances.length - 1]

const searchResults = [
  { name: 'nginx', description: 'Official build of Nginx.', is_official: true, star_count: 21391 },
  { name: 'nginxinc/nginx-unprivileged', description: 'Unprivileged NGINX.', is_official: false, star_count: 900 },
]

const localImage: LocalImageSummary = {
  id: 'sha256:img1',
  tags: ['nginx:latest'],
  size: 1000,
  created: 1,
  containers: 0,
  repo_digests: [],
}

const mockSearch = (results = searchResults, ok = true) => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => (ok ? results : { detail: 'Error al buscar en Docker Hub' }),
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const typeReference = (value: string) =>
  fireEvent.change(screen.getByLabelText('Referencia de imagen'), { target: { value } })

describe('isValidImageRef', () => {
  it('acepta referencias válidas', () => {
    for (const ref of [
      'nginx',
      'nginx:alpine',
      'library/redis:7',
      'ghcr.io/propietario/app:1.2',
      'localhost:5000/mi-app:dev',
      `alpine@sha256:${'a'.repeat(64)}`,
    ]) {
      expect(isValidImageRef(ref), ref).toBe(true)
    }
  })

  it('rechaza referencias inválidas', () => {
    for (const ref of ['', '   ', 'nginx alpine', 'nginx@md5:abc', '-nginx', 'a'.repeat(300)]) {
      expect(isValidImageRef(ref), ref).toBe(false)
    }
  })

  it('rechaza el path traversal', () => {
    expect(isValidImageRef('nginx/alpine/../etc')).toBe(false)
  })
})

describe('PullImageModal', () => {
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

  const open = (localImages: LocalImageSummary[] = []) =>
    render(
      <PullImageModal
        isOpen
        onClose={vi.fn()}
        onPulled={vi.fn()}
        localImages={localImages}
      />
    )

  it('no renderiza cuando isOpen es false', () => {
    render(<PullImageModal isOpen={false} onClose={vi.fn()} onPulled={vi.fn()} />)

    expect(screen.queryByText('Descargar imagen')).not.toBeInTheDocument()
  })

  it('escribir una referencia NO abre ninguna descarga', () => {
    open()

    // 'a' ya es una referencia válida: este es el bug que motivó el cambio
    for (const partial of ['a', 'al', 'ali', 'alpin', 'alpine']) {
      typeReference(partial)
      expect(MockWebSocket.instances).toHaveLength(0)
    }
  })

  it('el botón Buscar está deshabilitado con el texto vacío o inválido', () => {
    open()
    const searchBtn = screen.getByRole('button', { name: 'Buscar' })

    expect(searchBtn).toBeDisabled()

    typeReference('nginx alpine')
    expect(screen.getByRole('button', { name: 'Buscar' })).toBeDisabled()
    expect(screen.getByText(/Formato esperado/)).toBeInTheDocument()

    typeReference('nginx')
    expect(screen.getByRole('button', { name: 'Buscar' })).toBeEnabled()
  })

  it('Buscar consulta el endpoint de búsqueda y lista las alternativas', async () => {
    const fetchMock = mockSearch()
    open()

    typeReference('nginx')
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(String(fetchMock.mock.calls[0][0])).toContain('term=nginx')

    await waitFor(() => expect(screen.getByText('Official build of Nginx.')).toBeInTheDocument())
    expect(screen.getByText('nginx')).toBeInTheDocument()
    expect(screen.getByText('Unprivileged NGINX.')).toBeInTheDocument()
    // La búsqueda no debe haber descargado nada todavía
    expect(MockWebSocket.instances).toHaveLength(0)
  })

  it('señala las alternativas que ya están en local', async () => {
    mockSearch()
    open([localImage])

    typeReference('nginx')
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }))

    await waitFor(() => expect(screen.getByText('En local')).toBeInTheDocument())
    expect(screen.queryAllByText('En local')).toHaveLength(1)
  })

  it('elegir una alternativa inicia la descarga con la referencia normalizada', async () => {
    mockSearch()
    open()

    typeReference('nginx')
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }))
    await waitFor(() => expect(screen.getByText('Official build of Nginx.')).toBeInTheDocument())

    fireEvent.click(screen.getByTitle('Descargar nginx'))

    expect(MockWebSocket.instances).toHaveLength(1)
    expect(decodeURIComponent(latest().url)).toContain('image=nginx:latest')
  })

  it('permite confirmar la referencia escrita tal cual', async () => {
    mockSearch()
    open()

    typeReference('nginx:1.27-alpine')
    fireEvent.click(screen.getByTitle('Descargar la referencia escrita'))

    expect(MockWebSocket.instances).toHaveLength(1)
    expect(decodeURIComponent(latest().url)).toContain('image=nginx:1.27-alpine')
  })

  it('editar el texto cancela la descarga en curso y vuelve a la fase de búsqueda', async () => {
    mockSearch()
    open()

    typeReference('nginx')
    fireEvent.click(screen.getByTitle('Descargar la referencia escrita'))
    const socket = latest()
    expect(MockWebSocket.instances).toHaveLength(1)

    latest().emit({ type: 'layer', image: 'nginx:latest', id: 'l1', status: 'Pulling fs layer' })
    expect(screen.getByText('l1')).toBeInTheDocument()

    typeReference('alpine')

    expect(socket.close).toHaveBeenCalled()
    // Vuelve a la fase de búsqueda: sin progreso, y con el botón de
    // confirmar la referencia escrita de nuevo disponible
    expect(screen.queryByText('l1')).not.toBeInTheDocument()
    expect(screen.getByTitle('Descargar la referencia escrita')).toBeInTheDocument()
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('pulsar Buscar de nuevo cancela la descarga en curso', async () => {
    mockSearch()
    open()

    typeReference('nginx')
    fireEvent.click(screen.getByTitle('Descargar la referencia escrita'))
    const socket = latest()

    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }))

    expect(socket.close).toHaveBeenCalled()
  })

  it('muestra una barra por capa y el progreso en bytes', async () => {
    mockSearch()
    open()

    typeReference('alpine')
    fireEvent.click(screen.getByTitle('Descargar la referencia escrita'))

    latest().emit({ type: 'layer', image: 'alpine:latest', id: 'l1', status: 'Pulling fs layer' })
    latest().emit({
      type: 'layer',
      image: 'alpine:latest',
      id: 'l1',
      status: 'Downloading',
      current: 512,
      total: 2048,
    })

    expect(screen.getByText('l1')).toBeInTheDocument()
    expect(screen.getByText('512 B / 2.0 KB')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Progreso de la capa l1' })).toHaveAttribute(
      'aria-valuenow',
      '25'
    )
  })

  it('no muestra NaN cuando el daemon no informa del total', async () => {
    mockSearch()
    open()

    typeReference('alpine')
    fireEvent.click(screen.getByTitle('Descargar la referencia escrita'))

    latest().emit({ type: 'layer', image: 'alpine:latest', id: 'l1', status: 'Pulling fs layer' })
    latest().emit({ type: 'layer', image: 'alpine:latest', id: 'l1', status: 'Pull complete' })

    expect(document.body.textContent).not.toContain('NaN')
  })

  it('muestra el error devuelto por el backend', async () => {
    mockSearch()
    open()

    typeReference('no-existe')
    fireEvent.click(screen.getByTitle('Descargar la referencia escrita'))

    latest().emit({
      type: 'error',
      image: 'no-existe:latest',
      code: 404,
      message: 'pull access denied for no-existe',
    })

    expect(screen.getByText('pull access denied for no-existe')).toBeInTheDocument()
  })

  it('muestra el error si la propia búsqueda falla', async () => {
    mockSearch([], false)
    open()

    typeReference('nginx')
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }))

    await waitFor(() =>
      expect(screen.getByText('Error al buscar en Docker Hub')).toBeInTheDocument()
    )
  })

  it('tras completar la descarga el botón ofrece cerrar, no cancelar', async () => {
    mockSearch()
    open()

    typeReference('alpine')
    fireEvent.click(screen.getByTitle('Descargar la referencia escrita'))

    // Mientras la descarga está en curso, cancelar sí tiene sentido
    expect(screen.getByTestId('pull-modal-primary-action')).toHaveTextContent('Cancelar')

    latest().emit({ type: 'digest', image: 'alpine:latest', digest: 'sha256:abc' })
    latest().emit({ type: 'done', image: 'alpine:latest', id: 'l1', tags: ['alpine:latest'] })

    // Ya no hay nada que cancelar: debe ofrecer cerrar
    expect(screen.getByTestId('pull-modal-primary-action')).toHaveTextContent('Cerrar')
  })

  it('el botón de acción principal cierra el modal', () => {
    mockSearch()
    const onClose = vi.fn()
    render(<PullImageModal isOpen onClose={onClose} onPulled={vi.fn()} />)

    typeReference('alpine')
    fireEvent.click(screen.getByTitle('Descargar la referencia escrita'))
    latest().emit({ type: 'done', image: 'alpine:latest', id: 'l1', tags: ['alpine:latest'] })

    fireEvent.click(screen.getByTestId('pull-modal-primary-action'))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('avisa a la vista padre cuando la descarga termina', async () => {
    mockSearch()
    const onPulled = vi.fn()
    render(<PullImageModal isOpen onClose={vi.fn()} onPulled={onPulled} />)

    typeReference('alpine')
    fireEvent.click(screen.getByTitle('Descargar la referencia escrita'))

    latest().emit({ type: 'digest', image: 'alpine:latest', digest: 'sha256:abc' })
    latest().emit({ type: 'done', image: 'alpine:latest', id: 'l1', tags: ['alpine:latest'] })

    await waitFor(() => expect(onPulled).toHaveBeenCalledWith(['alpine:latest']))
  })

  it('cierra con el botón y con la tecla Escape', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <PullImageModal isOpen onClose={onClose} onPulled={vi.fn()} />
    )

    fireEvent.click(screen.getByTitle('Cerrar descarga de imagen'))
    expect(onClose).toHaveBeenCalledTimes(1)

    rerender(<PullImageModal isOpen onClose={onClose} onPulled={vi.fn()} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
