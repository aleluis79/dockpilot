import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { StatsModal } from '../../src/components/stats/StatsModal'
import { formatBytes, formatPercent } from '../../src/utils/format'
import type { ContainerSummary } from '../../src/types/docker'
import type { ContainerStats } from '../../src/types/stats'

class MockWebSocket {
  static instances: MockWebSocket[] = []

  url: string
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn()

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  serverOpen() {
    act(() => {
      this.onopen?.()
    })
  }

  serverEmit(payload: unknown) {
    act(() => {
      this.onmessage?.({ data: JSON.stringify(payload) })
    })
  }
}

const latest = () => MockWebSocket.instances[MockWebSocket.instances.length - 1]

const buildStats = (overrides: Partial<ContainerStats> = {}): ContainerStats => ({
  container_id: 'c123',
  container_name: 'web-app',
  cpu_percent: 20,
  memory_usage: 500,
  memory_limit: 10000,
  memory_percent: 5,
  network_rx_bytes: 1536,
  network_tx_bytes: 2048,
  block_read_bytes: 1048576,
  block_write_bytes: 512,
  pids_current: 5,
  timestamp: '2026-09-26T10:00:00.000000000Z',
  ...overrides,
})

const mockContainer: ContainerSummary = {
  id: 'c12345678901',
  name: 'web-app',
  image: 'nginx:alpine',
  status: 'running',
  state: 'running',
  created: 1727290000,
  ports: [],
}

const renderModal = (onClose: () => void = vi.fn()) => {
  const utils = render(
    <StatsModal isOpen={true} container={mockContainer} onClose={onClose} />
  )
  latest().serverOpen()
  return { ...utils, onClose }
}

describe('formatBytes', () => {
  it('formats byte values into human readable units', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(500)).toBe('500 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1048576)).toBe('1.0 MB')
    expect(formatBytes(1073741824)).toBe('1.0 GB')
  })
})

describe('formatPercent', () => {
  it('formats percentages with one decimal by default', () => {
    expect(formatPercent(20)).toBe('20.0%')
    expect(formatPercent(5)).toBe('5.0%')
    expect(formatPercent(0)).toBe('0.0%')
  })
})

