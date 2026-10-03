// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, useEffect, useCallback, useRef } from 'react'
import type { ContainerStats, StatsHistoryPoint } from '../types/stats'
import type { MetricsHistory } from '../types/metrics'
import { wsUrl } from '../services/wsUrl'
import { dockerApi } from '../services/dockerApi'

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
  // El búfer local de las últimas lecturas en vivo, para el sparkline. Se llama
  // `reciente` y no `history` porque desde SPEC-17 hay OTRO historial, el del
  // servidor: dos cosas con el mismo nombre en el mismo hook acaban siendo la
  // misma en la cabeza de quien lo lee, y son de distinta naturaleza.
  const [reciente, setReciente] = useState<StatsHistoryPoint[]>([])
  // La serie del servidor (SPEC-17). Llega por el mismo WebSocket, antes de la
  // primera muestra, y sobrevive a recargar la página.
  const [historial, setHistorial] = useState<MetricsHistory | null>(null)
  const [connected, setConnected] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  /** Por qué no se pudo mover el pin. Vive aparte de `error`: `error` es del
   *  canal y este del botón, y un 409 del pin no es una caída de métricas. */
  const [pinError, setPinError] = useState<string | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const canReconnectRef = useRef<boolean>(true)
  const intentosRef = useRef<number>(0)

  const clearHistory = useCallback(() => {
    setReciente([])
  }, [])

  /**
   * Fijar o soltar el pin de observación. Devuelve el valor **confirmado por el
   * backend**, o `null` si no se pudo: quien llama necesita distinguir «quedó
   * fijado» de «no pasó nada», porque con `null` no hay que avisar a nadie.
   *
   * Lo que se pinta es lo que contesta el backend, nunca lo que se pidió: el
   * pin vive en el servidor (SPEC-17 §4.3) y el que responde es el daemon. Por
   * eso, además del POST/DELETE, se relee el historial: sin esa llamada el botón
   * se quedaba como estaba para siempre, porque el `history` del WebSocket sólo
   * se manda una vez, al conectar.
   *
   * El `observed` de la relectura **no** pisa el de la respuesta del pin: entre
   * el POST y el GET el anillo puede no haberse reapuntado todavía, y lo que el
   * backend acaba de confirmar sobre el pin es más reciente que ese GET.
   */
  const setObserved = useCallback(
    async (observed: boolean): Promise<boolean | null> => {
      if (!containerId) return null
      setPinError(null)
      try {
        const fijado = observed
          ? await dockerApi.watchContainer(containerId)
          : await dockerApi.unwatchContainer(containerId)

        setHistorial((prev) => (prev ? { ...prev, observed: fijado.observed } : prev))

        // La relectura refresca la serie y deja el resto del estado como el
        // servidor lo ve. Si falla, el pin YA está aplicado: sólo no se ha
        // podido confirmar, y eso se dice en vez de fingir que no pasó.
        const metrics = await dockerApi.getContainerMetrics(containerId)
        setHistorial({ ...metrics, observed: fijado.observed })

        return fijado.observed
      } catch (e) {
        setPinError(e instanceof Error ? e.message : 'No se pudo cambiar la observación')
        return null
      }
    },
    [containerId]
  )

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
          const payload = JSON.parse(event.data)

          // El historial del servidor es un mensaje con `type`, y la muestra en
          // vivo es el mensaje que no lo tiene. Es la asimetría que SPEC-17 §3.2
          // documenta: lo que no es muestra en vivo lleva `type`.
          if (payload && payload.type === 'history') {
            // **Sustituye**, no concatena: al reconectar el backend manda su
            // anillo entero, y unirlo con lo que ya había pondría dos veces los
            // puntos que coinciden en el tiempo.
            setHistorial(payload.history as MetricsHistory)
            return
          }

          const stats: ContainerStats = payload
          setCurrentStats(stats)
          setReciente((prev) => {
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
    /** El búfer local de las últimas lecturas, para el sparkline. */
    reciente,
    /** La serie del servidor (SPEC-17). `null` hasta que llegue el mensaje. */
    historial,
    observed: historial?.observed ?? false,
    running: historial?.running ?? false,
    connected,
    error,
    clearHistory,
    setObserved,
    /** Por qué no se pudo mover el pin, o `null` si el último intento salió bien. */
    pinError,
  }
}
