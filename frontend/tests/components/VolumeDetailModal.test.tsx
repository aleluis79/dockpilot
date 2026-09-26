import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { VolumeDetailModal } from '../../src/components/volumes/VolumeDetailModal'
import type { VolumeDetail } from '../../src/types/volume'

const detail: VolumeDetail = {
  name: 'datos-app',
  driver: 'local',
  mountpoint: '/var/lib/docker/volumes/datos-app/_data',
  scope: 'local',
  created_at: '2026-09-20T10:00:00-03:00',
  size: 104857600,
  ref_count: 1,
  is_anonymous: false,
  labels: { app: 'dockpilot', tier: 'backend' },
  options: { type: 'none' },
  containers: ['web-app', 'worker'],
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

describe('VolumeDetailModal', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('no renderiza sin name', () => {
    render(<VolumeDetailModal name={null} onClose={vi.fn()} />)

    expect(screen.queryByText('Detalle del volumen')).not.toBeInTheDocument()
  })

  it('muestra los metadatos del volumen', async () => {
    mockFetch(detail)
    render(<VolumeDetailModal name="datos-app" onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Detalle del volumen')).toBeInTheDocument())

    expect(screen.getByText('datos-app')).toBeInTheDocument()
    expect(screen.getByText('100.0 MB')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument() // ref_count
    // El driver y el ámbito son ambos "local" en el fixture, así que hay dos
    expect(screen.getAllByText('local')).toHaveLength(2)
    expect(screen.getByText('/var/lib/docker/volumes/datos-app/_data')).toBeInTheDocument()
  })

  it('lista los contenedores que usan el volumen', async () => {
    mockFetch(detail)
    render(<VolumeDetailModal name="datos-app" onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Detalle del volumen')).toBeInTheDocument())

    expect(screen.getByText('Contenedores que lo usan')).toBeInTheDocument()
    expect(screen.getByText('web-app')).toBeInTheDocument()
    expect(screen.getByText('worker')).toBeInTheDocument()
  })

  it('muestra las etiquetas del volumen', async () => {
    mockFetch(detail)
    render(<VolumeDetailModal name="datos-app" onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Etiquetas')).toBeInTheDocument())

    expect(screen.getByText('app')).toBeInTheDocument()
    expect(screen.getByText('dockpilot')).toBeInTheDocument()
  })

  it('indica cuándo ningún contenedor lo usa y que se puede eliminar sin forzar', async () => {
    mockFetch({ ...detail, containers: [], ref_count: 0 })
    render(<VolumeDetailModal name="datos-app" onClose={vi.fn()} />)

    await waitFor(() =>
      expect(screen.getByText(/se puede eliminar sin forzar/)).toBeInTheDocument()
    )
    expect(screen.queryByText(/ningún contenedor aparece en el listado/)).not.toBeInTheDocument()
  })

  it('no afirma que se pueda eliminar sin forzar si el daemon dice que está en uso', async () => {
    // Discrepancia real: ref_count > 0 pero ningún contenedor lo monta. El
    // panel no debe sugerir que el borrado será trivial, porque dará 409.
    mockFetch({ ...detail, containers: [], ref_count: 1 })
    render(<VolumeDetailModal name="datos-app" onClose={vi.fn()} />)

    await waitFor(() =>
      expect(screen.getByText(/ningún contenedor aparece en el listado/)).toBeInTheDocument()
    )
    expect(screen.queryByText(/se puede eliminar sin forzar/)).not.toBeInTheDocument()
  })

  it('advierte de que habrá que forzar el borrado en esa discrepancia', async () => {
    mockFetch({ ...detail, containers: [], ref_count: 1 })
    render(<VolumeDetailModal name="datos-app" onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(/habrá que forzar/)).toBeInTheDocument())
  })

  it('muestra el error si la API falla', async () => {
    mockFetch({ detail: 'Volumen no-existe no encontrado' }, false)
    render(<VolumeDetailModal name="no-existe" onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(/no encontrado/)).toBeInTheDocument())
  })

  it('cierra con el botón y con Escape', async () => {
    mockFetch(detail)
    const onClose = vi.fn()
    const { rerender } = render(<VolumeDetailModal name="datos-app" onClose={onClose} />)

    await waitFor(() => expect(screen.getByText('Detalle del volumen')).toBeInTheDocument())

    fireEvent.click(screen.getByTitle('Cerrar detalle del volumen'))
    expect(onClose).toHaveBeenCalledTimes(1)

    rerender(<VolumeDetailModal name="datos-app" onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
