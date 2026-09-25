import { useState, useEffect, useCallback, useMemo } from 'react'
import { dockerApi } from '../services/dockerApi'
import type { ContainerSummary } from '../types/docker'

export function useContainers() {
  const [containers, setContainers] = useState<ContainerSummary[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [actionInProgress, setActionInProgress] = useState<string | null>(null)

  const fetchContainers = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const data = await dockerApi.listContainers(
        true,
        statusFilter === 'all' ? undefined : statusFilter
      )
      setContainers(data)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error desconocido al cargar contenedores'
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => {
    let ignore = false

    const load = async () => {
      try {
        const data = await dockerApi.listContainers(
          true,
          statusFilter === 'all' ? undefined : statusFilter
        )
        if (!ignore) {
          setContainers(data)
          setError(null)
        }
      } catch (err: unknown) {
        if (!ignore) {
          const msg =
            err instanceof Error ? err.message : 'Error desconocido al cargar contenedores'
          setError(msg)
        }
      } finally {
        if (!ignore) {
          setLoading(false)
        }
      }
    }

    load()

    return () => {
      ignore = true
    }
  }, [statusFilter])

  const executeAction = async (
    id: string,
    action: 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'remove',
    force: boolean = false
  ) => {
    try {
      setActionInProgress(`${id}-${action}`)
      setError(null)
      switch (action) {
        case 'start':
          await dockerApi.startContainer(id)
          break
        case 'stop':
          await dockerApi.stopContainer(id)
          break
        case 'restart':
          await dockerApi.restartContainer(id)
          break
        case 'pause':
          await dockerApi.pauseContainer(id)
          break
        case 'unpause':
          await dockerApi.unpauseContainer(id)
          break
        case 'remove':
          await dockerApi.removeContainer(id, force)
          break
      }
      await fetchContainers()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : `Fallo al ejecutar ${action}`
      setError(msg)
    } finally {
      setActionInProgress(null)
    }
  }

  const filteredContainers = useMemo(() => {
    return containers.filter((c) => {
      const matchesSearch =
        c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.image.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.id.toLowerCase().includes(searchQuery.toLowerCase())
      return matchesSearch
    })
  }, [containers, searchQuery])

  return {
    containers: filteredContainers,
    rawContainers: containers,
    loading,
    error,
    statusFilter,
    setStatusFilter,
    searchQuery,
    setSearchQuery,
    actionInProgress,
    refetch: fetchContainers,
    executeAction,
  }
}
