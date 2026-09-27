import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { dockerApi } from '../../src/services/dockerApi'
import type {
  ComposeOverview,
  ComposePlan,
  ComposeProjectDetail,
} from '../../src/types/compose'

const proyecto = {
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

const overview: ComposeOverview = {
  projects: [proyecto, { ...proyecto, name: 'simp-sica', containers_total: 0, containers_running: 0, orphaned: true }],
  total_projects: 2,
  running_projects: 1,
  orphaned_projects: 1,
  unlabelled_containers: 1,
  unlabelled_networks: 3,
  unlabelled_volumes: 7,
}

const detalle: ComposeProjectDetail = {
  ...proyecto,
  services: [
    {
      name: 'elasticsearch',
      image: 'sha256:abc',
      container_names: ['elasticsearch'],
      container_ids: ['c901'],
      replicas: 1,
      running: 1,
    },
  ],
  networks: [{ logical_name: 'elastic', name: 'elasticsearch-local_elastic', driver: 'bridge' }],
  volumes: [
    { logical_name: 'elasticsearch_data', name: 'elasticsearch-local_elasticsearch_data', driver: 'local' },
  ],
}

function mockOk(payload: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => payload })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('dockerApi · compose', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.restoreAllMocks())

  it('listComposeProjects consulta /compose/projects', async () => {
    const fetchMock = mockOk(overview)

    const data = await dockerApi.listComposeProjects()

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/compose/projects')
    expect(data.total_projects).toBe(2)
    expect(data.orphaned_projects).toBe(1)
    expect(data.unlabelled_volumes).toBe(7)
  })

  it('getComposeProject consulta /compose/projects/{nombre} escapando el nombre', async () => {
    const fetchMock = mockOk(detalle)

    const data = await dockerApi.getComposeProject('tickets app/malo')

    // Un nombre de proyecto puede llevar barra o espacio: sin `encodeURIComponent`
    // la petición apunta a otra ruta y el 404 dice "no existe" en vez de "mal
    // formado".
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/compose/projects/tickets%20app%2Fmalo'
    )
    expect(data.networks[0].logical_name).toBe('elastic')
  })

  it('propaga el mensaje de error del daemon', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ detail: 'El daemon de Docker no responde' }),
      })
    )

    await expect(dockerApi.listComposeProjects()).rejects.toThrow(
      /no responde/i
    )
  })

  it('propaga el 404 de un proyecto inexistente', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ detail: "No hay ningún proyecto Docker Compose llamado 'nope'" }),
      })
    )

    await expect(dockerApi.getComposeProject('nope')).rejects.toThrow(/ningún proyecto/i)
  })
})

const plan: ComposePlan = {
  project_name: 'elasticsearch-local',
  source_path: '/p/docker-compose.yml',
  services: [
    {
      name: 'elasticsearch',
      image: 'nginx:1.27',
      build: false,
      container_name: 'elasticsearch',
      command: null,
      entrypoint: null,
      restart: 'unless-stopped',
      ports: [{ target: 9200, published: '9200', protocol: 'tcp', mode: 'ingress' }],
      mounts: [{ type: 'volume', source: 'datos', target: '/data', read_only: false }],
      networks: ['front'],
      depends_on: [],
      profiles: [],
      environment_count: 2,
    },
  ],
  networks: [],
  volumes: [],
  warnings: [],
  resolved_by: 'docker-compose-cli',
}

describe('dockerApi · plan de compose', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.restoreAllMocks())

  it('planCompose envia la ruta y el proyecto al endpoint de plan', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => plan })
    vi.stubGlobal('fetch', fetchMock)

    await dockerApi.planCompose({ path: '/p/docker-compose.yml', project_name: 'tienda' })

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/compose/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/p/docker-compose.yml', project_name: 'tienda' }),
    })
  })

  it('planCompose envia el contenido editado cuando lo hay', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => plan })
    vi.stubGlobal('fetch', fetchMock)

    await dockerApi.planCompose({
      path: '/p/docker-compose.yml',
      content: 'services: {}',
    })

    const [, opciones] = fetchMock.mock.calls[0]
    expect(JSON.parse(opciones.body).content).toBe('services: {}')
  })

  it('propaga el mensaje de un archivo invalido', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: async () => ({ detail: 'go-yaml load error in parser at L3.C11' }),
      })
    )

    await expect(dockerApi.planCompose({ path: '/p/dc.yml' })).rejects.toThrow(/go-yaml/)
  })

  it('propaga el aviso de que falta el CLI', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ detail: "No se encontró el binario 'docker'." }),
      })
    )

    await expect(dockerApi.planCompose({ path: '/p/dc.yml' })).rejects.toThrow(/docker/i)
  })
})
