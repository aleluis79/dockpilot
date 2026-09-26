import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ImageLayerState, ImagePullLayer, ImagePullMessage } from '../types/image'

type PullStatus = 'idle' | 'pulling' | 'success' | 'error'

interface UseImagePullOptions {
  onComplete?: (tags: string[]) => void
}

/**
 * Traduce el `status` textual del daemon al estado de la capa.
 * Coincide con la tabla de SPEC-07 §3.4.
 */
const LAYER_STATE: Record<string, ImageLayerState> = {
  'pulling fs layer': 'pending',
  downloading: 'downloading',
  extracting: 'extracting',
  'download complete': 'done',
  'pull complete': 'done',
}

/**
 * Gestiona la descarga de una imagen por WebSocket.
 *
 * No reconecta sola: una descarga es una acción, no una suscripción. Si el
 * usuario cancela, cierra el socket y el backend libera la descarga.
 */
export function useImagePull(
  imageRef: string | null,
  options: UseImagePullOptions = {}
) {
  const { onComplete } = options

  const [status, setStatus] = useState<PullStatus>('idle')
  const [layers, setLayers] = useState<ImagePullLayer[]>([])
  const [digest, setDigest] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<number | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const onCompleteRef = useRef(onComplete)

  useEffect(() => {
    onCompleteRef.current = onComplete
  })

  // Los totales se derivan de las capas en vez de guardarse en estado: el
  // daemon omite `total` en las capas ya cacheadas, así que hay que sumar
  // siempre el conjunto vigente.
  const current = useMemo(() => layers.reduce((acc, l) => acc + l.current, 0), [layers])
  const total = useMemo(() => layers.reduce((acc, l) => acc + l.total, 0), [layers])

  const reset = useCallback(() => {
    setStatus('idle')
    setLayers([])
    setDigest(null)
    setError(null)
    setErrorCode(null)
  }, [])

  useEffect(() => {
    if (!imageRef) {
      reset()
      return
    }

    let isMounted = true
    setStatus('pulling')
    setError(null)
    setErrorCode(null)

    let wsUrl = `/ws/images/pull?image=${encodeURIComponent(imageRef)}`
    if (typeof window !== 'undefined' && window.location) {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const host = window.location.host || '127.0.0.1:8000'
      wsUrl = `${protocol}//${host}${wsUrl}`
    }

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onmessage = (event) => {
      if (!isMounted) return

      let message: ImagePullMessage
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }

      switch (message.type) {
        case 'start':
          setStatus('pulling')
          return

        case 'layer': {
          const statusText = (message.status ?? '').toLowerCase()
          // "Pulling from library/x" identifica el repositorio, no una capa
          if (!message.id || statusText.startsWith('pulling from')) return

          const entry: ImagePullLayer = {
            id: message.id,
            status: message.status ?? '',
            current: message.current ?? 0,
            total: message.total ?? 0,
            state: LAYER_STATE[statusText] ?? 'pending',
          }

          setLayers((prev) => {
            const index = prev.findIndex((layer) => layer.id === entry.id)
            if (index === -1) return [...prev, entry]
            const next = [...prev]
            next[index] = entry
            return next
          })
          return
        }

        case 'digest':
          setDigest(message.digest ?? null)
          return

        case 'done':
          setStatus('success')
          onCompleteRef.current?.(message.tags ?? [])
          return

        case 'error':
          setStatus('error')
          setError(message.message ?? 'Error desconocido al descargar la imagen')
          setErrorCode(message.code ?? null)
          return
      }
    }

    ws.onerror = () => {
      if (!isMounted) return
      setStatus('error')
      setError('Error en la conexión WebSocket de descarga')
    }

    return () => {
      isMounted = false
      const socket = wsRef.current
      wsRef.current = null
      if (socket) {
        socket.onmessage = null
        socket.onerror = null
        socket.close()
      }
    }
  }, [imageRef, reset])

  return {
    status,
    layers,
    digest,
    error,
    errorCode,
    current,
    total,
    reset,
  }
}
