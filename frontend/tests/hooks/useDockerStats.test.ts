import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDockerStats } from '../../src/hooks/useDockerStats'
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

  serverClose(code: number = 1006) {
    act(() => {
      this.onclose?.({ code })
    })
  }
}

const buildStats = (overrides: Partial<ContainerStats> = {}): ContainerStats => ({
  container_id: 'c123',
  container_name: 'web-app',
  cpu_percent: 20,
  memory_usage: 500,
  memory_limit: 10000,
  memory_percent: 5,
  network_rx_bytes: 300,
  network_tx_bytes: 700,
  block_read_bytes: 111,
  block_write_bytes: 222,
  pids_current: 5,
  timestamp: '2026-09-26T10:00:00.000000000Z',
  ...overrides,
})

const latest = () => MockWebSocket.instances[MockWebSocket.instances.length - 1]

describe('useDockerStats', () => {
  const originalWebSocket = global.WebSocket

  beforeEach(() => {
    MockWebSocket.instances = []
    // @ts-expect-error Mocking WebSocket
    global.WebSocket = MockWebSocket
  })

  afterEach(() => {
    global.WebSocket = originalWebSocket
    vi.useRealTimers()
  })

  it('initializes empty and opens the stats WebSocket', () => {
    const { result } = renderHook(() => useDockerStats('c123'))

    expect(result.current.currentStats).toBeNull()
    expect(result.current.reciente).toEqual([])
    expect(result.current.connected).toBe(false)

    expect(MockWebSocket.instances).toHaveLength(1)
    expect(latest().url).toContain('/ws/containers/c123/stats')

    latest().serverOpen()

    expect(result.current.connected).toBe(true)
    expect(result.current.error).toBeNull()
  })

  it('does not connect when no container id is provided', () => {
    renderHook(() => useDockerStats(null))

    expect(MockWebSocket.instances).toHaveLength(0)
  })

  it('updates currentStats as messages arrive', () => {
    const { result } = renderHook(() => useDockerStats('c123'))
    latest().serverOpen()

    latest().serverEmit(buildStats())
    expect(result.current.currentStats?.cpu_percent).toBe(20)
    expect(result.current.currentStats?.memory_percent).toBe(5)

    latest().serverEmit(buildStats({ cpu_percent: 42.5, memory_percent: 77.1 }))
    expect(result.current.currentStats?.cpu_percent).toBe(42.5)
    expect(result.current.currentStats?.memory_percent).toBe(77.1)
  })

  it('keeps a capped buffer of the last 20 live readings', () => {
    const { result } = renderHook(() => useDockerStats('c123'))
    latest().serverOpen()

    for (let i = 0; i < 25; i++) {
      latest().serverEmit(
        buildStats({ cpu_percent: i, memory_percent: i, timestamp: `ts-${i}` })
      )
    }

    expect(result.current.reciente).toHaveLength(20)
    expect(result.current.reciente[0].timestamp).toBe('ts-5')
    expect(result.current.reciente[19].timestamp).toBe('ts-24')
  })

  it('honours a custom maxHistory option', () => {
    const { result } = renderHook(() => useDockerStats('c123', { maxHistory: 3 }))
    latest().serverOpen()

    for (let i = 0; i < 6; i++) {
      latest().serverEmit(buildStats({ timestamp: `ts-${i}` }))
    }

    expect(result.current.reciente).toHaveLength(3)
    expect(result.current.reciente.map((p) => p.timestamp)).toEqual(['ts-3', 'ts-4', 'ts-5'])
  })

  it('clears the history buffer on demand', () => {
    const { result } = renderHook(() => useDockerStats('c123'))
    latest().serverOpen()
    latest().serverEmit(buildStats())

    expect(result.current.reciente).toHaveLength(1)

    act(() => {
      result.current.clearHistory()
    })

    expect(result.current.reciente).toEqual([])
  })

  it('reports an error and stops retrying when the container is not found (4404)', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useDockerStats('fantasma-99', { reconnectDelay: 1000 }))
    latest().serverClose(4404)

    expect(result.current.connected).toBe(false)
    expect(result.current.error).toBe('Contenedor no encontrado en Docker')

    // No debe reconectar tras un 4404
    act(() => {
      vi.advanceTimersByTime(10000)
    })
    expect(MockWebSocket.instances).toHaveLength(1)
  })
  it('reports an error when the WebSocket fails', () => {
    const { result } = renderHook(() => useDockerStats('c123'))

    act(() => {
      latest().onerror?.()
    })

    expect(result.current.connected).toBe(false)
    expect(result.current.error).toBe('Error en la conexión WebSocket de estadísticas')
  })

  it('reconnects after an unexpected disconnection', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useDockerStats('c123', { reconnectDelay: 1000 }))

    latest().serverOpen()
    expect(result.current.connected).toBe(true)

    latest().serverClose(1006)
    expect(MockWebSocket.instances).toHaveLength(1)

    act(() => {
      vi.advanceTimersByTime(1000)
    })

    expect(MockWebSocket.instances).toHaveLength(2)
  })

  it('closes the socket on unmount', () => {
    const { unmount } = renderHook(() => useDockerStats('c123'))
    const socket = latest()

    unmount()

    expect(socket.close).toHaveBeenCalled()
  })

  // --- El bucle de reconexión ---------------------------------------------------

  it('does NOT reconnect after a normal close (1000)', () => {
    // El backend cierra con 1000 cuando el stream de métricas se acaba, o sea
    // cuando el contenedor se para. Reconectar ahí convertía la vista en un
    // bucle infinito de 0.5 Hz: `stats()` sobre un contenedor parado falla con
    // 409, el backend lo trata como fin de stream, cierra con 1000 otra vez...
    vi.useFakeTimers()
    const { result } = renderHook(() => useDockerStats('c123', { reconnectDelay: 1000 }))

    latest().serverOpen()
    latest().serverClose(1000)

    expect(result.current.connected).toBe(false)
    expect(result.current.error).toBe('El contenedor dejó de enviar métricas')

    act(() => {
      vi.advanceTimersByTime(60000)
    })
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('backs off exponentially instead of hammering the daemon', () => {
    vi.useFakeTimers()
    renderHook(() => useDockerStats('c123', { reconnectDelay: 1000, maxReconnectAttempts: 10 }))

    // 1er fallo: espera 1s
    latest().serverClose(1006)
    act(() => {
      vi.advanceTimersByTime(999)
    })
    expect(MockWebSocket.instances).toHaveLength(1)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(MockWebSocket.instances).toHaveLength(2)

    // 2º fallo: espera 2s
    latest().serverClose(1006)
    act(() => {
      vi.advanceTimersByTime(1999)
    })
    expect(MockWebSocket.instances).toHaveLength(2)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(MockWebSocket.instances).toHaveLength(3)

    // 3er fallo: espera 4s
    latest().serverClose(1006)
    act(() => {
      vi.advanceTimersByTime(3999)
    })
    expect(MockWebSocket.instances).toHaveLength(3)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(MockWebSocket.instances).toHaveLength(4)
  })

  it('gives up after maxReconnectAttempts and says so', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() =>
      useDockerStats('c123', { reconnectDelay: 1000, maxReconnectAttempts: 3 })
    )

    for (let i = 0; i < 3; i++) {
      latest().serverClose(1006)
      act(() => {
        vi.advanceTimersByTime(60000)
      })
    }
    expect(MockWebSocket.instances).toHaveLength(4)

    // El cuarto fallo ya no reintenta: se acabó.
    latest().serverClose(1006)
    act(() => {
      vi.advanceTimersByTime(600000)
    })

    expect(MockWebSocket.instances).toHaveLength(4)
    expect(result.current.error).toContain('3 reintentos')
  })

  it('resets the backoff after a successful connection', () => {
    vi.useFakeTimers()
    renderHook(() => useDockerStats('c123', { reconnectDelay: 1000, maxReconnectAttempts: 3 }))

    // Dos fallos, y luego una conexión buena: el contador vuelve a cero.
    latest().serverClose(1006)
    act(() => {
      vi.advanceTimersByTime(60000)
    })
    latest().serverClose(1006)
    act(() => {
      vi.advanceTimersByTime(60000)
    })
    latest().serverOpen()

    latest().serverClose(1006)
    act(() => {
      vi.advanceTimersByTime(1000)
    })

    // Si no se hubiera reseteado, la tercera espera sería de 4s.
    expect(MockWebSocket.instances).toHaveLength(4)
  })

  it('does not resurrect a 1000 stop after a later failure', () => {
    // Una vez que el backend dice "se acabó" con 1000, un 1006 posterior no
    // debe devolver el socket a la vida.
    vi.useFakeTimers()
    renderHook(() => useDockerStats('c123', { reconnectDelay: 1000 }))

    latest().serverOpen()
    latest().serverClose(1000)
    latest().serverClose(1006)

    act(() => {
      vi.advanceTimersByTime(600000)
    })
    expect(MockWebSocket.instances).toHaveLength(1)
  })
})

