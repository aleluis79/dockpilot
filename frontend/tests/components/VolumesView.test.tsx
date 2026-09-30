import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { VolumesView } from '../../src/components/volumes/VolumesView'
import type { VolumeSummary } from '../../src/types/volume'

const datosApp: VolumeSummary = {
  name: 'datos-app',
  driver: 'local',
  mountpoint: '/var/lib/docker/volumes/datos-app/_data',
  scope: 'local',
  created_at: '2026-09-20T10:00:00-03:00',
  size: 104857600,
  ref_count: 1,
  is_anonymous: false,
  labels: {},
}

const anonimo: VolumeSummary = {
  name: 'aa342f746404c4a57823f40a9bccdc6cc78a2520701d2507f050b5aa5dcc9c09',
  driver: 'local',
  mountpoint: '/var/lib/docker/volumes/aa34/_data',
  scope: 'local',
  created_at: '2026-09-22T09:15:00-03:00',
  size: 48505107,
  ref_count: 0,
  is_anonymous: true,
  labels: {},
}

const temporal: VolumeSummary = {
  name: 'temporal',
  driver: 'local',
  mountpoint: '/var/lib/docker/volumes/temporal/_data',
  scope: 'local',
  created_at: '2026-09-21T11:30:00-03:00',
  size: 5242880,
  ref_count: 0,
  is_anonymous: false,
  labels: {},
}

const ALL = [datosApp, anonimo, temporal]

const UNUSED_SUMMARY = { count: 2, bytes: 53747987, names: ['temporal', 'aa34…'] }

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

const stubApi = (
  volumes: VolumeSummary[] = ALL,
  unused = UNUSED_SUMMARY,
  pruneResult?: unknown
) => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url)
    if (target.includes('/volumes/prune') && init?.method === 'POST') {
      return {
        ok: true,
        status: 200,
        json: async () =>
          pruneResult ?? {
            deleted: ['temporal'],
            bytes_reclaimed: 53747987,
            message: 'Se liberó 1 volumen (temporal)',
          },
      } as unknown as Response
    }
    if (target.includes('/volumes/prune')) {
      return { ok: true, status: 200, json: async () => unused } as unknown as Response
    }
    return { ok: true, status: 200, json: async () => volumes } as unknown as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('VolumesView', () => {
  const originalWebSocket = global.WebSocket

  beforeEach(() => {
    MockWebSocket.instances = []
    // @ts-expect-error Mocking WebSocket
    global.WebSocket = MockWebSocket
  })

  afterEach(() => {
    global.WebSocket = originalWebSocket
    vi.unstubAllGlobals()
  })

  const renderView = (volumes: VolumeSummary[] = ALL, unused = UNUSED_SUMMARY) => {
    const fetchMock = stubApi(volumes, unused)
    const onDeleted = vi.fn()
    const utils = render(<VolumesView onDeleted={onDeleted} />)
    return { ...utils, fetchMock, onDeleted }
  }

  const search = (value: string) =>
    fireEvent.change(screen.getByLabelText('Buscar volúmenes'), { target: { value } })

  it('lista los volúmenes del host', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('datos-app')).toBeInTheDocument())

    expect(screen.getByText('temporal')).toBeInTheDocument()
    expect(screen.getByText('En uso (1)')).toBeInTheDocument()
  })

  it('muestra el espacio recuperable antes de limpiar', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('datos-app')).toBeInTheDocument())

    // 48505107 + 5242880 = 53747987 bytes
    expect(screen.getByText('51.3 MB recuperables')).toBeInTheDocument()
    expect(screen.getByText('2 volúmenes sin uso')).toBeInTheDocument()
  })

  it('filtra por volúmenes en uso', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('datos-app')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /En uso/ }))

    expect(screen.getByText('datos-app')).toBeInTheDocument()
    expect(screen.queryByText('temporal')).not.toBeInTheDocument()
    expect(screen.queryByText(/^aa342f746404/)).not.toBeInTheDocument()
  })

  it('filtra por volúmenes no usados', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('datos-app')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /No usados/ }))

    expect(screen.queryByText('datos-app')).not.toBeInTheDocument()
    expect(screen.getByText('temporal')).toBeInTheDocument()
  })

  it('filtra por volúmenes anónimos', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('datos-app')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /Anónimos/ }))

    expect(screen.getByText(/^aa342f746404/)).toBeInTheDocument()
    expect(screen.queryByText('datos-app')).not.toBeInTheDocument()
    expect(screen.queryByText('temporal')).not.toBeInTheDocument()
  })

  it('busca por nombre', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('datos-app')).toBeInTheDocument())

    search('temp')

    expect(screen.getByText('temporal')).toBeInTheDocument()
    expect(screen.queryByText('datos-app')).not.toBeInTheDocument()
  })

  it('el diálogo de limpieza dice cuántos volúmenes y bytes se van a liberar', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('datos-app')).toBeInTheDocument())

    fireEvent.click(screen.getByTitle('Limpiar volúmenes no usados'))

    const dialog = within(screen.getByRole('dialog', { name: 'Limpiar volúmenes no usados' }))
    expect(dialog.getByText(/2 volúmenes/)).toBeInTheDocument()
    expect(dialog.getByText('51.3 MB')).toBeInTheDocument()
    expect(dialog.getByText(/irreversible/)).toBeInTheDocument()
  })

  it('cancelar la limpieza no borra nada', async () => {
    const { fetchMock } = renderView()
    await waitFor(() => expect(screen.getByText('datos-app')).toBeInTheDocument())

    fireEvent.click(screen.getByTitle('Limpiar volúmenes no usados'))
    fireEvent.click(screen.getByTitle('Cancelar limpieza de volúmenes'))

    const pruneCalls = fetchMock.mock.calls.filter(
      ([url, init]) => String(url).includes('/volumes/prune') && (init as RequestInit)?.method === 'POST'
    )
    expect(pruneCalls).toHaveLength(0)
  })

  it('confirma la limpieza y ejecuta el prune', async () => {
    const { fetchMock, onDeleted } = renderView()
    await waitFor(() => expect(screen.getByText('datos-app')).toBeInTheDocument())

    fireEvent.click(screen.getByTitle('Limpiar volúmenes no usados'))
    fireEvent.click(screen.getByTitle('Confirmar limpieza de volúmenes'))

    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
    const pruneCalls = fetchMock.mock.calls.filter(
      ([url, init]) => String(url).includes('/volumes/prune') && (init as RequestInit)?.method === 'POST'
    )
    expect(pruneCalls).toHaveLength(1)
  })

  it('avisa de los volúmenes anónimos que se van a perder de forma irreversible', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('datos-app')).toBeInTheDocument())

    fireEvent.click(screen.getByTitle('Eliminar el volumen ' + anonimo.name))

    const dialog = within(screen.getByRole('dialog', { name: 'Eliminar volumen' }))
    expect(dialog.getByText(/Es un volumen/)).toBeInTheDocument()
    expect(dialog.getByText(/no se puede recuperar/i)).toBeInTheDocument()
  })
})

