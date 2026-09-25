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
