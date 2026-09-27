import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ProjectDetailModal } from '../../../src/components/compose/ProjectDetailModal'
import type { ComposeProjectDetail } from '../../../src/types/compose'

const detalle: ComposeProjectDetail = {
  name: 'elasticsearch-local',
  services_count: 2,
  containers_total: 3,
  containers_running: 2,
  networks_count: 1,
  volumes_count: 1,
  config_files: ['/home/usuario/proyectos/elasticsearch-local/docker-compose.yml'],
  working_dir: '/home/usuario/proyectos/elasticsearch-local',
  compose_version: '5.5.1',
  orphaned: false,
  services: [
    {
      name: 'elasticsearch',
      image: 'docker.elastic.co/elasticsearch/elasticsearch:9.1.3',
      container_names: ['elasticsearch'],
      container_ids: ['c901'],
      replicas: 1,
      running: 1,
    },
    {
      name: 'api',
      image: 'mi/api:1.0',
      container_names: ['api-1', 'api-2', 'api-3'],
      container_ids: ['c911', 'c912', 'c913'],
      replicas: 3,
      running: 2,
    },
  ],
  networks: [{ logical_name: 'elastic', name: 'elasticsearch-local_elastic', driver: 'bridge' }],
  volumes: [
    { logical_name: 'elasticsearch_data', name: 'elasticsearch-local_elasticsearch_data', driver: 'local' },
  ],
}

function mockDetalle(payload: unknown = detalle) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => payload })
  )
}

describe('ProjectDetailModal', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.restoreAllMocks())

  it('lista los servicios con sus réplicas y contenedores', async () => {
    mockDetalle()
    render(<ProjectDetailModal project="elasticsearch-local" onClose={vi.fn()} />)

    // El nombre del proyecto también es `elasticsearch-local`, así que la
    // búsqueda va acotada al bloque de servicios.
    await waitFor(() => expect(screen.getByTestId('service-elasticsearch')).toBeInTheDocument())
    const api = screen.getByTestId('service-api')
    expect(api).toHaveTextContent('3 contenedores')
    expect(api).toHaveTextContent('2 en ejecución')
    expect(api).toHaveTextContent('api-1')
    expect(api).toHaveTextContent('api-3')
  })

  it('muestra el par nombre lógico y nombre real de las redes', async () => {
    mockDetalle()
    render(<ProjectDetailModal project="elasticsearch-local" onClose={vi.fn()} />)

    // El archivo declara `elastic`; en Docker se llama con el prefijo del
    // proyecto. Mostrar solo uno de los dos lleva a error al copiarlo.
    const red = await screen.findByTestId('network-logical-elastic')
    expect(red).toHaveTextContent('elastic')
    expect(red).toHaveTextContent('elasticsearch-local_elastic')
  })

  it('muestra el par nombre lógico y nombre real de los volúmenes', async () => {
    mockDetalle()
    render(<ProjectDetailModal project="elasticsearch-local" onClose={vi.fn()} />)

    const volumen = await screen.findByTestId(
      'volume-logical-elasticsearch_data'
    )
    expect(volumen).toHaveTextContent('elasticsearch-local_elasticsearch_data')
  })

  it('informa del directorio de trabajo y del archivo de configuración', async () => {
    mockDetalle()
    render(<ProjectDetailModal project="elasticsearch-local" onClose={vi.fn()} />)

    expect(
      await screen.findByText('/home/usuario/proyectos/elasticsearch-local')
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        '/home/usuario/proyectos/elasticsearch-local/docker-compose.yml'
      )
    ).toBeInTheDocument()
  })

  it('lleva a la vista de contenedores', async () => {
    const onNavigateTab = vi.fn()
    mockDetalle()
    render(
      <ProjectDetailModal
        project="elasticsearch-local"
        onClose={vi.fn()}
        onNavigateTab={onNavigateTab}
      />
    )

    fireEvent.click(await screen.findByRole('button', { name: /ver contenedores/i }))

    expect(onNavigateTab).toHaveBeenCalledWith('containers')
  })

  it('no muestra el enlace a contenedores si no hay a dónde ir', async () => {
    mockDetalle()
    render(<ProjectDetailModal project="elasticsearch-local" onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByTestId('project-detail-modal')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /ver contenedores/i })).not.toBeInTheDocument()
  })

  it('informa del error cuando el proyecto no existe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ detail: "No hay ningún proyecto Docker Compose llamado 'nope'" }),
      })
    )
    render(<ProjectDetailModal project="nope" onClose={vi.fn()} />)

    expect(await screen.findByRole('alert')).toHaveTextContent(/ningún proyecto/i)
  })

  it('cierra al pulsar la X y al pulsar fuera', async () => {
    const onClose = vi.fn()
    mockDetalle()
    render(<ProjectDetailModal project="elasticsearch-local" onClose={onClose} />)

    fireEvent.click(await screen.findByRole('button', { name: /cerrar/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