// --- SPEC-17: el historial del servidor por el mismo canal -------------------

const buildHistory = (over: Record<string, unknown> = {}) => ({
  container_id: 'c123',
  container_name: 'web-app',
  running: true,
  observed: true,
  sampling: true,
  interval_s: 2,
  window_s: 900,
  truncated: false,
  samples: [
    {
      t: 1000,
      cpu_percent: 12,
      memory_percent: 30,
      network_rx_bytes: 100,
      network_tx_bytes: 200,
      block_read_bytes: 300,
      block_write_bytes: 400,
    },
  ],
  ...over,
})

describe('useDockerStats con el historial del servidor (SPEC-17)', () => {
  const originalWebSocket = global.WebSocket

  beforeEach(() => {
    MockWebSocket.instances = []
    // @ts-expect-error Mocking WebSocket
    global.WebSocket = MockWebSocket
  })

  afterEach(() => {
    global.WebSocket = originalWebSocket
  })

  it('puebla historial y NO pisa el valor actual', () => {
    const { result } = renderHook(() => useDockerStats('c123'))
    latest().serverOpen()

    latest().serverEmit({ type: 'history', history: buildHistory() })

    expect(result.current.historial?.samples).toHaveLength(1)
    expect(result.current.historial?.observed).toBe(true)
    // El mensaje de historial no es una muestra: si la tomara por una, la
    // cabecera del modal enseñaría un contenedor entero donde un porcentaje.
    expect(result.current.currentStats).toBeNull()
    expect(result.current.reciente).toHaveLength(0)
  })

  it('la muestra posterior sí pisa el valor actual', () => {
    const { result } = renderHook(() => useDockerStats('c123'))
    latest().serverOpen()

    latest().serverEmit({ type: 'history', history: buildHistory() })
    latest().serverEmit(buildStats({ cpu_percent: 42 }))

    expect(result.current.currentStats?.cpu_percent).toBe(42)
    expect(result.current.historial?.samples).toHaveLength(1)
  })

  it('al reconectar el historial se sustituye y no se concatena', () => {
    const { result } = renderHook(() => useDockerStats('c123'))
    latest().serverOpen()
    latest().serverEmit({ type: 'history', history: buildHistory() })
    latest().serverEmit({
      type: 'history',
      history: buildHistory({ samples: [{ ...buildHistory().samples[0], t: 1002 }] }),
    })

    expect(result.current.historial?.samples).toHaveLength(1)
    expect(result.current.historial?.samples[0].t).toBe(1002)
  })

  it('un historial vacío deja el estado vacío y no un error', () => {
    const { result } = renderHook(() => useDockerStats('c123'))
    latest().serverOpen()

    latest().serverEmit({ type: 'history', history: buildHistory({ samples: [], observed: false }) })

    expect(result.current.historial?.samples).toEqual([])
    expect(result.current.observed).toBe(false)
    expect(result.current.error).toBeNull()
  })

it('expone el estado del contenedor para que la interfaz lo diga', () => {
    const { result } = renderHook(() => useDockerStats('c123'))
    latest().serverOpen()

    latest().serverEmit({ type: 'history', history: buildHistory({ running: false }) })

    expect(result.current.running).toBe(false)
  })
})

