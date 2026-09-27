import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { ProjectsTable } from '../../../src/components/compose/ProjectsTable'
import type { ComposeProjectSummary } from '../../../src/types/compose'

const base: ComposeProjectSummary = {
  name: 'elasticsearch-local',
  services_count: 2,
  containers_total: 2,
  containers_running: 2,
  networks_count: 1,
  volumes_count: 1,
  config_files: ['/home/usuario/proyectos/elasticsearch-local/docker-compose.yml'],
  working_dir: '/home/usuario/proyectos/elasticsearch-local',
  compose_version: '5.5.1',
  orphaned: false,
}

const huerfano: ComposeProjectSummary = {
  ...base,
  name: 'simp-sica',
  services_count: 0,
  containers_total: 0,
  containers_running: 0,
  networks_count: 0,
  volumes_count: 1,
  compose_version: '',
  orphaned: true,
}

const projects = [base, huerfano]

describe('ProjectsTable', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.restoreAllMocks())

  it('lista los proyectos con sus recuentos', () => {
    render(<ProjectsTable projects={projects} onSelect={vi.fn()} />)

    const filas = screen.getAllByTestId('project-row')
    expect(filas).toHaveLength(2)
    const primera = within(filas[0])
    expect(primera.getByText('elasticsearch-local')).toBeInTheDocument()
    expect(primera.getByText('2 / 2')).toBeInTheDocument()
    expect(primera.getByText('5.5.1')).toBeInTheDocument()
  })

  it('marca solo los proyectos huérfanos', () => {
    render(<ProjectsTable projects={projects} onSelect={vi.fn()} />)

    const insignias = screen.getAllByTestId('orphaned-badge')
    expect(insignias).toHaveLength(1)
    expect(insignias[0]).toHaveTextContent('Huerfano')
  })

  it('indica que no hay proyectos compose en el host', () => {
    render(<ProjectsTable projects={[]} onSelect={vi.fn()} />)

    expect(screen.getByTestId('projects-empty')).toBeInTheDocument()
  })

  it('avisa cuando el archivo de configuración se compone de varias rutas', () => {
    render(
      <ProjectsTable
        projects={[{ ...base, config_files: ['/p/a.yml', '/p/b.yml'] }]}
        onSelect={vi.fn()}
      />
    )

    // La etiqueta `project.config_files` es una lista separada por comas: con
    // `-f a.yml -f b.yml` el proyecto tiene dos archivos.
    const extra = screen.getByTestId('extra-config-files')
    expect(extra).toHaveTextContent('+1')
    expect(extra).toHaveAttribute('title', '/p/a.yml, /p/b.yml')
  })

  it('avisa cuando un proyecto no tiene archivo de configuración', () => {
    render(
      <ProjectsTable
        projects={[{ ...huerfano, config_files: [] }]}
        onSelect={vi.fn()}
      />
    )

    expect(screen.getByText(/sin archivo/i)).toBeInTheDocument()
  })

  it('ofrece las cuatro acciones con el icono de su gesto', () => {
    render(
      <ProjectsTable
        projects={[base]}
        onSelect={vi.fn()}
        onAccion={vi.fn()}
        onBajar={vi.fn()}
      />
    )

    // Regresión: `logs` se pintaba con el icono de terminal y `down` con una
    // flecha, cuando en el panel esos iconos significan shell y nada.
    expect(screen.getByTitle('Levantar')).toBeInTheDocument()
    expect(screen.getByTitle('Parar')).toBeInTheDocument()
    expect(screen.getByTitle('Bajar')).toBeInTheDocument()
    expect(screen.getByTitle('Logs')).toBeInTheDocument()
  })

  it('deshabilita las acciones si no hay manejadores', () => {
    // Se pintan pero deshabilitadas, no ocultas: así la fila no cambia de altura
    // y queda claro que la acción existe pero aquí no está disponible.
    render(<ProjectsTable projects={[base]} onSelect={vi.fn()} />)

    expect(screen.getByTitle('Levantar')).toBeDisabled()
    expect(screen.getByTitle('Bajar')).toBeDisabled()
  })

  it('no ofrece acciones si el proyecto no tiene archivo conocido', () => {
    // Sin ruta no hay comando que ejecutar, y adivinar significaría operar sobre
    // el archivo equivocado.
    render(
      <ProjectsTable
        projects={[{ ...base, config_files: [] }]}
        onSelect={vi.fn()}
        onAccion={vi.fn()}
        onBajar={vi.fn()}
      />
    )

    expect(screen.queryByTitle('Levantar')).not.toBeInTheDocument()
  })

  it('avisa al pulsar una fila', () => {
    const onSelect = vi.fn()
    render(<ProjectsTable projects={projects} onSelect={onSelect} />)

    fireEvent.click(screen.getAllByTestId('project-row')[1])

    expect(onSelect).toHaveBeenCalledWith(huerfano)
  })
})
