import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { NetworksView } from '../../src/components/networks/NetworksView'
import { NetworkDetailModal } from '../../src/components/networks/NetworkDetailModal'
import { CreateNetworkModal } from '../../src/components/networks/CreateNetworkModal'
import type { NetworkSummary, NetworkDetail } from '../../src/types/network'

const BUILTIN_ID = 'aaaa1111'
const CUSTOM_ID = 'bbbb2222'
const ORPHAN_ID = 'cccc3333'

const redes: NetworkSummary[] = [
  {
    id: BUILTIN_ID, name: 'bridge', driver: 'bridge', scope: 'local', internal: false,
    attachable: false, enable_ipv6: false, created: '2026-06-07T09:34:28.089537938-03:00',
    subnets: [{ subnet: '172.17.0.0/16', gateway: '172.17.0.1' }], container_count: 2, is_builtin: true,
  },
  {
    id: CUSTOM_ID, name: 'app-net', driver: 'bridge', scope: 'local', internal: false,
    attachable: true, enable_ipv6: false, created: '2026-07-01T10:00:00.000000000-03:00',
    subnets: [{ subnet: '172.18.0.0/16', gateway: '172.18.0.1' }], container_count: 1, is_builtin: false,
  },
  {
    id: ORPHAN_ID, name: 'huerfana', driver: 'bridge', scope: 'local', internal: true,
    attachable: false, enable_ipv6: false, created: '2026-08-15T18:20:00.000000000-03:00',
    subnets: [{ subnet: '172.19.0.0/16', gateway: '172.19.0.1' }], container_count: 0, is_builtin: false,
  },
]

const detalle: NetworkDetail = {
  ...redes[1],
  options: { 'com.docker.network.bridge.default_bridge': 'true' },
  labels: { 'com.docker.compose.project': 'app' },
  containers: ['web-app', 'api'],
}

type Rutas = { [clave: string]: unknown }

/**
 * Fila de una red por su nombre.
 *
 * Hace falta porque `bridge` aparece a la vez como nombre y como driver, y
 * varias filas tienen boton de eliminar: sin acotar, los selectores son
 * ambiguos.
 */
const fila = (nombre: string): HTMLElement => {
  // `queryAllByText` y no `getAllByText`: este ultimo lanza si hay mas de una
  // coincidencia, y `bridge` es a la vez nombre de red y driver de otra fila.
  const celda = screen
    .queryAllByText(nombre)
    .find((el) => el.closest('tr') !== null && el.tagName === 'BUTTON')
  if (!celda) throw new Error(`No se encontro la fila de ${nombre}`)
  return celda.closest('tr') as HTMLElement
}

/**
 * Nombres de las redes visibles. Es la forma fiable de comprobar filtros: el
 * nombre accesible de una fila incluye el driver, asi que `bridge` como
 * patron tambien casaria con la fila de `app-net`.
 */
const nombresVisibles = (): string[] =>
  screen
    .queryAllByRole('button')
    // El boton de eliminar solo tiene aria-label, asi que se filtra por texto
    .filter((b) => b.closest('tr') !== null && (b.textContent ?? '').trim() !== '')
    .map((b) => (b.textContent ?? '').trim())
    // El daemon no garantiza orden, asi que se compara sin importar
    .sort()

