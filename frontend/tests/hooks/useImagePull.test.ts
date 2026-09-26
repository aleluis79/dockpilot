import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useImagePull } from '../../src/hooks/useImagePull'
import type { ImagePullMessage } from '../../src/types/image'

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

  emit(message: ImagePullMessage) {
    act(() => {
      this.onmessage?.({ data: JSON.stringify(message) })
    })
  }
}

const latest = () => MockWebSocket.instances[MockWebSocket.instances.length - 1]

const layerMessage = (
  status: string,
  overrides: Partial<ImagePullMessage> = {}
): ImagePullMessage => ({
  type: 'layer',
  image: 'alpine:3.20',
  id: 'l1',
  status,
  ...overrides,
})

describe('useImagePull', () => {
  const originalWebSocket = global.WebSocket

  beforeEach(() => {
    MockWebSocket.instances = []
    // @ts-expect-error Mocking WebSocket
    global.WebSocket = MockWebSocket
  })

  afterEach(() => {
    global.WebSocket = originalWebSocket
  })

  it('no abre socket sin referencia', () => {
    renderHook(() => useImagePull(null))

    expect(MockWebSocket.instances).toHaveLength(0)
  })

  it('abre el socket con la referencia codificada en la URL', () => {
    renderHook(() => useImagePull('alpine:3.20'))

    expect(MockWebSocket.instances).toHaveLength(1)
    expect(decodeURIComponent(latest().url)).toContain('/ws/images/pull?image=alpine:3.20')
  })

  it('empieza en pulling y acumula el progreso de cada capa', () => {
    const { result } = renderHook(() => useImagePull('alpine:3.20'))
    expect(result.current.status).toBe('pulling')

    latest().emit(layerMessage('Pulling fs layer'))
    expect(result.current.layers).toHaveLength(1)
    expect(result.current.layers[0].state).toBe('pending')

    latest().emit(layerMessage('Downloading', { current: 512, total: 2048 }))
    expect(result.current.layers[0].state).toBe('downloading')
    expect(result.current.current).toBe(512)
    expect(result.current.total).toBe(2048)

    latest().emit(layerMessage('Extracting', { current: 2048, total: 2048 }))
    expect(result.current.layers[0].state).toBe('extracting')
  })

  it('ignora el evento "Pulling from" porque no identifica ninguna capa', () => {
    const { result } = renderHook(() => useImagePull('alpine:3.20'))

    latest().emit(layerMessage('Pulling from library/alpine', { id: 'latest' }))

    expect(result.current.layers).toHaveLength(0)
  })

  it('acumula varias capas y suma sus bytes', () => {
    const { result } = renderHook(() => useImagePull('alpine:3.20'))

    latest().emit(layerMessage('Pulling fs layer', { id: 'l1' }))
    latest().emit(layerMessage('Pulling fs layer', { id: 'l2' }))
    latest().emit(layerMessage('Downloading', { id: 'l1', current: 100, total: 400 }))
    latest().emit(layerMessage('Downloading', { id: 'l2', current: 250, total: 500 }))

    expect(result.current.layers).toHaveLength(2)
    expect(result.current.current).toBe(350)
    expect(result.current.total).toBe(900)
  })

  it('marca la capa como completada y total cero cuando el daemon omite los bytes', () => {
    const { result } = renderHook(() => useImagePull('alpine:3.20'))

    latest().emit(layerMessage('Pulling fs layer'))
    latest().emit(layerMessage('Pull complete'))

    expect(result.current.layers[0].state).toBe('done')
    expect(result.current.total).toBe(0)
  })

  it('guarda el digest y pasa a success al recibir done', () => {
    const onComplete = vi.fn()
    const { result } = renderHook(() => useImagePull('alpine:3.20', { onComplete }))

    latest().emit({ type: 'digest', image: 'alpine:3.20', digest: 'sha256:abc' })
    expect(result.current.digest).toBe('sha256:abc')

    latest().emit({ type: 'done', image: 'alpine:3.20', id: 'l1', tags: ['alpine:3.20'] })

    expect(result.current.status).toBe('success')
    expect(result.current.error).toBeNull()
    expect(onComplete).toHaveBeenCalledWith(['alpine:3.20'])
  })

  it('propaga el error del backend y detiene el estado de descarga', () => {
    const { result } = renderHook(() => useImagePull('no-existe:1'))

    latest().emit({
      type: 'error',
      image: 'no-existe:1',
      code: 404,
      message: 'pull access denied for no-existe',
    })

    expect(result.current.status).toBe('error')
    expect(result.current.error).toBe('pull access denied for no-existe')
    expect(result.current.errorCode).toBe(404)
  })

  it('reset vuelve al estado inicial', () => {
    const { result } = renderHook(() => useImagePull('alpine:3.20'))

    latest().emit(layerMessage('Pulling fs layer'))
    expect(result.current.layers).toHaveLength(1)

    act(() => {
      result.current.reset()
    })

    expect(result.current.layers).toEqual([])
    expect(result.current.digest).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it('cierra el socket al desmontar y no reconecta solo', () => {
    const { unmount } = renderHook(() => useImagePull('alpine:3.20'))
    const socket = latest()

    unmount()

    expect(socket.close).toHaveBeenCalled()
    expect(MockWebSocket.instances).toHaveLength(1)
  })
})
