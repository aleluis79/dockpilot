import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import App from '../src/App'
import { ThemeProvider } from '../src/components/layout/ThemeProvider'

class MockWebSocket {
  static instances: MockWebSocket[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn()

  constructor(url: string) {
    MockWebSocket.instances.push(this)
    void url
  }
}

class MockMediaQueryList {
  media: string
  matches = false
  constructor(media: string) {
    this.media = media
  }
  addEventListener() {}
  removeEventListener() {}
}

const contenedores = [
  {
    id: 'c123',
    name: 'web-app',
    image: 'nginx:alpine',
    status: 'running',
    state: 'Up 2 hours',
    created: 1727290000,
    ports: [],
  },
]

const images = [
  {
    id: 'sha256:img1',
    tags: ['nginx:alpine'],
    size: 25000000,
    created: 1727290000,
    containers: 1,
    repo_digests: [],
  },
]

const systemOverview = {
  info: {
    server_version: '29.8.1', os_name: 'Debian', os_type: 'linux', architecture: 'x86_64',
    kernel_version: '6.12.0', hostname: 'test', ncpu: 12, memory_total: 32827215872,
    storage_driver: 'overlayfs', docker_root_dir: '/var/lib/docker', containers_total: 1,
    containers_running: 1, containers_stopped: 0, containers_paused: 0, images_total: 1,
  },
  usage: {
    layers_size: 0,
    images: { total_count: 1, active_count: 1, total_size: 25000000, reclaimable: 0 },
    containers: { total_count: 1, active_count: 1, total_size: 0, reclaimable: 0 },
    volumes: { total_count: 0, active_count: 0, total_size: 0, reclaimable: 0 },
    build_cache_size: 0,
  },
  top_images: [],
  top_volumes: [],
}

/** Contenedores de ejemplo, uno de cada estado queinteresting para los contadores. */
const variosContenedores = [
  { id: 'c1', name: 'web-a', image: 'nginx', status: 'running', state: 'Up 2 hours', created: 1727290000, ports: [] },
  { id: 'c2', name: 'web-b', image: 'nginx', status: 'running', state: 'Up 1 hour', created: 1727290000, ports: [] },
  { id: 'c3', name: 'viejo', image: 'postgres', status: 'exited', state: 'Exited (0) 3 days ago', created: 1727290000, ports: [] },
  { id: 'c4', name: 'en-pausa', image: 'redis', status: 'paused', state: 'Up 5 minutes (Paused)', created: 1727290000, ports: [] },
]

const stubFetch = () => {
  const fetchMock = vi.fn(async (url: string) => {
    const body = String(url).includes('/images/local')
      ? images
      : String(url).includes('/containers')
        ? contenedores
        : String(url).includes('/system/overview')
          ? systemOverview
          : []
    return { ok: true, status: 200, json: async () => body } as unknown as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/**
 * Doble que **respeta el filtro de estado del servidor**, como el backend.
 *
 * Es imprescindible para reproducir el bug: si el doble devolviera siempre la
 * lista completa, los contadores saldrían bien por casualidad y el test no
 * probaría nada.
 */
const stubFetchRespetandoFiltro = () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes('/containers')) {
      const estado = new URL(String(url), 'http://x').searchParams.get('status')
      const body = estado
        ? variosContenedores.filter((c) => c.status === estado)
        : variosContenedores
      return { ok: true, status: 200, json: async () => body } as unknown as Response
    }
    return { ok: true, status: 200, json: async () => [] } as unknown as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Cuántas veces se ha pedido el listado de contenedores. */
/**
 * Cuántas veces se pidió la LISTA de contenedores, y sólo eso.
 *
 * El filtro excluye `/prune` a propósito. Con un `includes('/containers')` a
 * secas, la barra de limpieza de SPEC-21 —que pide su propio preaviso— hacía que
 * estos tests contaran dos peticiones donde preguntan por una, y el fallo
 * apuntaba al sitio equivocado. Un contador por prefijo ancho se rompe con
 * cualquier sub-recurso nuevo bajo el mismo prefijo.
 */
const contarContenedores = (fetchMock: { mock: { calls: unknown[][] } }) =>
  fetchMock.mock.calls.filter(
    ([url]) => String(url).includes('/containers') && !String(url).includes('/prune')
  ).length

describe('App · conmutador de vista', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    stubFetch()
    // @ts-expect-error Mocking WebSocket
    global.WebSocket = MockWebSocket
    vi.stubGlobal('matchMedia', (query: string) => new MockMediaQueryList(query))
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('vuelve a pedir los contenedores al volver a la pestaña', async () => {
    const fetchMock = stubFetch()

    render(
      <ThemeProvider>
        <App />
      </ThemeProvider>
    )
    await waitFor(() => expect(screen.getByText('web-app')).toBeInTheDocument())
    const peticionesIniciales = contarContenedores(fetchMock)

    // Se desplega un proyecto desde otra pestaña. `useContainers` vive en `App`, así
    // que no se desmonta y su lista se queda obsoleta: el síntoma era que los
    // contenedores nuevos no aparecían hasta tocar el filtro de estado.
    fireEvent.click(screen.getByRole('button', { name: /proyectos/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /contenedores/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /^contenedores$/i }))

    await waitFor(() =>
      expect(contarContenedores(fetchMock)).toBeGreaterThan(peticionesIniciales)
    )
  })

  it('no duplica la petición al abrir la app', async () => {
    const fetchMock = stubFetch()

    render(
      <ThemeProvider>
        <App />
      </ThemeProvider>
    )
    await waitFor(() => expect(screen.getByText('web-app')).toBeInTheDocument())

    // La pestaña de contenedores es la inicial, así que el refresco al activar no
    // puede disparar una segunda petición: el efecto de montaje ya la hizo.
    expect(contarContenedores(fetchMock)).toBe(1)
  })

  it('no vuelve a pedir contenedores al cambiar a otra pestaña', async () => {
    const fetchMock = stubFetch()

    render(
      <ThemeProvider>
        <App />
      </ThemeProvider>
    )
    await waitFor(() => expect(screen.getByText('web-app')).toBeInTheDocument())
    const antes = contarContenedores(fetchMock)

    fireEvent.click(screen.getByRole('button', { name: /imágenes/i }))

    await waitFor(() => expect(screen.getByText(/nginx:alpine/)).toBeInTheDocument())
    expect(contarContenedores(fetchMock)).toBe(antes)
  })

  it('los contadores de los filtros no cambian al cambiar de filtro', async () => {
    stubFetchRespetandoFiltro()
    render(
      <ThemeProvider>
        <App />
      </ThemeProvider>
    )
    await waitFor(() => expect(screen.getByText('web-a')).toBeInTheDocument())

    // Con "Todos" seleccionado salen 4 / 2 / 1 / 1.
    // El boton tiene dos <span> contiguos, asi que su nombre accesible es
    // "Todos4", sin espacio. Se separa con la expresion regular.
    const leer = () =>
      screen.getAllByRole('button').flatMap((b) => {
        const m = /^(Todos|Activos|Detenidos|Pausados)(\d+)$/.exec(
          (b.textContent ?? '').replace(/\s+/g, '')
        )
        return m ? [`${m[1]} ${m[2]}`] : []
      })

    const conTodos = leer()
    expect(conTodos).toEqual(['Todos 4', 'Activos 2', 'Detenidos 1', 'Pausados 1'])

    // Al filtrar por Activos, el listado se reduce, pero los contadores no: son
    // un censo del host, no un recuento de lo que se está viendo.
    fireEvent.click(screen.getByRole('button', { name: /^activos/i }))
    await waitFor(() => expect(screen.queryByText('viejo')).toBeNull())
    expect(leer()).toEqual(conTodos)

    fireEvent.click(screen.getByRole('button', { name: /^detenidos/i }))
    await waitFor(() => expect(screen.getByText('viejo')).toBeInTheDocument())
    expect(leer()).toEqual(conTodos)

    fireEvent.click(screen.getByRole('button', { name: /^pausados/i }))
    await waitFor(() => expect(screen.getByText('en-pausa')).toBeInTheDocument())
    expect(leer()).toEqual(conTodos)
  })

  it('filtrar por estado ya no vuelve a pedir la lista al servidor', async () => {
    const fetchMock = stubFetchRespetandoFiltro()
    render(
      <ThemeProvider>
        <App />
      </ThemeProvider>
    )
    await waitFor(() => expect(screen.getByText('web-a')).toBeInTheDocument())
    const antes = contarContenedores(fetchMock)

    fireEvent.click(screen.getByRole('button', { name: /^activos/i }))
    await waitFor(() => expect(screen.queryByText('viejo')).toBeNull())

    // El panel se descarga el host entero una vez y filtra en el navegador. Antes
    // cada clic en un filtro era una ida y vuelta al backend.
    expect(contarContenedores(fetchMock)).toBe(antes)
  })

  it('abre la ayuda desde el navbar y la cierra sin salir de la app', async () => {
    render(
      <ThemeProvider>
        <App />
      </ThemeProvider>
    )

    await waitFor(() => expect(screen.getByText('web-app')).toBeInTheDocument())
    expect(screen.queryByRole('dialog', { name: /ayuda/i })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Abrir la ayuda' }))

    const ayuda = await screen.findByRole('dialog', { name: /ayuda/i })
    expect(within(ayuda).getByText(/no tiene autenticación/i)).toBeInTheDocument()

    fireEvent.click(within(ayuda).getByRole('button', { name: 'Cerrar ayuda' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /ayuda/i })).toBeNull())

    // La app sigue montada detrás: la ayuda no ha navegado a otra vista
    expect(screen.getByText('web-app')).toBeInTheDocument()
  })

  it('acota la franja de resumen al mismo ancho que el contenido', async () => {
    render(
      <ThemeProvider>
        <App />
      </ThemeProvider>
    )

    // La barra y el contenido deben compartir la columna centrada; si la barra
    // queda fuera, ocupa todo el ancho de la pagina y desentona.
    const barra = await screen.findByTestId('system-summary')
    const contenedor = barra.parentElement as HTMLElement
    const main = document.querySelector('main') as HTMLElement

    for (const clase of ['max-w-7xl', 'mx-auto', 'w-full']) {
      expect(contenedor.className).toContain(clase)
      expect(main.className).toContain(clase)
    }
  })

  it('muestra los filtros y el buscador en la pestaña de contenedores', async () => {
    render(
      <ThemeProvider>
        <App />
      </ThemeProvider>
    )

    await waitFor(() => expect(screen.getByText('web-app')).toBeInTheDocument())

    expect(screen.getByRole('button', { name: /Todos/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Activos/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Detenidos/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Pausados/ })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Buscar por nombre, imagen o ID...')).toBeInTheDocument()
  })

  it('oculta los filtros de contenedores al cambiar a la pestaña de imágenes', async () => {
    render(
      <ThemeProvider>
        <App />
      </ThemeProvider>
    )
    await waitFor(() => expect(screen.getByText('web-app')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Imágenes' }))

    await waitFor(() => expect(screen.getByText('nginx:alpine')).toBeInTheDocument())

    // Los filtros por estado son de contenedores: no deben aparecer aquí
    expect(screen.queryByRole('button', { name: /Activos/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Detenidos/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Pausados/ })).not.toBeInTheDocument()
    // Tampoco el buscador, que filtra por nombre/imagen/ID de contenedor
    expect(
      screen.queryByPlaceholderText('Buscar por nombre, imagen o ID...')
    ).not.toBeInTheDocument()
  })

  it('recupera los filtros al volver a la pestaña de contenedores', async () => {
    render(
      <ThemeProvider>
        <App />
      </ThemeProvider>
    )
    await waitFor(() => expect(screen.getByText('web-app')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Imágenes' }))
    await waitFor(() => expect(screen.getByText('nginx:alpine')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Contenedores' }))

    await waitFor(() => expect(screen.getByText('web-app')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Activos/ })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Buscar por nombre, imagen o ID...')).toBeInTheDocument()
  })
})

// --- SPEC-21: limpiar no rompe el censo -------------------------------------

describe('App · limpieza de contenedores parados', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    stubFetchRespetandoFiltro()
    // @ts-expect-error Mocking WebSocket
    global.WebSocket = MockWebSocket
    vi.stubGlobal('matchMedia', (query: string) => new MockMediaQueryList(query))
    localStorage.clear()
  })

  it('el botón de limpieza aparece en la barra de la pestaña de contenedores', async () => {
    render(
      <ThemeProvider>
        <App />
      </ThemeProvider>
    )
    await waitFor(() => expect(screen.getByText('web-a')).toBeInTheDocument())

    expect(screen.getByRole('button', { name: /limpiar parados/i })).toBeInTheDocument()
  })

  it('los contadores siguen siendo el censo del host, no lo que se está viendo', async () => {
    render(
      <ThemeProvider>
        <App />
      </ThemeProvider>
    )
    await waitFor(() => expect(screen.getByText('web-a')).toBeInTheDocument())

    const leer = () =>
      screen.getAllByRole('button').flatMap((b) => {
        const m = /^(Todos|Activos|Detenidos|Pausados)(\d+)$/.exec(
          (b.textContent ?? '').replace(/\s+/g, '')
        )
        return m ? [`${m[1]} ${m[2]}`] : []
      })

    const antes = leer()

    // Se filtra a Activos y luego se vuelve a Todos: los contadores no se mueven
    // en ninguno de los dos sentidos. La limpieza llama a `refetch`, que relee
    // la lista entera, y por eso este caso es el que importa: si el refetch
    // respetara el filtro, el censo se quedaría corto después de limpiar.
    fireEvent.click(screen.getByRole('button', { name: /^activos/i }))
    await waitFor(() => expect(contarContenedores(vi.mocked(global.fetch))).toBeGreaterThan(0))
    expect(leer()).toEqual(antes)

    fireEvent.click(screen.getByRole('button', { name: /^todos/i }))
    await waitFor(() => expect(screen.getByText('web-a')).toBeInTheDocument())
    expect(leer()).toEqual(antes)
  })
})
