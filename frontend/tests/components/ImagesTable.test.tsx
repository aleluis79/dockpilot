import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ImagesTable } from '../../src/components/images/ImagesTable'
import type { LocalImageSummary } from '../../src/types/image'

const nginx: LocalImageSummary = {
  id: 'sha256:img1',
  tags: ['nginx:alpine', 'nginx:latest'],
  size: 94380000,
  created: 1727290000,
  containers: 0,
  repo_digests: ['nginx@sha256:aaa1'],
}

const redis: LocalImageSummary = {
  id: 'sha256:img2',
  tags: ['redis:alpine'],
  size: 35500000,
  created: 1727280000,
  containers: 2,
  repo_digests: [],
}

describe('ImagesTable', () => {
  const baseProps = {
    loading: false,
    error: null,
    onRefresh: vi.fn(),
    onRun: vi.fn(),
    onInspect: vi.fn(),
    onRequestDelete: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('muestra el estado de carga', () => {
    render(<ImagesTable {...baseProps} images={[]} loading />)

    expect(screen.getByText('Cargando imágenes locales...')).toBeInTheDocument()
  })

  it('muestra el estado vacío', () => {
    render(<ImagesTable {...baseProps} images={[]} />)

    expect(screen.getByText('No hay imágenes locales')).toBeInTheDocument()
  })

  it('muestra el error de la API', () => {
    render(<ImagesTable {...baseProps} images={[]} error="No se pudo conectar con Docker" />)

    expect(screen.getByText('No se pudo conectar con Docker')).toBeInTheDocument()
  })

  it('lista los tags de cada imagen y formatea el tamaño', () => {
    render(<ImagesTable {...baseProps} images={[nginx, redis]} />)

    expect(screen.getByText('nginx:alpine')).toBeInTheDocument()
    expect(screen.getByText('nginx:latest')).toBeInTheDocument()
    expect(screen.getByText('redis:alpine')).toBeInTheDocument()
    expect(screen.getByText('90.0 MB')).toBeInTheDocument()
    expect(screen.getByText('33.9 MB')).toBeInTheDocument()
  })

  it('indica qué imágenes están en uso', () => {
    render(<ImagesTable {...baseProps} images={[nginx, redis]} />)

    expect(screen.getByText('En uso (2)')).toBeInTheDocument()
    expect(screen.queryByText('En uso (0)')).not.toBeInTheDocument()
  })

  it('lanza las acciones de ejecutar, inspeccionar y eliminar', () => {
    render(<ImagesTable {...baseProps} images={[nginx]} />)

    fireEvent.click(screen.getByTitle('Ejecutar un contenedor con nginx:alpine'))
    expect(baseProps.onRun).toHaveBeenCalledWith(nginx)

    fireEvent.click(screen.getByTitle('Ver el detalle de nginx:alpine'))
    expect(baseProps.onInspect).toHaveBeenCalledWith(nginx)

    fireEvent.click(screen.getByTitle('Eliminar la imagen nginx:alpine'))
    expect(baseProps.onRequestDelete).toHaveBeenCalledWith(nginx)
  })

  it('permite reintentar cuando hay error', () => {
    render(<ImagesTable {...baseProps} images={[]} error="fallo" />)

    fireEvent.click(screen.getByTitle('Reintentar carga de imágenes'))

    expect(baseProps.onRefresh).toHaveBeenCalled()
  })

  it('refresca el inventario tras una descarga', async () => {
    const { rerender } = render(<ImagesTable {...baseProps} images={[]} />)

    rerender(<ImagesTable {...baseProps} images={[nginx]} />)
    await waitFor(() => expect(screen.getByText('nginx:alpine')).toBeInTheDocument())
  })
})
