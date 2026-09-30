import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { ContainerDetailModal } from '../../src/components/containers/ContainerDetailModal'
import type { ContainerDetail } from '../../src/types/docker'

const base: ContainerDetail = {
  id: 'c123',
  name: 'web-app',
  image: 'nginx:alpine',
  status: 'running',
  state: 'running',
  created: 1727290000,
  ports: [],
  env: [],
  labels: {},
  mounts: [],
  networks: [],
}

const CONTENEDOR = { id: 'c123', name: 'web-app', image: 'nginx:alpine', status: 'running' }

const unhealthy: ContainerDetail = {
  ...base,
  health: {
    status: 'unhealthy',
    failing_streak: 3,
    test: ['CMD-SHELL', 'pg_isready -U postgres'],
    log: [
      {
        started_at: '2026-09-30T18:40:00.069196549-03:00',
        finished_at: '2026-09-30T18:40:00.09728021-03:00',
        exit_code: 1,
        output: 'pg_isready: connection refused',
      },
      {
        started_at: '2026-09-30T18:40:02.069196549-03:00',
        finished_at: '2026-09-30T18:40:02.09728021-03:00',
        exit_code: 1,
        output: 'pg_isready: connection refused',
      },
    ],
  },
}

const stubFetch = (payload: unknown) => {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('ContainerDetailModal: salud (SPEC-18)', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('responde al porqué: comando que se mide e historial de sondas', async () => {
    // "Está unhealthy" no es accionable. "Este healthcheck falla desde hace 20
    // minutos con exit 1" sí, y para eso hace falta el `Log` del inspect.
    stubFetch(unhealthy)
    render(<ContainerDetailModal container={CONTENEDOR} onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByTestId('salud-detalle')).toBeInTheDocument())

    const bloque = screen.getByTestId('salud-detalle')
    // `Config.Healthcheck.Test` viene como array y se pinta unido, porque el
    // prefijo `CMD-SHELL` forma parte del comando y no es decoración.
    expect(within(bloque).getByText(/CMD-SHELL pg_isready -U postgres/)).toBeInTheDocument()
    // Las dos sondas dicen lo mismo, que es justo lo habitual: hay dos.
    expect(within(bloque).getAllByText(/connection refused/)).toHaveLength(2)
    // El contador de fallos consecutivos, que es lo que dice "desde cuándo".
    expect(bloque).toHaveTextContent('3')
  })

  it('el historial se muestra de la sonda más antigua a la más reciente', async () => {
    stubFetch(unhealthy)
    render(<ContainerDetailModal container={CONTENEDOR} onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByTestId('salud-detalle')).toBeInTheDocument())

    const horas = screen
      .getAllByTestId(/^sonda-/)
      .map((el) => el.getAttribute('data-hora'))
    const orden = [...horas].sort()
    expect(horas, 'las sondas no vienen en orden cronológico').toEqual(orden)
  })

  it('un contenedor sin healthcheck no muestra bloque de salud', async () => {
    stubFetch({ ...base, health: { status: 'none', failing_streak: 0, log: [], test: [] } })
    render(<ContainerDetailModal container={CONTENEDOR} onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(/nginx:alpine/)).toBeInTheDocument())
    expect(screen.queryByTestId('salud-detalle')).not.toBeInTheDocument()
  })

  it('starting se explica sin pintarlo como fallo', async () => {
    stubFetch({
      ...base,
      health: { status: 'starting', failing_streak: 0, log: [], test: ['CMD', '/app/hc'] },
    })
    render(<ContainerDetailModal container={CONTENEDOR} onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByTestId('salud-detalle')).toBeInTheDocument())

    const bloque = screen.getByTestId('salud-detalle')
    expect(bloque).toHaveTextContent(/todavía|comprobando|iniciando/i)
    expect(bloque.className).not.toContain('rose')
  })
})