// --- El botón de observar: el estado que se pide, el estado que se pinta -----

describe('useDockerStats · observar (el botón que no cambiaba)', () => {
  const originalWebSocket = global.WebSocket
  const originalFetch = global.fetch

  beforeEach(() => {
    MockWebSocket.instances = []
    // @ts-expect-error Mocking WebSocket
    global.WebSocket = MockWebSocket
  })

  afterEach(() => {
    global.WebSocket = originalWebSocket
    global.fetch = originalFetch
    vi.unstubAllGlobals()
  })

  const stub = (opts: { watchFalla?: boolean; metricsFalla?: boolean } = {}) => {
    const mock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const ruta = String(url)
      if (ruta.endsWith('/watch')) {
        if (opts.watchFalla) {
          return Promise.resolve({
            ok: false,
            status: 409,
            json: async () => ({ detail: 'Ya se observan 12 contenedores, que es el máximo.' }),
          })
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ container_id: 'c123', observed: init?.method !== 'DELETE' }),
        })
      }
      if (ruta.endsWith('/metrics')) {
        if (opts.metricsFalla) {
          return Promise.resolve({
            ok: false,
            status: 503,
            json: async () => ({ detail: 'No se pudo leer.' }),
          })
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => buildHistory(),
        })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    vi.stubGlobal('fetch', mock)
    return mock
  }

  const conectado = () => {
    const { result } = renderHook(() => useDockerStats('c123'))
    latest().serverOpen()
    latest().serverEmit({ type: 'history', history: buildHistory({ observed: false }) })
    return result
  }

  it('fijar el pin cambia el estado que ve el botón', async () => {
    stub()
    const result = conectado()

    expect(result.current.observed).toBe(false)

    await act(async () => {
      await result.current.setObserved(true)
    })

    expect(result.current.observed).toBe(true)
  })

  it('desfijar el pin también cambia el estado', async () => {
    stub()
    const result = conectado()
    latest().serverEmit({ type: 'history', history: buildHistory({ observed: true }) })

    expect(result.current.observed).toBe(true)

    await act(async () => {
      await result.current.setObserved(false)
    })

    expect(result.current.observed).toBe(false)
  })

  it('vuelve a leer el estado del servidor en vez de suponerlo', async () => {
    const mock = stub()
    const result = conectado()

    await act(async () => {
      await result.current.setObserved(true)
    })

    // Si sólo se pintara lo pedido, no haría falta esta llamada. Y el pin vive
    // en el backend: lo que diga el daemon es lo que vale.
    expect(mock).toHaveBeenCalledWith(expect.stringContaining('/containers/c123/watch'), {
      method: 'POST',
    })
    expect(mock).toHaveBeenCalledWith(expect.stringContaining('/containers/c123/metrics'))
  })

  it('el estado se lee del servidor aunque el WebSocket no diga nada nuevo', async () => {
    // Éste es el bug: el `history` del WebSocket se manda UNA vez, al conectar.
    // Sin volver a pedirlo, el botón se queda como estaba para siempre.
    stub()
    const result = conectado()
    latest().serverEmit({ type: 'history', history: buildHistory({ observed: true }) })

    await act(async () => {
      await result.current.setObserved(false)
    })
    latest().serverEmit({ type: 'history', history: buildHistory({ observed: true }) })

    // Llega una muestra nueva por el canal y el estado se actualiza.
    expect(result.current.observed).toBe(true)
  })

  it('si el pin falla, el botón no se mueve y se dice por qué', async () => {
    stub({ watchFalla: true })
    const result = conectado()

    await act(async () => {
      await result.current.setObserved(true)
    })

    expect(result.current.observed).toBe(false)
    expect(result.current.pinError).toMatch(/12 contenedores/)
  })

  it('si el pin va bien pero no se puede confirmar, se dice en vez de dejar el botón igual', async () => {
    stub({ metricsFalla: true })
    const result = conectado()

    await act(async () => {
      await result.current.setObserved(true)
    })

    expect(result.current.pinError).toMatch(/No se pudo leer/)
  })

  it('sin contenedor no hace nada', async () => {
    const mock = stub()
    const { result } = renderHook(() => useDockerStats(null))

    await act(async () => {
      await result.current.setObserved(true)
    })

    expect(mock).not.toHaveBeenCalled()
  })
})
