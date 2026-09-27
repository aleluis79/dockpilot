// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, useEffect, useCallback, useRef } from 'react'
import { dockerApi } from '../services/dockerApi'
import type { SystemOverview } from '../types/system'

/**
 * Comprueba que el payload tenga la forma esperada.
 *
 * Sin esto, una respuesta inesperada (por ejemplo `[]` devuelta con status 200)
 * llega al componente, `[]` resulta ser truthy y el acceso a `info.server_version`
 * revienta el árbol de React entero.
 */
function esOverviewValido(datos: unknown): datos is SystemOverview {
  if (typeof datos !== 'object' || datos === null || Array.isArray(datos)) return false
  const candidato = datos as Partial<SystemOverview>
  return (
    typeof candidato.info === 'object' && candidato.info !== null &&
    typeof candidato.usage === 'object' && candidato.usage !== null &&
    Array.isArray(candidato.top_images) && Array.isArray(candidato.top_volumes)
  )
}

/**
 * Carga la vista completa del host para la franja de resumen.
 *
 * Se consulta una sola vez al montar: son datos del host, no un recurso que
 * cambie por la acción del usuario. El refresco queda disponible por si se
 * quiere volver a leer tras una limpieza.
 *
 * `loading` y `refreshing` están separados a propósito: `loading` vacía la
 * franja y solo aplica a la primera carga; `refreshing` la deja en pantalla con
 * el botón en estado de carga, para que un refresco no borre las cifras que el
 * usuario ya está leyendo.
 */
export function useSystemOverview() {
  const [overview, setOverview] = useState<SystemOverview | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [refreshing, setRefreshing] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  // Un contador de petición descarta las respuestas que llegan tarde: si se
  // refresca dos veces seguidas, la más antigua no pisa a la más nueva.
  const peticionActual = useRef(0)

  const cargar = useCallback(async (inicial: boolean) => {
    const id = ++peticionActual.current
    if (inicial) setLoading(true)
    else setRefreshing(true)
    setError(null)

    try {
      const data = await dockerApi.getSystemOverview()
      if (id !== peticionActual.current) return
      if (!esOverviewValido(data)) {
        setError('El daemon devolvio una respuesta con un formato inesperado')
        return
      }
      setOverview(data)
    } catch (err: unknown) {
      if (id !== peticionActual.current) return
      setError(
        err instanceof Error ? err.message : 'Error desconocido al leer el resumen del sistema'
      )
    } finally {
      if (id === peticionActual.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [])

  useEffect(() => {
    void cargar(true)
  }, [cargar])

  const refetch = useCallback(() => cargar(false), [cargar])

  return { overview, loading, refreshing, error, refetch }
}
