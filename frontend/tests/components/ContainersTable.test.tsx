import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ContainersTable } from '../../src/components/containers/ContainersTable'
import type { ContainerSummary } from '../../src/types/docker'

const mockContainers: ContainerSummary[] = [
  {
    id: 'c12345678901',
    name: 'web-nginx',
    image: 'nginx:alpine',
    status: 'running',
    state: 'running',
    created: 1727290000,
    ports: [{ private_port: 80, public_port: 8080, type: 'tcp' }],
  },
  {
    id: 'c98765432109',
    name: 'db-postgres',
    image: 'postgres:16',
    status: 'exited',
    state: 'exited',
    created: 1727280000,
    ports: [],
  },
]

describe('ContainersTable', () => {
  it('renders containers list correctly', () => {
    render(
      <ContainersTable
        containers={mockContainers}
        loading={false}
        onAction={vi.fn()}
        onSelect={vi.fn()}
      />
    )

    expect(screen.getByText('web-nginx')).toBeInTheDocument()
    expect(screen.getByText('nginx:alpine')).toBeInTheDocument()
    expect(screen.getByText('8080:80/tcp')).toBeInTheDocument()
    expect(screen.getByText('db-postgres')).toBeInTheDocument()
  })

  it('triggers onAction callback when clicking stop on a running container', () => {
    const handleAction = vi.fn()
    render(
      <ContainersTable
        containers={mockContainers}
        loading={false}
        onAction={handleAction}
        onSelect={vi.fn()}
      />
    )

    const stopButton = screen.getByTitle('Detener contenedor web-nginx')
    fireEvent.click(stopButton)

    expect(handleAction).toHaveBeenCalledWith('c12345678901', 'stop')
  })

  it('triggers onAction callback when clicking start on an exited container', () => {
    const handleAction = vi.fn()
    render(
      <ContainersTable
        containers={mockContainers}
        loading={false}
        onAction={handleAction}
        onSelect={vi.fn()}
      />
    )

    const startButton = screen.getByTitle('Iniciar contenedor db-postgres')
    fireEvent.click(startButton)

    expect(handleAction).toHaveBeenCalledWith('c98765432109', 'start')
  })

  it('triggers onSelect when clicking a container row', () => {
    const handleSelect = vi.fn()
    render(
      <ContainersTable
        containers={mockContainers}
        loading={false}
        onAction={vi.fn()}
        onSelect={handleSelect}
      />
    )

    const containerName = screen.getByText('web-nginx')
    fireEvent.click(containerName)

    expect(handleSelect).toHaveBeenCalledWith(mockContainers[0])
  })

  it('triggers onOpenTerminal when clicking the terminal button on a running container', () => {
    const handleOpenTerminal = vi.fn()
    render(
      <ContainersTable
        containers={mockContainers}
        loading={false}
        onAction={vi.fn()}
        onSelect={vi.fn()}
        onOpenTerminal={handleOpenTerminal}
      />
    )

    const terminalBtn = screen.getByTitle('Abrir terminal interactivo de web-nginx')
    fireEvent.click(terminalBtn)

    expect(handleOpenTerminal).toHaveBeenCalledWith(mockContainers[0])
  })
})
