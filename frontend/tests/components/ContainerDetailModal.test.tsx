import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
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
// --- Renombrar (SPEC-19) -------------------------------------------------------

describe('ContainerDetailModal: renombrar', () => {
  const nombres: string[] = []
  let CALLS: string[] = []

  const stubOk = (payload: unknown = base) => {
    CALLS = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      CALLS.push(`${init?.method ?? 'GET'} ${url}`)
      const cuerpo = init?.body ? JSON.parse(String(init.body)) : null
      if (String(url).includes('/rename')) {
        return new Response(
          JSON.stringify({
            id: 'c123',
            old_name: 'web-app',
            new_name: cuerpo.name,
            message: `Contenedor renombrado a '${cuerpo.name}'`,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  const abrir = async (detalle = base, otrosNombres: string[] = []) => {
    stubOk(detalle)
    render(
      <ContainerDetailModal
        container={CONTENEDOR}
        onClose={vi.fn()}
        otrosNombres={otrosNombres}
      />
    )
    await waitFor(() => expect(screen.getByText('nginx:alpine')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /renombrar/i }))
  }

  const campo = () => screen.getByLabelText(/nombre nuevo/i) as HTMLInputElement
  const confirmar = () => screen.getByRole('button', { name: /^renombrar$/i })
  const renombrados = () => CALLS.filter((c) => c.includes('/rename'))

  beforeEach(() => {
    nombres.length = 0
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('el botón está en el detalle', async () => {
    stubOk()
    render(<ContainerDetailModal container={CONTENEDOR} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('nginx:alpine')).toBeInTheDocument())

    expect(screen.getByRole('button', { name: /renombrar/i })).toBeInTheDocument()
  })

  it('el nombre inválido no llama al backend', async () => {
    await abrir()

    // Con un solo carácter: el daemon lo rechaza y el validador de REDES del
    // proyecto lo aceptaría (`*` en vez de `+`).
    fireEvent.change(campo(), { target: { value: 'x' } })
    expect(screen.getByText(/al menos dos caracteres/i)).toBeInTheDocument()
    expect(confirmar()).toBeDisabled()

    fireEvent.change(campo(), { target: { value: 'mi web' } })
    expect(screen.getByText(/espacios/i)).toBeInTheDocument()

    fireEvent.change(campo(), { target: { value: 'a'.repeat(64) } })
    expect(screen.getByText(/63/)).toBeInTheDocument()

    expect(renombrados()).toHaveLength(0)
  })

  it('avisa si el nombre ya está en el inventario, sin ir al daemon', async () => {
    // El panel ya tiene la lista de contenedores cargada: sabe que "otro"
    // existe. Preguntárselo al daemon sería un viaje por algo que ya se sabe.
    await abrir({ ...base, name: 'otro' }, ['otro', 'otro-2'])

    fireEvent.change(campo(), { target: { value: 'otro' } })

    expect(screen.getByText(/ya existe un contenedor llamado/i)).toBeInTheDocument()
    expect(confirmar()).toBeDisabled()
    expect(renombrados()).toHaveLength(0)
  })

  it('el nombre igual al actual no se envía', async () => {
    await abrir({ ...base, name: 'web-app' })

    fireEvent.change(campo(), { target: { value: 'web-app' } })

    expect(screen.getByText(/no ha cambiado|no es distinto/i)).toBeInTheDocument()
    expect(renombrados()).toHaveLength(0)
  })

  it('avisa de que el nombre viejo deja de resolver en red propia', async () => {
    await abrir({ ...base, networks: ['bridge', 'mi-red'] })

    // El aviso sólo aparece cuando el nombre cambia: avisar de un renombrado que
    // el usuario todavía no ha escrito sería gritar por nada.
    expect(screen.queryByText(/dejará de resolver/i)).not.toBeInTheDocument()

    fireEvent.change(campo(), { target: { value: 'api-gateway' } })

    const aviso = within(screen.getByTestId('rename-modal'))
    expect(aviso.getByText(/dejará de resolver/i)).toBeInTheDocument()
    expect(aviso.getByText('mi-red')).toBeInTheDocument()
  })

  it('no avisa de DNS si sólo está en la red por defecto', async () => {
    await abrir({ ...base, networks: ['bridge'] })
    fireEvent.change(campo(), { target: { value: 'api-gateway' } })

    // `NetworkMode` diría `bridge` también en el caso de arriba, así que el
    // aviso tiene que salir del conjunto de redes y no de un solo campo.
    expect(screen.queryByText(/dejará de resolver/i)).not.toBeInTheDocument()
  })

  it('renombra y muestra el nombre nuevo en el detalle', async () => {
    await abrir()

    fireEvent.change(campo(), { target: { value: 'api-gateway' } })
    fireEvent.click(confirmar())

    await waitFor(() => expect(renombrados()).toHaveLength(1))
    expect(renombrados()[0]).toContain('POST')
    expect(renombrados()[0]).toContain('/api/v1/containers/c123/rename')

    // Al terminar, el diálogo se cierra y la cabecera del detalle queda con el
    // nombre nuevo. El id no ha cambiado, así que no hace falta recargar nada más.
    await waitFor(() =>
      expect(screen.queryByTestId('rename-modal')).not.toBeInTheDocument()
    )
    expect(
      screen.getByRole('heading', { name: 'api-gateway' }),
      'la cabecera debe mostrar el nombre nuevo'
    ).toBeInTheDocument()
  })
})
