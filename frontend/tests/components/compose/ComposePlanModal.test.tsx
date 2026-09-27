import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ComposePlanModal } from '../../../src/components/compose/ComposePlanModal'
import { dockerApi } from '../../../src/services/dockerApi'
import type { BrowseResult, ComposePlan } from '../../../src/types/compose'

const plan: ComposePlan = {
  project_name: 'elasticsearch-local',
  source_path: '/p/docker-compose.yml',
  services: [
    {
      name: 'elasticsearch',
      image: 'docker.elastic.co/elasticsearch/elasticsearch:9.1.3',
      build: false,
      container_name: 'elasticsearch',
      command: null,
      entrypoint: null,
      restart: 'unless-stopped',
      ports: [
        { target: 9200, published: '9200', protocol: 'tcp', mode: 'ingress' },
        // Un rango llega como cadena, no como número.
        { target: 80, published: '8000-8010', protocol: 'tcp', mode: 'ingress' },
      ],
      mounts: [
        { type: 'volume', source: 'elasticsearch_data', target: '/data', read_only: false },
      ],
      networks: ['elastic'],
      depends_on: [],
      profiles: [],
      environment_count: 7,
    },
    {
      name: 'api',
      image: 'mi/api:1.0',
      build: true,
      container_name: null,
      command: null,
      entrypoint: null,
      restart: null,
      ports: [],
      mounts: [],
      networks: [],
      depends_on: ['db'],
      profiles: ['dev'],
      environment_count: 0,
    },
  ],
  networks: [
    { logical_name: 'elastic', name: 'elasticsearch-local_elastic', driver: 'bridge', external: false, exists: true },
  ],
  volumes: [
    { logical_name: 'elasticsearch_data', name: 'elasticsearch-local_elasticsearch_data', driver: 'local', external: false, exists: true },
    { logical_name: 'nuevo', name: 'tienda_nuevo', driver: 'local', external: false, exists: false },
  ],
  warnings: ['time="..." level=warning msg="The \\"X\\" variable is not set."'],
  resolved_by: 'docker-compose-cli',
}

function mockOk(payload: unknown = plan) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => payload })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function mockError(status: number, detail: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: false, status, json: async () => ({ detail }) })
  )
}

