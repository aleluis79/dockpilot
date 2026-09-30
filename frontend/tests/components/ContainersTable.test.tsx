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

  it('muestra la insignia de proyecto compose solo en las filas que lo tienen', () => {
    render(
      <ContainersTable
        containers={[
          { ...mockContainers[0], compose_project: 'tickets-app' },
          mockContainers[1],
        ]}
        loading={false}
        onAction={vi.fn()}
        onSelect={vi.fn()}
      />
    )

    const insignias = screen.getAllByTestId('compose-badge')
    // Una columna `Proyecto` vacía en el resto de filas sería ruido.
    expect(insignias).toHaveLength(1)
    expect(insignias[0]).toHaveTextContent('tickets-app')
  })
})

// --- Healthchecks (SPEC-18) ----------------------------------------------------

describe('ContainersTable con salud', () => {
  const conSalud = (estado: 'healthy' | 'unhealthy' | 'starting', streak = 0) => ({
    id: 'c1',
    name: 'web-nginx',
    image: 'nginx:alpine',
    status: 'running',
    state: 'running',
    created: 1727290000,
    ports: [],
    health: { status: estado, failing_streak: streak },
  })

  it('un contenedor unhealthy lleva su marca de salud en la fila', () => {
    render(<ContainersTable containers={[conSalud('unhealthy', 8)]} />)

    expect(screen.getByTestId('salud-badge')).toHaveTextContent('unhealthy')
  })

  it('un contenedor sin healthcheck no lleva marca alguna', () => {
    render(
      <ContainersTable
        containers={[
          {
            id: 'c1',
            name: 'web-nginx',
            image: 'nginx:alpine',
            status: 'running',
            state: 'running',
            created: 1727290000,
            ports: [],
          },
        ]}
      />
    )

    expect(screen.queryByTestId('salud-badge')).not.toBeInTheDocument()
  })
})
