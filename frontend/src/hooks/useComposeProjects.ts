// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, useEffect, useCallback, useMemo } from 'react'
import { dockerApi } from '../services/dockerApi'
import type {
  ComposeOverview,
  ComposeProjectFilter,
  ComposeProjectSummary,
} from '../types/compose'

/** Un proyecto está "en ejecución" si tiene al menos un contenedor corriendo. */
function matchesFilter(project: ComposeProjectSummary, filter: ComposeProjectFilter): boolean {
  switch (filter) {
    case 'running':
      return project.containers_running > 0
    case 'orphaned':
      return project.orphaned
    default:
      return true
  }
}

/**
 * Inventario de proyectos compose de la pestaña `Proyectos`.
 *
 * Sin sondeo automático: el estado de un proyecto cambia por acción del usuario,
 * no por tiempo. El refresco es manual, por el mismo motivo que en SPEC-09.
 */
export function useComposeProjects() {
  const [overview, setOverview] = useState<ComposeOverview | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [refreshing, setRefreshing] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<ComposeProjectFilter>('all')
  const [searchQuery, setSearchQuery] = useState<string>('')

  const load = useCallback(async (inicial: boolean) => {
    if (inicial) setLoading(true)
    else setRefreshing(true)
    setError(null)
    try {
      setOverview(await dockerApi.listComposeProjects())
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'Error desconocido al leer los proyectos compose'
      )
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load(true)
  }, [load])

  const refetch = useCallback(() => load(false), [load])

  // Los contadores se calculan sobre el inventario completo, no sobre el
  // filtrado: un filtro que cambia los recuentos de sus propios botones impide
  // saber cuántos hay en cada categoría.
  const counts = useMemo(() => {
    const projects = overview?.projects ?? []
    return {
      all: projects.length,
      running: projects.filter((p) => p.containers_running > 0).length,
      orphaned: projects.filter((p) => p.orphaned).length,
    }
  }, [overview])

  const projects = useMemo(() => {
    const term = searchQuery.trim().toLowerCase()
    return (overview?.projects ?? []).filter(
      (p) => matchesFilter(p, filter) && (!term || p.name.toLowerCase().includes(term))
    )
  }, [overview, filter, searchQuery])

  return {
    overview,
    projects,
    counts,
    loading,
    refreshing,
    error,
    filter,
    setFilter,
    searchQuery,
    setSearchQuery,
    refetch,
  }
}
