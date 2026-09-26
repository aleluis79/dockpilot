import { useState, useEffect, useCallback, useMemo } from 'react'
import { dockerApi } from '../services/dockerApi'
import type { NetworkSummary } from '../types/network'

export type NetworkFilter = 'all' | 'in-use' | 'unused' | 'builtin'

/** Filtro de uso: en uso excluye las predefinidas, que no son borrables. */
function matchesFilter(network: NetworkSummary, filter: NetworkFilter): boolean {
  switch (filter) {
    case 'in-use':
      return network.container_count > 0
    case 'unused':
      return network.container_count === 0
    case 'builtin':
      return network.is_builtin
    default:
      return true
  }
}

export function useNetworks() {
  const [networks, setNetworks] = useState<NetworkSummary[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<NetworkFilter>('all')
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [actionInProgress, setActionInProgress] = useState<string | null>(null)

  const refetch = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      setNetworks(await dockerApi.listNetworks())
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'Error desconocido al cargar las redes'
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let ignore = false

    const load = async () => {
      try {
        const data = await dockerApi.listNetworks()
        if (!ignore) setNetworks(data)
      } catch (err: unknown) {
        if (!ignore) {
          setError(
            err instanceof Error
              ? err.message
              : 'Error desconocido al cargar las redes'
          )
        }
      } finally {
        if (!ignore) setLoading(false)
      }
    }

    load()
    return () => {
      ignore = true
    }
  }, [])

  const deleteNetwork = useCallback(
    async (name: string, force = false) => {
      setActionInProgress(name)
      try {
        await dockerApi.deleteNetwork(name, force)
        await refetch()
        return true
      } catch (err: unknown) {
        setError(
          err instanceof Error ? err.message : 'Error desconocido al eliminar la red'
        )
        return false
      } finally {
        setActionInProgress(null)
      }
    },
    [refetch]
  )

  const pruneNetworks = useCallback(async () => {
    setActionInProgress('__prune__')
    try {
      const result = await dockerApi.pruneNetworks()
      await refetch()
      return result
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'Error desconocido al limpiar las redes'
      )
      return null
    } finally {
      setActionInProgress(null)
    }
  }, [refetch])

  const createNetwork = useCallback(
    async (payload: Parameters<typeof dockerApi.createNetwork>[0]) => {
      setActionInProgress('__create__')
      try {
        const created = await dockerApi.createNetwork(payload)
        await refetch()
        return created
      } catch (err: unknown) {
        throw err instanceof Error
          ? err
          : new Error('Error desconocido al crear la red')
      } finally {
        setActionInProgress(null)
      }
    },
    [refetch]
  )

  const visibleNetworks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return networks.filter(
      (network) =>
        matchesFilter(network, filter) &&
        (!query || network.name.toLowerCase().includes(query))
    )
  }, [networks, filter, searchQuery])

  const counts = useMemo(
    () => ({
      total: networks.length,
      inUse: networks.filter((n) => n.container_count > 0).length,
      unused: networks.filter((n) => n.container_count === 0 && !n.is_builtin).length,
      builtin: networks.filter((n) => n.is_builtin).length,
    }),
    [networks]
  )

  return {
    networks,
    visibleNetworks,
    counts,
    loading,
    error,
    filter,
    setFilter,
    searchQuery,
    setSearchQuery,
    actionInProgress,
    refetch,
    deleteNetwork,
    pruneNetworks,
    createNetwork,
  }
}