function stubFetch(extra: Rutas = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    // Se quita el query string: el borrado llega como `?force=false`
    const ruta = String(url).replace('/api/v1', '').split('?')[0]
    const metodo = init?.method ?? 'GET'

    // `extra` manda sobre las rutas por defecto, para poder inyectar fallos
    if (ruta in extra) return extra[ruta]

    if (metodo === 'DELETE' && ruta === '/networks/huerfana') {
      return { ok: true, status: 200, json: async () => ({ name: 'huerfana', deleted: true, message: 'Red eliminada' }) }
    }
    if (metodo === 'POST' && ruta === '/networks/prune') {
      return { ok: true, status: 200, json: async () => ({ deleted: ['huerfana'], message: '1 red eliminada' }) }
    }
    if (metodo === 'POST' && ruta === '/networks') {
      return { ok: true, status: 201, json: async () => ({ ...detalle, name: 'nueva', subnets: [{ subnet: '172.20.0.0/16', gateway: '' }] }) }
    }
    if (ruta === '/networks' && metodo === 'GET') {
      return { ok: true, status: 200, json: async () => redes }
    }
    if (ruta.startsWith('/networks/')) {
      const nombre = ruta.replace('/networks/', '')
      const base = redes.find((r) => r.name === nombre) ?? redes[1]
      return { ok: true, status: 200, json: async () => ({ ...detalle, ...base }) }
    }
    return { ok: true, status: 200, json: async () => [] }
  })
}

