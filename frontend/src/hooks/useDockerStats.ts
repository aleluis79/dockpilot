// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, useEffect, useCallback, useRef } from 'react'
import type { ContainerStats, StatsHistoryPoint } from '../types/stats'
import { wsUrl } from '../services/wsUrl'

interface UseDockerStatsOptions {
  maxHistory?: number
  reconnectDelay?: number
  maxReconnectAttempts?: number
}

export function useDockerStats(
  containerId: string | null,
  options: UseDockerStatsOptions = {}
) {
  const { maxHistory = 20, reconnectDelay = 2000, maxReconnectAttempts = 5 } = options

  const [currentStats, setCurrentStats] = useState<ContainerStats | null>(null)
  const [history, setHistory] = useState<StatsHistoryPoint[]>([])
  const [connected, setConnected] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const canReconnectRef = useRef<boolean>(true)
  const intentosRef = useRef<number>(0)

  const clearHistory = useCallback(() => {
    setHistory([])
  }, [])

  useEffect(() => {
    if (!containerId) return

    let isMounted = true
    canReconnectRef.current = true
    intentosRef.current = 0

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
    }

    const scheduleReconnect = () => {
      if (!isMounted || !canReconnectRef.current) return
      if (intentosRef.current >= maxReconnectAttempts) {
        setError(
          `Se perdió la conexión con las métricas (${maxReconnectAttempts} reintentos). ` +
            'Cierra y vuelve a abrir para reintentarlo.'
        )
        return
      }
      clearReconnectTimer()
      // Espera creciente: si el daemon está caído, reintentar cada 2 s sólo lo
      // machaca más. El tope de 30 s evita esperar media hora.
      const espera = Math.min(reconnectDelay * 2 ** intentosRef.current, 30000)
      intentosRef.current += 1
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null
        connect()
      }, espera)
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
        intentosRef.current = 0
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

        // El backend manda 4400/4404 cuando el contenedor no existe o no
        // corre: reintentar no puede arreglar eso.
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

        // 1000 es el cierre NORMAL del backend (`finally: await close()`), y llega
        // cuando el stream de métricas se acaba, es decir cuando el contenedor
        // se ha parado. Reconectar ahí es lo que convertía la vista «Métricas» en
        // un bucle infinito de 0.5 Hz contra el daemon: `stats()` sobre un
        // contenedor parado falla con 409, el backend lo cuenta como fin de
        // stream, cierra con 1000 otra vez, y vuelta a empezar. Para siempre.
        if (event.code === 1000) {
          canReconnectRef.current = false
          setError('El contenedor dejó de enviar métricas')
          return
        }

        // 1006 (red caída) y 1011 (fallo del backend) sí son reintentables.
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
  }, [containerId, maxHistory, reconnectDelay, maxReconnectAttempts])

  return {
    currentStats,
    history,
    connected,
    error,
    clearHistory,
  }
}
