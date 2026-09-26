// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, useEffect, useCallback } from 'react'
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
 */
export function useSystemOverview() {
  const [overview, setOverview] = useState<SystemOverview | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const data = await dockerApi.getSystemOverview()
      if (!esOverviewValido(data)) {
        setError('El daemon devolvio una respuesta con un formato inesperado')
        return
      }
      setOverview(data)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error desconocido al leer el resumen del sistema')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let ignore = false

    const fetchOverview = async () => {
      try {
        const data = await dockerApi.getSystemOverview()
        if (ignore) return
        if (!esOverviewValido(data)) {
          setError('El daemon devolvio una respuesta con un formato inesperado')
          return
        }
        setOverview(data)
      } catch (err: unknown) {
        if (!ignore) {
          setError(err instanceof Error ? err.message : 'Error desconocido al leer el resumen del sistema')
        }
      } finally {
        if (!ignore) setLoading(false)
      }
    }

    fetchOverview()
    return () => {
      ignore = true
    }
  }, [])

  return { overview, loading, error, refetch: load }
}
