import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ImageDetailModal } from '../../src/components/images/ImageDetailModal'
import type { ImageDetail } from '../../src/types/image'

const detail: ImageDetail = {
  id: 'sha256:img1',
  tags: ['nginx:alpine', 'nginx:latest'],
  repo_digests: ['nginx@sha256:aaa1'],
  size: 25000000,
  created: 1727290000,
  architecture: 'amd64',
  os: 'linux',
  entrypoint: ['/docker-entrypoint.sh'],
  cmd: ['nginx', '-g', 'daemon off;'],
  env: ['PATH=/usr/local/sbin', 'NGINX_VERSION=1.27'],
  exposed_ports: { '80/tcp': {}, '443/tcp': {} },
  working_dir: '/usr/share/nginx',
  user: 'nginx',
  labels: { maintainer: 'NGINX' },
  layer_count: 3,
  history: [
    {
      id: 'l3',
      created: 1727290000,
      created_by: 'CMD ["nginx"]',
      size: 1200,
      comment: '',
      tags: null,
    },
    {
      id: 'l2',
      created: 1727289000,
      created_by: 'RUN apk add --no-cache nginx',
      size: 24000000,
      comment: 'instalación',
      tags: null,
    },
  ],
}

const mockFetch = (payload: unknown, ok = true) => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => payload,
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('ImageDetailModal', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('no renderiza sin imageId', () => {
    render(<ImageDetailModal imageId={null} onClose={vi.fn()} />)

    expect(screen.queryByText('Detalle de la imagen')).not.toBeInTheDocument()
  })

  it('muestra los metadatos de la imagen', async () => {
    mockFetch(detail)
    render(<ImageDetailModal imageId="nginx:alpine" onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('nginx:alpine')).toBeInTheDocument())

    expect(screen.getByText('Detalle de la imagen')).toBeInTheDocument()
    expect(screen.getByText('amd64')).toBeInTheDocument()
    expect(screen.getByText('linux')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument() // layer_count
    expect(screen.getByText('23.8 MB')).toBeInTheDocument()
  })

  it('muestra el bloque de configuración', async () => {
    mockFetch(detail)
    render(<ImageDetailModal imageId="nginx:alpine" onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Configuración')).toBeInTheDocument())

    expect(screen.getByText('/docker-entrypoint.sh')).toBeInTheDocument()
    expect(screen.getByText('NGINX_VERSION=1.27')).toBeInTheDocument()
    expect(screen.getByText('80/tcp')).toBeInTheDocument()
    expect(screen.getByText('/usr/share/nginx')).toBeInTheDocument()
  })

  it('lista el historial de construcción con su instrucción y tamaño', async () => {
    mockFetch(detail)
    render(<ImageDetailModal imageId="nginx:alpine" onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Historial')).toBeInTheDocument())

    expect(screen.getByText('RUN apk add --no-cache nginx')).toBeInTheDocument()
    expect(screen.getByText('22.9 MB')).toBeInTheDocument()
    expect(screen.getAllByText('l3')).toHaveLength(1)
  })

  it('muestra el error si la API falla', async () => {
    mockFetch({ detail: 'Imagen no encontrada' }, false)
    render(<ImageDetailModal imageId="no-existe" onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Imagen no encontrada')).toBeInTheDocument())
  })

  it('cierra con el botón y con Escape', async () => {
    mockFetch(detail)
    const onClose = vi.fn()
    const { rerender } = render(<ImageDetailModal imageId="nginx:alpine" onClose={onClose} />)

    await waitFor(() => expect(screen.getByText('Detalle de la imagen')).toBeInTheDocument())

    fireEvent.click(screen.getByTitle('Cerrar detalle de la imagen'))
    expect(onClose).toHaveBeenCalledTimes(1)

    rerender(<ImageDetailModal imageId="nginx:alpine" onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