describe('ComposePlanModal', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.restoreAllMocks())

  it('envía la ruta al validar', async () => {
    const fetchMock = mockOk()
    render(<ComposePlanModal open onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText(/ruta del archivo/i), {
      target: { value: '/p/docker-compose.yml' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^validar$/i }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const cuerpo = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(cuerpo.path).toBe('/p/docker-compose.yml')
    // Sin edición no se manda `content`: el backend lee el archivo.
    expect(cuerpo.content ?? null).toBeNull()
  })

  it('manda el contenido editado con «Validar con cambios»', async () => {
    const fetchMock = mockOk()
    render(<ComposePlanModal open onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText(/ruta del archivo/i), {
      target: { value: '/p/docker-compose.yml' },
    })
    fireEvent.change(screen.getByTestId('compose-editor'), {
      target: { value: 'services:\n  nuevo:\n    image: x' },
    })
    fireEvent.click(screen.getByRole('button', { name: /validar con cambios/i }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const cuerpo = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(cuerpo.content).toBe('services:\n  nuevo:\n    image: x')
  })

  it('no llama al backend sin ruta', async () => {
    const fetchMock = mockOk()
    render(<ComposePlanModal open onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /^validar$/i }))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toHaveTextContent(/ruta/i)
  })

  it('pinta el plan con servicios, puertos, montajes, redes y volúmenes', async () => {
    mockOk()
    render(<ComposePlanModal open onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText(/ruta del archivo/i), {
      target: { value: '/p/docker-compose.yml' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^validar$/i }))

    await waitFor(() => expect(screen.getByTestId('compose-plan')).toBeInTheDocument())
    expect(screen.getByTestId('service-elasticsearch')).toBeInTheDocument()
    expect(screen.getByTestId('service-api')).toBeInTheDocument()
    // El rango se muestra tal cual llega, sin convertirlo a número ni a rango
    // de puertos del host.
    expect(screen.getByText('8000-8010:80')).toBeInTheDocument()
    expect(screen.getByText('9200:9200')).toBeInTheDocument()
    expect(screen.getByTestId('network-logical-elastic')).toBeInTheDocument()
    expect(
      screen.getByTestId('volume-logical-elasticsearch_data')
    ).toBeInTheDocument()
  })

  it('distingue lo que ya existe de lo que se crearía', async () => {
    mockOk()
    render(<ComposePlanModal open onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText(/ruta del archivo/i), {
      target: { value: '/p/docker-compose.yml' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^validar$/i }))

    await waitFor(() => expect(screen.getByTestId('compose-plan')).toBeInTheDocument())
    const yaExiste = screen.getByTestId('volume-logical-elasticsearch_data')
    const seCrearia = screen.getByTestId('volume-logical-nuevo')
    expect(yaExiste).toHaveTextContent('ya existe')
    expect(seCrearia).toHaveTextContent('se crearía')
  })

  it('marca los servicios que declaran build', async () => {
    mockOk()
    render(<ComposePlanModal open onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText(/ruta del archivo/i), {
      target: { value: '/p/docker-compose.yml' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^validar$/i }))

    await waitFor(() => expect(screen.getByTestId('compose-plan')).toBeInTheDocument())
    expect(screen.getByTestId('service-api')).toHaveTextContent('build')
    expect(screen.getByTestId('service-elasticsearch')).not.toHaveTextContent('build')
  })

  it('muestra los avisos de compose en su propia franja', async () => {
    // El aviso sale de `stderr` con código 0: el archivo es válido pero algo no
    // está definido. No es un error y no puede parecerse a uno.
    mockOk()
    render(<ComposePlanModal open onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText(/ruta del archivo/i), {
      target: { value: '/p/docker-compose.yml' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^validar$/i }))

    const avisos = await screen.findByTestId('compose-warnings')
    expect(avisos).toHaveTextContent(/level=warning/)
    expect(avisos).toHaveTextContent(/variable is not set/)
  })

  it('no muestra franja de avisos cuando no hay', async () => {
    mockOk({ ...plan, warnings: [] })
    render(<ComposePlanModal open onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText(/ruta del archivo/i), {
      target: { value: '/p/docker-compose.yml' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^validar$/i }))

    await waitFor(() => expect(screen.getByTestId('compose-plan')).toBeInTheDocument())
    expect(screen.queryByTestId('compose-warnings')).not.toBeInTheDocument()
  })

  it('muestra el error de un archivo inválido y no pinta plan', async () => {
    mockError(422, 'go-yaml load error in parser at L3.C11')
    render(<ComposePlanModal open onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText(/ruta del archivo/i), {
      target: { value: '/roto/docker-compose.yml' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^validar$/i }))

    // El mensaje de compose es lo más útil que puede mostrar el panel.
    expect(await screen.findByRole('alert')).toHaveTextContent(/go-yaml/)
    // No hay plan si compose no pudo resolver el archivo.
    expect(screen.queryByTestId('compose-plan')).not.toBeInTheDocument()
  })

  it('explica que falta el CLI sin romper la vista', async () => {
    mockError(503, "No se encontró el binario 'docker'. DockPilot necesita el CLI.")
    render(<ComposePlanModal open onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText(/ruta del archivo/i), {
      target: { value: '/p/docker-compose.yml' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^validar$/i }))

    const alerta = await screen.findByRole('alert')
    expect(alerta).toHaveTextContent(/CLI/i)
  })

  it('no ofrece ninguna acción que ejecute compose', async () => {
    // Esta spec no ejecuta nada. Si algún día aparece un botón de `up` aquí, el
    // alcance se ha wideningado sin cambiar la spec.
    mockOk()
    render(<ComposePlanModal open onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText(/ruta del archivo/i), {
      target: { value: '/p/docker-compose.yml' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^validar$/i }))

    await waitFor(() => expect(screen.getByTestId('compose-plan')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /^levantar$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /desplegar/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /bajar/i })).not.toBeInTheDocument()
  })

  it('indica de dónde viene el plan', async () => {
    mockOk()
    render(<ComposePlanModal open onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText(/ruta del archivo/i), {
      target: { value: '/p/docker-compose.yml' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^validar$/i }))

    // El plan lo resuelve el CLI, no un parser propio: por eso no puede
    // discrepar de lo que hará el `up`.
    expect(await screen.findByTestId('resolved-by')).toHaveTextContent(
      /docker compose/i
    )
  })
  // --- SPEC-14: elegir el archivo sin copiar la ruta a mano ---------------------

  it('abre el explorador y rellena la ruta con lo elegido', async () => {
    mockOk()
    vi.spyOn(dockerApi, 'browseComposeFiles').mockResolvedValue({
      path: '/home/usuario',
      root: '/home/usuario',
      parent: null,
      entries: [
        {
          name: 'docker-compose.yml',
          path: '/home/usuario/proyectos/sica/docker-compose.yml',
          kind: 'file',
          es_compose: true,
          size: 120,
          modificado: 0,
        },
      ],
      total: 1,
      truncado: false,
      ocultos: 0,
    } satisfies BrowseResult)
    render(<ComposePlanModal open onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /seleccionar archivo/i }))
    fireEvent.click(await screen.findByText('docker-compose.yml'))

    expect(screen.getByLabelText(/ruta del archivo/i)).toHaveValue(
      '/home/usuario/proyectos/sica/docker-compose.yml'
    )
  })

  it('elegir el archivo no previsualiza solo', async () => {
    const fetchMock = mockOk()
    vi.spyOn(dockerApi, 'browseComposeFiles').mockResolvedValue({
      path: '/home/usuario',
      root: '/home/usuario',
      parent: null,
      entries: [],
      total: 0,
      truncado: false,
      ocultos: 0,
    } satisfies BrowseResult)
    render(<ComposePlanModal open onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /seleccionar archivo/i }))

    // Abrir un archivo y ejecutarlo no es lo mismo: el plan sigue siendo un paso
    // explícito, porque `planCompose` es lo que llama a compose.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('el texto del campo se puede seguir escribiendo a mano', () => {
    render(<ComposePlanModal open onClose={vi.fn()} />)

    // El explorador es una comodidad, no un reemplazo: hay compose files fuera
    // de la raíz y fuera de la raíz, y la ruta tiene que seguir siendo editable.
    const campo = screen.getByLabelText(/ruta del archivo/i)
    expect(campo).not.toBeDisabled()
    expect(campo).not.toHaveAttribute('readonly')
    expect(campo).toHaveAttribute('type', 'text')
  })
})

