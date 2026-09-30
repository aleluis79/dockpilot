import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDockerLogs } from '../../src/hooks/useDockerLogs'

class MockWebSocket {
  url: string
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((error: unknown) => void) | null = null
  close = vi.fn()

  constructor(url: string) {
    this.url = url
    setTimeout(() => {
      act(() => {
        if (this.onopen) this.onopen()
      })
    }, 10)
  }
}

describe('useDockerLogs', () => {
  const originalWebSocket = global.WebSocket

  beforeEach(() => {
    // @ts-expect-error Mocking WebSocket
    global.WebSocket = MockWebSocket
  })

  afterEach(() => {
    global.WebSocket = originalWebSocket
  })

  it('initializes with empty logs and connects', async () => {
    const { result } = renderHook(() => useDockerLogs('c123'))

    expect(result.current.logs).toEqual([])
    expect(result.current.connected).toBe(false)

    await vi.waitFor(() => {
      expect(result.current.connected).toBe(true)
    })
  })

  it('allows clearing logs buffer', () => {
    const { result } = renderHook(() => useDockerLogs('c123'))

    act(() => {
      result.current.clearLogs()
    })

    expect(result.current.logs).toEqual([])
  })
})

// --- El tope también vale para los frames que no son JSON ----------------------

describe('useDockerLogs con frames que no son JSON', () => {
  const originalWebSocket = global.WebSocket
  const abiertos: SocketConCrudo[] = []

  class SocketConCrudo extends MockWebSocket {
    /** Manda algo que `JSON.parse` no sabe leer. */
    crudo(data: string) {
      act(() => {
        if (this.onmessage) this.onmessage({ data })
      })
    }
  }

  beforeEach(() => {
    abiertos.length = 0
    // @ts-expect-error Mocking WebSocket
    global.WebSocket = class extends SocketConCrudo {
      constructor(url: string) {
        super(url)
        abiertos.push(this)
        act(() => {
          if (this.onopen) this.onopen()
        })
      }
    }
  })

  afterEach(() => {
    global.WebSocket = originalWebSocket
  })

  it('recorta también la rama de texto plano', () => {
    // Antes sólo la rama JSON pasaba por el recorte, así que cualquier cosa que
    // no supiera parsear (una página de error de un proxy, un modo de log en
    // crudo) hacía crecer el búfer sin límite aunque `maxLines` pusiera techo.
    const { result } = renderHook(() => useDockerLogs('c123', { maxLines: 5 }))

    act(() => {
      for (let i = 0; i < 50; i++) abiertos[0].crudo('esto no es json')
    })

    expect(result.current.logs).toHaveLength(5)
  })
})
