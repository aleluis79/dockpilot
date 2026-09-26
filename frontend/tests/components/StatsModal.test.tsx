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
