// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, useEffect, useCallback, useRef } from 'react'
import type { LogEntry } from '../types/log'
import { wsUrl } from '../services/wsUrl'

interface UseDockerLogsOptions {
  tail?: number
  timestamps?: boolean
  maxLines?: number
}

export function useDockerLogs(
  containerId: string | null,
  options: UseDockerLogsOptions = {}
) {
  const { tail = 100, timestamps = true, maxLines = 2000 } = options

  const [logs, setLogs] = useState<LogEntry[]>([])
  const [connected, setConnected] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  const wsRef = useRef<WebSocket | null>(null)

  const clearLogs = useCallback(() => {
    setLogs([])
  }, [])

  useEffect(() => {
    if (!containerId) return

    let isMounted = true

    // Determinar URL de WebSocket
    const url = wsUrl(`/ws/containers/${containerId}/logs?tail=${tail}&timestamps=${timestamps}&follow=true`)

    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      if (isMounted) {
        setConnected(true)
        setError(null)
      }
    }

    ws.onmessage = (event) => {
      if (!isMounted) return
      try {
        const entry: LogEntry = JSON.parse(event.data)
        setLogs((prev) => {
          const next = [...prev, entry]
          if (next.length > maxLines) {
            return next.slice(next.length - maxLines)
          }
          return next
        })
      } catch {
        const entry: LogEntry = {
          stream: 'stdout',
          message: event.data,
        }
        setLogs((prev) => [...prev, entry])
      }
    }

    ws.onerror = () => {
      if (isMounted) {
        setError('Error en la conexión WebSocket de logs')
        setConnected(false)
      }
    }

    ws.onclose = (event) => {
      if (isMounted) {
        setConnected(false)
        if (event.code === 4404) {
          setError('Contenedor no encontrado en Docker')
        }
      }
    }

    return () => {
      isMounted = false
      ws.close()
      wsRef.current = null
      setConnected(false)
    }
  }, [containerId, tail, timestamps, maxLines])

  return {
    logs,
    connected,
    error,
    clearLogs,
  }
}
