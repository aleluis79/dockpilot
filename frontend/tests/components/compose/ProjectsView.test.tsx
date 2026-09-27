import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ProjectsView } from '../../../src/components/compose/ProjectsView'
import type { ComposeOverview } from '../../../src/types/compose'

const base = {
  name: 'elasticsearch-local',
  services_count: 2,
  containers_total: 2,
  containers_running: 2,
  networks_count: 1,
  volumes_count: 1,
  config_files: ['/p/docker-compose.yml'],
  working_dir: '/p',
  compose_version: '5.5.1',
  orphaned: false,
}

const overview: ComposeOverview = {
  projects: [
    base,
    { ...base, name: 'simp-sica', containers_total: 0, containers_running: 0, services_count: 0, orphaned: true },
    { ...base, name: 'tickets-app', containers_total: 0, containers_running: 0, services_count: 0, orphaned: true },
  ],
  total_projects: 3,
  running_projects: 1,
  orphaned_projects: 2,
  unlabelled_containers: 1,
  unlabelled_networks: 3,
  unlabelled_volumes: 7,
}

function mockOk(payload: unknown = overview) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => payload })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const detalle = {
  ...overview.projects[1],
  services: [],
  networks: [],
  volumes: [],
}

/**
 * Como `mockOk`, pero el detalle de un proyecto devuelve su propia forma.
 *
 * Con un único payload, la vista y el modal recibirían la misma respuesta y el
 * detalle se leería con `networks.length` sobre `undefined`.
 */
function mockOkConDetalle() {
  const fetchMock = vi.fn().mockImplementation((url: string) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => (url.includes('/projects/') ? detalle : overview),
    })
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('ProjectsView', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.restoreAllMocks())

  it('lista los proyectos del host', async () => {
    mockOk()
    render(<ProjectsView />)

    await waitFor(() => expect(screen.getByTestId('projects-table')).toBeInTheDocument())
    expect(screen.getByText('elasticsearch-local')).toBeInTheDocument()
    expect(screen.getByText('simp-sica')).toBeInTheDocument()
    expect(screen.getByText('tickets-app')).toBeInTheDocument()
  })

  it('acota la tabla con los filtros', async () => {
    mockOk()
    render(<ProjectsView />)

    await waitFor(() => expect(screen.getByTestId('projects-table')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /huérfanos/i }))
    await waitFor(() =>
      expect(screen.queryByText('elasticsearch-local')).not.toBeInTheDocument()
    )
    expect(screen.getByText('simp-sica')).toBeInTheDocument()
    expect(screen.getByText('tickets-app')).toBeInTheDocument()
  })

  it('busca por nombre', async () => {
    mockOk()
    render(<ProjectsView />)

    await waitFor(() => expect(screen.getByTestId('projects-table')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText(/buscar proyecto/i), {
      target: { value: 'tickets' },
    })

    await waitFor(() =>
      expect(screen.queryByText('simp-sica')).not.toBeInTheDocument()
    )
    expect(screen.getByText('tickets-app')).toBeInTheDocument()
  })

  it('informa de los recursos que no pertenecen a ningún proyecto', async () => {
    mockOk()
    render(<ProjectsView />)

    // Es la pregunta que responde "¿qué hay aquí que no es de ningún proyecto?".
    const resumen = await screen.findByTestId('unlabelled-summary')
    expect(resumen).toHaveTextContent('1')
    expect(screen.getByText(/sin proyecto/i)).toBeInTheDocument()
  })

  it('avisa cuando no hay ningún proyecto compose', async () => {
    mockOk({ ...overview, projects: [], total_projects: 0, running_projects: 0, orphaned_projects: 0 })
    render(<ProjectsView />)

    expect(await screen.findByTestId('projects-empty')).toBeInTheDocument()
  })

  it('muestra el estado de error sin dejar la vista inservible', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ detail: 'El daemon de Docker no responde' }),
      })
    )
    render(<ProjectsView />)

    expect(await screen.findByRole('alert')).toHaveTextContent(/no responde/i)
  })

  it('abre el detalle de un proyecto', async () => {
    mockOkConDetalle()
    render(<ProjectsView />)

    await waitFor(() => expect(screen.getByTestId('projects-table')).toBeInTheDocument())
    fireEvent.click(screen.getByText('simp-sica'))

    // El modal pide su propio detalle al backend.
    expect(await screen.findByTestId('project-detail-modal')).toBeInTheDocument()
    expect(await screen.findByTestId('project-detail-modal')).toHaveTextContent('simp-sica')
  })

  it('vuelve a pedir el inventario con el botón de refresco', async () => {
    const fetchMock = mockOk()
    render(<ProjectsView />)

    await waitFor(() => expect(screen.getByTestId('projects-table')).toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /refrescar/i }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })

  it('refresca el inventario al desplegar desde el plan', async () => {
    // El despliegue desde el plan lanza la misma accion que la fila, pero el panel
    // se lo monta el propio modal. Sin encadenar `onRefrescar` el proyecto recien
    // arrancado no aparecia en la tabla hasta cambiar de pestana, y la ayuda
    // decia que si (SPEC-15 parrafo 3.8).
    const plan = {
      project_name: 'tickets-app',
      source_path: '/p/docker-compose.yml',
      services: [],
      networks: [],
      volumes: [],
      warnings: [],
      proyecto_en_uso: null,
      resolved_by: 'docker-compose-cli',
    }
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).includes('/plan') ? plan : overview),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const sockets: {
      onmessage: ((e: { data: string }) => void) | null
    }[] = []
    class WS {
      onopen: (() => void) | null = null
      onmessage: ((e: { data: string }) => void) | null = null
      onclose: (() => void) | null = null
      onerror: (() => void) | null = null
      close() {}
      constructor(public url: string) {
        sockets.push(this)
      }
    }
    // @ts-expect-error doble de WebSocket
    global.WebSocket = WS

    const onRefrescar = vi.fn()
    render(<ProjectsView onRefrescar={onRefrescar} />)

    await waitFor(() => expect(screen.getByText('tickets-app')).toBeInTheDocument())
    fireEvent.click(screen.getAllByRole('button', { name: /^plan$/i })[0])
    fireEvent.change(await screen.findByLabelText(/ruta del archivo/i), {
      target: { value: '/p/docker-compose.yml' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^validar$/i }))
    await waitFor(() => expect(screen.getByTestId('compose-plan')).toBeInTheDocument())
    // El espia no se ha llamado todavia: lo que lo dispara es el `exit` del
    // despliegue, no el montaje de la vista.
    expect(onRefrescar).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /^desplegar$/i }))

    // El backend avisa con su `exit` de codigo 0, y ahi es cuando se recarga.
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0))
    const socket = sockets[0]
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'start',
        action: 'up',
        project: 'tickets-app',
        path: '/p/docker-compose.yml',
        command: [],
      }),
    })
    socket.onmessage?.({
      data: JSON.stringify({ type: 'exit', action: 'up', code: 0, duration_ms: 10 }),
    })

    await waitFor(() => expect(onRefrescar).toHaveBeenCalled())
  })
})