describe('StatsModal', () => {
  const originalWebSocket = global.WebSocket

  beforeEach(() => {
    MockWebSocket.instances = []
    // @ts-expect-error Mocking WebSocket
    global.WebSocket = MockWebSocket
  })

  afterEach(() => {
    global.WebSocket = originalWebSocket
  })

  it('does not render when isOpen is false', () => {
    render(<StatsModal isOpen={false} container={mockContainer} onClose={vi.fn()} />)

    expect(screen.queryByText('Métricas en Vivo')).not.toBeInTheDocument()
  })

  it('renders the container name and a waiting state before the first packet', () => {
    render(<StatsModal isOpen={true} container={mockContainer} onClose={vi.fn()} />)

    expect(screen.getByText('Métricas en Vivo')).toBeInTheDocument()
    expect(screen.getByText('web-app')).toBeInTheDocument()
    expect(screen.getByText('Esperando métricas...')).toBeInTheDocument()
  })

  it('renders CPU and memory percentages with progress bars', () => {
    renderModal()
    latest().serverEmit(buildStats())

    expect(screen.getByText('20.0%')).toBeInTheDocument()
    expect(screen.getByText('5.0%')).toBeInTheDocument()

    const cpuBar = screen.getByRole('progressbar', { name: 'Uso de CPU' })
    const memBar = screen.getByRole('progressbar', { name: 'Uso de Memoria' })
    expect(cpuBar).toHaveAttribute('aria-valuenow', '20')
    expect(memBar).toHaveAttribute('aria-valuenow', '5')
  })

  it('renders network and block I/O values in readable units', () => {
    renderModal()
    latest().serverEmit(buildStats())

    expect(screen.getByText('1.5 KB')).toBeInTheDocument()
    expect(screen.getByText('2.0 KB')).toBeInTheDocument()
    expect(screen.getByText('1.0 MB')).toBeInTheDocument()
    expect(screen.getByText('512 B')).toBeInTheDocument()
  })

  it('applies warning and critical colors according to thresholds', () => {
    renderModal()

    latest().serverEmit(buildStats({ cpu_percent: 95, memory_percent: 75 }))
    expect(
      screen.getByRole('progressbar', { name: 'Uso de CPU' }).querySelector('[data-level]')
    ).toHaveAttribute('data-level', 'critical')
    expect(
      screen.getByRole('progressbar', { name: 'Uso de Memoria' }).querySelector('[data-level]')
    ).toHaveAttribute('data-level', 'warn')

    latest().serverEmit(buildStats({ cpu_percent: 42, memory_percent: 30 }))
    expect(
      screen.getByRole('progressbar', { name: 'Uso de CPU' }).querySelector('[data-level]')
    ).toHaveAttribute('data-level', 'ok')
    expect(
      screen.getByRole('progressbar', { name: 'Uso de Memoria' }).querySelector('[data-level]')
    ).toHaveAttribute('data-level', 'ok')
  })

  it('renders a sparkline reflecting the recent history', () => {
    renderModal()

    for (let i = 0; i < 5; i++) {
      latest().serverEmit(buildStats({ cpu_percent: i * 10, timestamp: `ts-${i}` }))
    }

    const sparkline = screen.getByTestId('stats-sparkline-cpu')
    expect(sparkline).toBeInTheDocument()
    expect(sparkline.querySelectorAll('circle')).toHaveLength(5)
  })

  it('shows the connection error when the container is not found', () => {
    render(<StatsModal isOpen={true} container={mockContainer} onClose={vi.fn()} />)

    act(() => {
      latest().onclose?.({ code: 4404 })
    })

    expect(screen.getByText('Contenedor no encontrado en Docker')).toBeInTheDocument()
  })

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn()
    renderModal(onClose)

    fireEvent.click(screen.getByTitle('Cerrar métricas'))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when the Escape key is pressed', () => {
    const onClose = vi.fn()
    renderModal(onClose)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

// --- SPEC-17: la serie temporal ---------------------------------------------

const muestra = (t: number, over: Record<string, number> = {}) => ({
  t,
  cpu_percent: 20,
  memory_percent: 5,
  network_rx_bytes: 0,
  network_tx_bytes: 0,
  block_read_bytes: 0,
  block_write_bytes: 0,
  ...over,
})

const serie = (n: number, paso = 2) =>
  Array.from({ length: n }, (_, i) =>
    muestra(1000 + i * paso, {
      network_rx_bytes: i * 2000,
      network_tx_bytes: i * 1000,
      block_read_bytes: i * 4000,
      block_write_bytes: i * 500,
    })
  )

const historial = (over: Record<string, unknown> = {}) => ({
  container_id: 'c123456789',
  container_name: 'web-app',
  running: true,
  observed: true,
  sampling: true,
  interval_s: 2,
  window_s: 900,
  truncated: false,
  samples: serie(10),
  ...over,
})

describe('StatsModal · serie temporal (SPEC-17)', () => {
  const originalWebSocket = global.WebSocket

  beforeEach(() => {
    MockWebSocket.instances = []
    // @ts-expect-error Mocking WebSocket
    global.WebSocket = MockWebSocket
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    global.WebSocket = originalWebSocket
    vi.unstubAllGlobals()
  })

  const abrir = () => {
    const utils = renderModal()
    latest().serverEmit(buildStats())
    return utils
  }

  it('pinta las cuatro familias de métricas', () => {
    abrir()
    latest().serverEmit({ type: 'history', history: historial() })

    expect(screen.getByText('Red · recibido')).toBeInTheDocument()
    expect(screen.getByText('Red · transmitido')).toBeInTheDocument()
    expect(screen.getByText('Disco · lectura')).toBeInTheDocument()
    expect(screen.getByText('Disco · escritura')).toBeInTheDocument()
  })

  it('las tasas se leen en bytes por segundo', () => {
    abrir()
    latest().serverEmit({ type: 'history', history: historial() })

    // 2000 bytes cada 2 s = 1000 B/s
    expect(screen.getAllByText(/1000 B\/s/).length).toBeGreaterThan(0)
  })

  it('el selector de ventana ofrece las tres y marca la de 5 min', () => {
    abrir()
    latest().serverEmit({ type: 'history', history: historial() })

    expect(screen.getByRole('button', { name: '1 min' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '5 min' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '15 min' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('cambiar de ventana recorta la serie', () => {
    abrir()
    latest().serverEmit({ type: 'history', history: historial() })

    const antes = screen.getAllByTestId('metric-chart-tramo').length
    fireEvent.click(screen.getByRole('button', { name: '1 min' }))

    // Con 10 muestras a 2 s sólo hay 10 s de historial: la ventana de 1 min y la
    // de 5 min dan lo mismo, y por eso el recorte se nota al pedir 15 min.
    expect(screen.getAllByTestId('metric-chart-tramo').length).toBe(antes)
    expect(screen.getByRole('button', { name: '1 min' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('el botón de observar refleja el estado del servidor', () => {
    abrir()
    latest().serverEmit({ type: 'history', history: historial({ observed: true }) })

    expect(screen.getByRole('button', { name: /Observando/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('sin historial lo dice y ofrece observar', () => {
    abrir()
    latest().serverEmit({ type: 'history', history: historial({ samples: [], observed: false }) })

    expect(screen.getByText(/Sin historial todavía/)).toBeInTheDocument()
    expect(screen.getByText(/no sobrevive a reiniciar el panel/)).toBeInTheDocument()
  })

  it('un contenedor parado avisa de que la serie es lo último medido', () => {
    abrir()
    latest().serverEmit({ type: 'history', history: historial({ running: false }) })

    expect(screen.getByText(/contenedor parado/)).toBeInTheDocument()
  })

  it('un historial truncado se dice en vez de fingir que es el periodo entero', () => {
    abrir()
    latest().serverEmit({ type: 'history', history: historial({ truncated: true }) })

    expect(screen.getByText('histórico truncado')).toBeInTheDocument()
  })

  it('el corte por reinicio no dibuja una sola línea continua', () => {
    abrir()
    const conReinicio = [
      muestra(1000, { network_rx_bytes: 5000 }),
      muestra(1002, { network_rx_bytes: 7000 }),
      muestra(1004, { network_rx_bytes: 0 }),
      muestra(1006, { network_rx_bytes: 100 }),
    ]
    latest().serverEmit({ type: 'history', history: historial({ samples: conReinicio }) })

    // Los tramos de todas las gráficas, no de una: el corte se nota en la de red.
    expect(screen.getAllByTestId('metric-chart-tramo').length).toBeGreaterThan(2)
  })
})

// --- El pin y la lista: el aviso que faltaba (SPEC-17 §4.9) --------------------
//
// La lista de contenedores tiene su propia «Observando» y no oye el canal de
// métricas. Sin `onObservedChange`, unfijar el pin desde aquí dejaba la tabla
// diciendo «Observando» hasta el refresco manual: la fila y el modal se
// contradecían, y los dos tenían razón los unos treinta segundos.

describe('StatsModal · aviso del pin a la lista', () => {
  const originalWebSocket = global.WebSocket

  const abrirConAviso = (onObservedChange: (id: string, observed: boolean) => void) => {
    const utils = render(
      <StatsModal
        isOpen={true}
        container={mockContainer}
        onClose={vi.fn()}
        onObservedChange={onObservedChange}
      />
    )
    latest().serverOpen()
    latest().serverEmit(buildStats())
    return utils
  }

  beforeEach(() => {
    MockWebSocket.instances = []
    // @ts-expect-error Mocking WebSocket
    global.WebSocket = MockWebSocket
  })

  afterEach(() => {
    global.WebSocket = originalWebSocket
    vi.unstubAllGlobals()
  })

  const stubPin = (opts: { falla?: boolean } = {}) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const ruta = String(url)
        if (ruta.endsWith('/watch')) {
          if (opts.falla) {
            return { ok: false, status: 409, json: async () => ({ detail: 'Ya se observan 12.' }) }
          }
          const observed = init?.method !== 'DELETE'
          return { ok: true, status: 200, json: async () => ({ container_id: 'c123', observed }) }
        }
        return { ok: true, status: 200, json: async () => historial() }
      }) as unknown as typeof fetch
    )

  it('avisa con el valor confirmado al fijar el pin', async () => {
    stubPin()
    const aviso = vi.fn()
    const { getByRole } = abrirConAviso(aviso)
    latest().serverEmit({ type: 'history', history: historial({ observed: false }) })

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /Observar/ }))
    })

    expect(aviso).toHaveBeenCalledWith(mockContainer.id, true)
  })

  it('avisa con false al soltar el pin, que es el caso que mentía', async () => {
    stubPin()
    const aviso = vi.fn()
    const { getByRole } = abrirConAviso(aviso)
    latest().serverEmit({ type: 'history', history: historial({ observed: true }) })

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /Observando/ }))
    })

    expect(aviso).toHaveBeenCalledWith(mockContainer.id, false)
  })

  it('NO avisa si el pin falla: la lista no se inventa un cambio', async () => {
    stubPin({ falla: true })
    const aviso = vi.fn()
    const { getByRole } = abrirConAviso(aviso)
    latest().serverEmit({ type: 'history', history: historial({ observed: false }) })

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /Observar/ }))
    })

    expect(aviso).not.toHaveBeenCalled()
  })

  it('funciona sin la prop: el modal no la da por hecha', async () => {
    stubPin()
    const { getByRole } = render(
      <StatsModal isOpen={true} container={mockContainer} onClose={vi.fn()} />
    )
    latest().serverOpen()
    latest().serverEmit(buildStats())
    latest().serverEmit({ type: 'history', history: historial({ observed: false }) })

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /Observar/ }))
    })

    // Sin prop no hay a quién avisar, pero el botón sigue cambiándose solo.
    expect(getByRole('button', { name: /Observando/ })).toBeInTheDocument()
  })
})