describe('NetworksView', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.restoreAllMocks())

  it('lista las redes con su recuento y subred', async () => {
    vi.stubGlobal('fetch', stubFetch())
    render(<NetworksView />)

    await waitFor(() => expect(screen.getByText('app-net')).toBeInTheDocument())
    expect(within(fila('huerfana')).getByText('huerfana')).toBeInTheDocument()
    expect(within(fila('bridge')).getByText('172.17.0.0/16')).toBeInTheDocument()
    expect(within(fila('app-net')).getByText('172.18.0.0/16')).toBeInTheDocument()
  })

  it('muestra los contadores de redes y de las que están en uso', async () => {
    vi.stubGlobal('fetch', stubFetch())
    render(<NetworksView />)

    await waitFor(() => expect(screen.getByText('app-net')).toBeInTheDocument())
    expect(screen.getByText(/3 redes/)).toBeInTheDocument()
    expect(screen.getByText(/2 en uso/)).toBeInTheDocument()
  })

  it('filtra por redes en uso', async () => {
    vi.stubGlobal('fetch', stubFetch())
    render(<NetworksView />)

    await waitFor(() => expect(screen.getByText('app-net')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /^En uso/ }))

    // app-net y bridge tienen contenedores; huerfana no
    await waitFor(() => expect(nombresVisibles()).toEqual(['app-net', 'bridge'].sort()))
  })

  it('filtra por redes no usadas', async () => {
    vi.stubGlobal('fetch', stubFetch())
    render(<NetworksView />)

    await waitFor(() => expect(screen.getByText('huerfana')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /^No usadas/ }))

    // huerfana es la unica sin contenedores
    await waitFor(() => expect(nombresVisibles()).toEqual(['huerfana']))
  })

  it('filtra por redes predefinidas', async () => {
    vi.stubGlobal('fetch', stubFetch())
    render(<NetworksView />)

    await waitFor(() => expect(nombresVisibles()).toEqual(['app-net', 'bridge', 'huerfana'].sort()))
    fireEvent.click(screen.getByRole('button', { name: /^Predefinidas/ }))

    await waitFor(() => expect(nombresVisibles()).toEqual(['bridge']))
    // La unica predefinida visible es bridge
    expect(within(fila('bridge')).getByText('predefinida')).toBeInTheDocument()
  })

  it('busca por nombre', async () => {
    vi.stubGlobal('fetch', stubFetch())
    render(<NetworksView />)

    await waitFor(() => expect(screen.getByText('app-net')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Buscar redes'), { target: { value: 'huerf' } })

    await waitFor(() => expect(nombresVisibles()).toEqual(['huerfana']))
  })

  it('no ofrece borrar una red predefinida', async () => {
    vi.stubGlobal('fetch', stubFetch())
    render(<NetworksView />)

    await waitFor(() => expect(nombresVisibles()).toContain('bridge'))
    const objetivo = fila('bridge')

    expect(within(objetivo).getByText('predefinida')).toBeInTheDocument()
    expect(within(objetivo).queryByRole('button', { name: /eliminar/i })).toBeNull()
    expect(within(objetivo).getByText(/no se puede eliminar/i)).toBeInTheDocument()
  })

  it('sí ofrece borrar una red propia sin contenedores', async () => {
    vi.stubGlobal('fetch', stubFetch())
    render(<NetworksView />)

    await waitFor(() => expect(nombresVisibles()).toContain('huerfana'))
    expect(screen.getByRole('button', { name: 'Eliminar red huerfana' })).toBeInTheDocument()
  })

  it('pide confirmación antes de eliminar y llama a la API', async () => {
    const fetchMock = stubFetch()
    vi.stubGlobal('fetch', fetchMock)
    render(<NetworksView />)

    await waitFor(() => expect(nombresVisibles()).toContain('huerfana'))
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar red huerfana' }))

    const dialogo = await screen.findByRole('dialog')
    expect(within(dialogo).getByText(/huerfana/)).toBeInTheDocument()

    // Nada se ha enviado todavia
    expect(fetchMock.mock.calls.filter(([, i]) => (i as RequestInit)?.method === 'DELETE')).toHaveLength(0)

    fireEvent.click(within(dialogo).getByRole('button', { name: /^eliminar$/i }))

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u, i]) => String(u).includes('/networks/huerfana') && (i as RequestInit)?.method === 'DELETE')).toBe(true)
    )
  })

  it('permite cancelar la eliminación sin llamar a la API', async () => {
    const fetchMock = stubFetch()
    vi.stubGlobal('fetch', fetchMock)
    render(<NetworksView />)

    await waitFor(() => expect(nombresVisibles()).toContain('huerfana'))
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar red huerfana' }))

    const dialogo = await screen.findByRole('dialog')
    fireEvent.click(within(dialogo).getByRole('button', { name: /cancelar/i }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(nombresVisibles()).toContain('huerfana')
    expect(fetchMock.mock.calls.filter(([, i]) => (i as RequestInit)?.method === 'DELETE')).toHaveLength(0)
  })

  it('explica cuántas redes se limpiarían antes de hacerlo', async () => {
    vi.stubGlobal('fetch', stubFetch())
    render(<NetworksView />)

    await waitFor(() => expect(screen.getByText('huerfana')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /limpiar sin uso/i }))

    const dialogo = await screen.findByRole('dialog')
    // 3 redes - 2 en uso = 1 sin uso
    expect(within(dialogo).getByText(/1 red/)).toBeInTheDocument()
  })

  it('crea una red con subred opcional', async () => {
    const fetchMock = stubFetch()
    vi.stubGlobal('fetch', fetchMock)
    render(<NetworksView />)

    await waitFor(() => expect(screen.getByText('app-net')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /crear red/i }))

    const dialogo = await screen.findByRole('dialog')
    fireEvent.change(within(dialogo).getByLabelText('Nombre de la red'), { target: { value: 'nueva' } })
    fireEvent.change(within(dialogo).getByLabelText('Subred (CIDR)'), { target: { value: '172.20.0.0/16' } })
    fireEvent.click(within(dialogo).getByRole('button', { name: /crear/i }))

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u, i]) => String(u).endsWith('/networks') && (i as RequestInit)?.method === 'POST')).toBe(true)
    )
    const cuerpo = fetchMock.mock.calls
      .filter(([u, i]) => String(u).endsWith('/networks') && (i as RequestInit)?.method === 'POST')
      .map(([, i]) => JSON.parse((i as RequestInit).body as string))[0]
    expect(cuerpo.name).toBe('nueva')
    expect(cuerpo.subnet).toBe('172.20.0.0/16')
  })

  it('refresca el inventario despues de crear una red', async () => {
    const fetchMock = stubFetch()
    vi.stubGlobal('fetch', fetchMock)
    render(<NetworksView />)

    await waitFor(() => expect(nombresVisibles()).toContain('app-net'))
    const antes = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/networks') && !(u as RequestInit)?.method).length

    fireEvent.click(screen.getByRole('button', { name: /crear red/i }))
    const dialogo = await screen.findByRole('dialog')
    fireEvent.change(within(dialogo).getByLabelText('Nombre de la red'), { target: { value: 'nueva' } })
    fireEvent.click(within(dialogo).getByRole('button', { name: /^crear$/i }))

    // Sin este refresco, la red creada no apareceria hasta recargar a mano
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([u, i]) => String(u).endsWith('/networks') && !(i as RequestInit)?.method
        ).length
      ).toBeGreaterThan(antes)
    )
  })

  it('explica que sin subred Docker asigna la siguiente libre', async () => {
    vi.stubGlobal('fetch', stubFetch())
    render(<NetworksView />)

    await waitFor(() => expect(screen.getByText('app-net')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /crear red/i }))

    const dialogo = await screen.findByRole('dialog')
    expect(within(dialogo).getByText(/siguiente subred libre/i)).toBeInTheDocument()
  })

  it('muestra el error del daemon al intentar borrar una predefinida', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch({
        '/networks/huerfana': {
          ok: false, status: 400, json: async () => ({ detail: "La red 'bridge' es una red predefinida" }),
        },
      })
    )
    render(<NetworksView />)

    await waitFor(() => expect(nombresVisibles()).toContain('huerfana'))
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar red huerfana' }))
    const dialogo = await screen.findByRole('dialog')
    fireEvent.click(within(dialogo).getByRole('button', { name: /^eliminar$/i }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/predefinida/))
  })
})