// --- Uso desconocido ------------------------------------------------------------

describe('VolumesView con uso desconocido', () => {
  const originalFetch = global.fetch

  const sinUso: VolumeSummary = {
    name: 'montaje-oscuro',
    driver: 'local',
    mountpoint: '/var/lib/docker/volumes/montaje-oscuro/_data',
    scope: 'local',
    created_at: '2026-09-23T10:00:00-03:00',
    size: 1073741824,
    // El daemon no respondió a /system/df: `ref_count` sale a 0 por defecto,
    // pero eso NO significa que el volumen esté libre.
    ref_count: 0,
    usage_known: false,
    is_anonymous: false,
    labels: {},
  }

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/api/v1/volumes')) {
          return new Response(JSON.stringify([sinUso]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return new Response('{}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      })
    )
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.unstubAllGlobals()
  })

  it('no mete un volumen sin dato de uso en «No usados»', async () => {
    render(<VolumesView onDeleted={() => {}} />)
    await waitFor(() => expect(screen.getByText('montaje-oscuro')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /No usados/ }))

    expect(screen.queryByText('montaje-oscuro')).not.toBeInTheDocument()
  })

  it('lo trata como ocupado en el diálogo de borrado', async () => {
    render(<VolumesView onDeleted={() => {}} />)
    await waitFor(() => expect(screen.getByText('montaje-oscuro')).toBeInTheDocument())

    fireEvent.click(screen.getByTitle('Eliminar el volumen ' + sinUso.name))

    const dialog = within(screen.getByRole('dialog', { name: 'Eliminar volumen' }))
    await waitFor(() =>
      expect(dialog.getByText(/no informó del uso de este volumen/i)).toBeInTheDocument()
    )
    expect(dialog.queryByText(/contenedores? lo está usando/i)).not.toBeInTheDocument()
  })
})
