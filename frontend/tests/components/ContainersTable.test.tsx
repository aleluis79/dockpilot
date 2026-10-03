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

// --- La marca de observado (SPEC-17 §4.9) -----------------------------------

describe('ContainersTable · observado', () => {
  const base = {
    image: 'nginx:alpine',
    status: 'running',
    state: 'Up 2 hours',
    created: 1727290000,
    ports: [],
  }

  it('marca el contenedor observado', () => {
    render(<ContainersTable containers={[{ ...base, id: 'c1', name: 'web', observed: true }]} onSelect={vi.fn()} />)

    expect(screen.getAllByTestId('container-observed')).toHaveLength(1)
    expect(screen.getByText('Observando')).toBeInTheDocument()
  })

  it('no marca los que no lo están', () => {
    render(<ContainersTable containers={[{ ...base, id: 'c1', name: 'web', observed: false }]} onSelect={vi.fn()} />)

    expect(screen.queryByTestId('container-observed')).not.toBeInTheDocument()
  })

  it('un contenedor sin el campo no se marca: el backend viejo no lo manda', () => {
    render(<ContainersTable containers={[{ ...base, id: 'c1', name: 'web' }]} onSelect={vi.fn()} />)

    expect(screen.queryByTestId('container-observed')).not.toBeInTheDocument()
  })
})

// --- La tabla no se deja reventar por un nombre largo (SPEC-00) -------------
//
// Un contenedor puede llamarse con un sha de 64 caracteres. Con `table-auto` la
// columna se dimensiona al contenido, esa celda empuja la tabla entera más allá
// del contenedor y los BOTONES DE ACCIÓN se van fuera de pantalla. Es peor que
// un scroll: la acción es lo que hay que poder pulsar.

describe('ContainersTable · nombres largos', () => {
  const base = {
    image: 'nginx:alpine',
    status: 'running',
    state: 'Up 2 hours',
    created: 1727290000,
    ports: [],
  }

  it('la tabla es de ancho fijo, que es lo que evita el desbordamiento', () => {
    const { container } = render(
      <ContainersTable containers={[{ ...base, id: 'c1', name: 'web' }]} onSelect={vi.fn()} />
    )
    expect(container.querySelector('table')?.className).toContain('table-fixed')
    expect(container.querySelector('table')?.className).not.toContain('table-auto')
  })

  it('el nombre se trunca y el entero se ve al pasar el ratón', () => {
    const largo = 'a'.repeat(64)
    render(<ContainersTable containers={[{ ...base, id: 'c1', name: largo }]} onSelect={vi.fn()} />)

    const celda = screen.getByText(largo)
    expect(celda.className).toContain('truncate')
    // El texto completo tiene que seguir en el DOM y en el `title`: truncar sin
    // `title` deja al usuario sin poder saber qué hay detrás.
    expect(celda).toHaveAttribute('title', largo)
  })

  it('la imagen también se trunca, que un digest es igual de larga', () => {
    const digest = `nginx@sha256:${'b'.repeat(64)}`
    render(
      <ContainersTable containers={[{ ...base, id: 'c1', name: 'web', image: digest }]} onSelect={vi.fn()} />
    )
    const celda = screen.getByText(digest)
    expect(celda.className).toContain('truncate')
    expect(celda).toHaveAttribute('title', digest)
  })

  it('las acciones siguen presentes en una fila con nombre de 64 caracteres', () => {
    render(
      <ContainersTable
        containers={[{ ...base, id: 'c1', name: 'a'.repeat(64) }]}
        onSelect={vi.fn()}
      />
    )
    // El botón de inicio es el que importa: si la fila se sale de pantalla, el
    // panel se queda sin forma de Asked.
    expect(screen.getByTitle(/Detener contenedor/)).toBeInTheDocument()
    expect(screen.getByTitle(/Eliminar contenedor/)).toBeInTheDocument()
  })
})