describe('NetworkDetailModal', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('muestra IPAM, opciones, etiquetas y contenedores', async () => {
    vi.stubGlobal('fetch', stubFetch())
    render(<NetworkDetailModal name="app-net" onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('app-net')).toBeInTheDocument())
    expect(screen.getByText('172.18.0.0/16')).toBeInTheDocument()
    expect(screen.getByText('172.18.0.1')).toBeInTheDocument()
    expect(screen.getByText('com.docker.compose.project')).toBeInTheDocument()
    expect(screen.getByText('web-app')).toBeInTheDocument()
    expect(screen.getByText('api')).toBeInTheDocument()
  })

  it('indica los indicadores de la red', async () => {
    vi.stubGlobal('fetch', stubFetch())
    render(<NetworkDetailModal name="app-net" onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('app-net')).toBeInTheDocument())
    expect(screen.getByText(/adjuntable/i)).toBeInTheDocument()
  })

  it('no afirma que se pueda borrar si tiene contenedores', async () => {
    vi.stubGlobal('fetch', stubFetch())
    render(<NetworkDetailModal name="app-net" onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('web-app')).toBeInTheDocument())
    // El mensaje de "se puede eliminar sin forzar" solo aparece si no hay contenedores
    expect(screen.queryByText(/^Ninguno: se puede eliminar sin forzar/)).toBeNull()
    expect(screen.getByText(/no se puede eliminar sin forzar/i)).toBeInTheDocument()
  })

  it('avisa cuando la red no tiene subred asignada', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ...detalle, subnets: [] }) }))
    )
    render(<NetworkDetailModal name="host" onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(/sin subred/i)).toBeInTheDocument())
  })
})

describe('CreateNetworkModal', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('no envía puerta de enlace sin subred', async () => {
    const onClose = vi.fn()
    render(<CreateNetworkModal onClose={onClose} onCreate={vi.fn()} onCreated={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Nombre de la red'), { target: { value: 'nueva' } })
    fireEvent.change(screen.getByLabelText('Puerta de enlace'), { target: { value: '172.20.0.1' } })
    fireEvent.click(screen.getByRole('button', { name: /crear/i }))

    // Sin subred no tiene sentido: se explica en vez de enviarlo
    const alerta = await screen.findByRole('alert')
    expect(alerta).toHaveTextContent(/subred/i)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('exige un nombre', async () => {
    render(<CreateNetworkModal onClose={vi.fn()} onCreate={vi.fn()} onCreated={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /crear/i }))

    const alerta = await screen.findByRole('alert')
    expect(alerta).toHaveTextContent(/nombre/i)
  })
})
