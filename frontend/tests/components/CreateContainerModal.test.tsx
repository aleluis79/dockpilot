import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CreateContainerModal } from '../../src/components/containers/CreateContainerModal'

describe('CreateContainerModal', () => {
  it('renders modal with required inputs and quick presets', () => {
    render(
      <CreateContainerModal
        isOpen={true}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />
    )

    expect(screen.getByText('Crear Nuevo Contenedor')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('ej. nginx:alpine o redis:latest')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('ej. mi-contenedor (opcional)')).toBeInTheDocument()
    expect(screen.getByText('Nginx')).toBeInTheDocument()
    expect(screen.getByText('Postgres')).toBeInTheDocument()
    expect(screen.getByText('Redis')).toBeInTheDocument()
  })

  it('selects preset image on click', () => {
    render(
      <CreateContainerModal
        isOpen={true}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />
    )

    const redisPreset = screen.getByText('Redis')
    fireEvent.click(redisPreset)

    const imageInput = screen.getByPlaceholderText('ej. nginx:alpine o redis:latest') as HTMLInputElement
    expect(imageInput.value).toBe('redis:alpine')
  })

  it('allows adding and removing dynamic port mapping rows', () => {
    render(
      <CreateContainerModal
        isOpen={true}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />
    )

    const addPortBtn = screen.getByText('Añadir puerto')
    fireEvent.click(addPortBtn)

    const hostPortInputs = screen.getAllByPlaceholderText('Host (ej. 8080)')
    expect(hostPortInputs.length).toBe(1)

    const removePortBtn = screen.getByTitle('Eliminar puerto')
    fireEvent.click(removePortBtn)

    expect(screen.queryByPlaceholderText('Host (ej. 8080)')).not.toBeInTheDocument()
  })

  it('does not render when isOpen is false', () => {
    render(
      <CreateContainerModal
        isOpen={false}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />
    )

    expect(screen.queryByText('Crear Nuevo Contenedor')).not.toBeInTheDocument()
  })

  it('searches Docker Hub without closing the modal or submitting the form', async () => {
    const { dockerApi } = await import('../../src/services/dockerApi')
    const searchSpy = vi.spyOn(dockerApi, 'searchImages').mockResolvedValueOnce([
      {
        name: 'postgres',
        description: 'The PostgreSQL object-relational database system',
        star_count: 14500,
        is_official: true,
      },
    ])

    const onClose = vi.fn()
    const onSuccess = vi.fn()

    render(
      <CreateContainerModal
        isOpen={true}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    )

    // Switch to Docker Hub tab
    const dockerHubTab = screen.getByText('Docker Hub')
    fireEvent.click(dockerHubTab)

    const searchInput = screen.getByPlaceholderText('Buscar imagen en Docker Hub (ej. redis, mongo)...')
    fireEvent.change(searchInput, { target: { value: 'postgres' } })

    const searchBtn = screen.getByText('Buscar')
    fireEvent.click(searchBtn)

    expect(searchSpy).toHaveBeenCalledWith('postgres', 10)
    // Critical: modal should not close and form should not submit
    expect(onClose).not.toHaveBeenCalled()
    expect(onSuccess).not.toHaveBeenCalled()

    // Wait for search result to show
    const resultItem = await screen.findByText('The PostgreSQL object-relational database system')
    expect(resultItem).toBeInTheDocument()
  })

  it('searches Docker Hub on Enter key without closing modal', async () => {
    const { dockerApi } = await import('../../src/services/dockerApi')
    const searchSpy = vi.spyOn(dockerApi, 'searchImages').mockResolvedValueOnce([
      {
        name: 'alpine',
        description: 'A minimal Docker image based on Alpine Linux',
        star_count: 10000,
        is_official: true,
      },
    ])

    const onClose = vi.fn()
    const onSuccess = vi.fn()

    render(
      <CreateContainerModal
        isOpen={true}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    )

    // Switch to Docker Hub tab
    fireEvent.click(screen.getByText('Docker Hub'))

    const searchInput = screen.getByPlaceholderText('Buscar imagen en Docker Hub (ej. redis, mongo)...')
    fireEvent.change(searchInput, { target: { value: 'alpine' } })
    fireEvent.keyDown(searchInput, { key: 'Enter', code: 'Enter' })

    expect(searchSpy).toHaveBeenCalledWith('alpine', 10)
    expect(onClose).not.toHaveBeenCalled()
    expect(onSuccess).not.toHaveBeenCalled()

    const resultItem = await screen.findByText('A minimal Docker image based on Alpine Linux')
    expect(resultItem).toBeInTheDocument()
  })
})
