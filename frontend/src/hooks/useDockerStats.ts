// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, useEffect, useCallback, useRef } from 'react'
import type { ContainerStats, StatsHistoryPoint } from '../types/stats'
import { wsUrl } from '../services/wsUrl'

interface UseDockerStatsOptions {
  maxHistory?: number
  reconnectDelay?: number
}

export function useDockerStats(
  containerId: string | null,
  options: UseDockerStatsOptions = {}
) {
  const { maxHistory = 20, reconnectDelay = 2000 } = options

  const [currentStats, setCurrentStats] = useState<ContainerStats | null>(null)
  const [history, setHistory] = useState<StatsHistoryPoint[]>([])
  const [connected, setConnected] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const canReconnectRef = useRef<boolean>(true)

  const clearHistory = useCallback(() => {
    setHistory([])
  }, [])

  useEffect(() => {
    if (!containerId) return

    let isMounted = true
    canReconnectRef.current = true

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
    }

    const scheduleReconnect = () => {
      if (!isMounted || !canReconnectRef.current) return
      clearReconnectTimer()
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null
        connect()
      }, reconnectDelay)
    }

    const connect = () => {
      const url = wsUrl(`/ws/containers/${containerId}/stats`)

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
          const stats: ContainerStats = JSON.parse(event.data)
          setCurrentStats(stats)
          setHistory((prev) => {
            const next = [
              ...prev,
              {
                timestamp: stats.timestamp,
                cpu_percent: stats.cpu_percent,
                memory_percent: stats.memory_percent,
              },
            ]
            if (next.length > maxHistory) {
              return next.slice(next.length - maxHistory)
            }
            return next
          })
        } catch {
          // Ignorar mensajes que no cumplen el schema ContainerStats
        }
      }

      ws.onerror = () => {
        if (isMounted) {
          setError('Error en la conexión WebSocket de estadísticas')
          setConnected(false)
        }
      }

      ws.onclose = (event) => {
        if (!isMounted) return
        setConnected(false)
        if (event.code === 4404) {
          canReconnectRef.current = false
          setError('Contenedor no encontrado en Docker')
          return
        }
        if (event.code === 4400) {
          canReconnectRef.current = false
          setError('El contenedor no está en ejecución')
          return
        }
        scheduleReconnect()
      }
    }

    connect()

    return () => {
      isMounted = false
      canReconnectRef.current = false
      clearReconnectTimer()
      const ws = wsRef.current
      wsRef.current = null
      if (ws) {
        ws.onopen = null
        ws.onmessage = null
        ws.onerror = null
        ws.onclose = null
        ws.close()
      }
      setConnected(false)
    }
  }, [containerId, maxHistory, reconnectDelay])

  return {
    currentStats,
    history,
    connected,
    error,
    clearHistory,
  }
}
