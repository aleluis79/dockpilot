// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { dockerApi } from '../services/dockerApi'
import type { ContainerSummary } from '../types/docker'

interface UseContainersOptions {
  /**
   * Si la vista que pinta estos datos está a la vista.
   *
   * El hook se llama desde `App` y no desde una vista, así que **no se desmonta**
   * al cambiar de pestaña: sin esto, desplegar un proyecto desde «Proyectos»
   * dejaba la lista obsoleta y no se notaba hasta tocar el filtro de estado.
   */
  activo?: boolean
}

export function useContainers({ activo = true }: UseContainersOptions = {}) {
  const [containers, setContainers] = useState<ContainerSummary[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<string>('all')
  // Filtro de salud (SPEC-18). Se aplica en el navegador y **no** se pide al
  // daemon, por el mismo motivo que el de estado: los contadores de las píldoras
  // son un censo del host, y pedirle al daemon sólo los `unhealthy` haría que
  // `rawContainers` dejara de ser el censo y los contadores bailarían. El
  // parámetro `?health=` sigue existiendo en la API para quien la llame
  // directamente (SPEC-18 §3.2).
  const [healthFilter, setHealthFilter] = useState<string>('all')
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [actionInProgress, setActionInProgress] = useState<string | null>(null)

  const fetchContainers = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      // **Sin filtro de estado, siempre.** El backend lo soporta, pero filtrar
      // aquí tenía dos efectos malos: cada clic en un filtro era una ida y vuelta
      // al daemon, y —peor— los contadores de las pills se calculaban sobre la
      // lista ya filtrada, así que al elegir «Activos» el contador de «Todos»
      // marcaba el número de activos y los otros dos caían a cero. Son un censo del
      // host, no un recuento de lo que se está viendo.
      const data = await dockerApi.listContainers(true)
      setContainers(data)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error desconocido al cargar contenedores'
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let ignore = false

    const load = async () => {
      try {
        const data = await dockerApi.listContainers(true)
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
  }, [])

  /*
   * Volver a la pestaña también recarga.
   *
   * El efecto de arriba cubre el montaje y el cambio de filtro, que es lo que
   * refrescaba la lista cuando los contenedores solo cambiaban desde esta misma
   * pestaña. Pero el hook vive en `App`, así que no se desmonta al cambiar de
   * vista: desplegar un proyecto desde «Proyectos» la dejaba obsoleta, y el
   * síntoma era que los contenedores nuevos no salían hasta tocar el filtro.
   *
   * Dos detalles que no son obvios:
   *   - Se salta la primera activación, porque el montaje ya pidió la lista y
   *     `activo` empieza en `true`: sin esto, abrir la app la descargaría dos veces.
   *   - `refetch` va en un ref y no en las dependencias, porque cambia de
   *     identidad con `statusFilter` y volvería a disparar este efecto en cada
   *     cambio de filtro, duplicando la petición que ya hace el efecto de arriba.
   */
  const primeraActivacion = useRef(true)
  const refetchRef = useRef(fetchContainers)
  useEffect(() => {
    refetchRef.current = fetchContainers
  }, [fetchContainers])

  useEffect(() => {
    if (!activo) return
    if (primeraActivacion.current) {
      primeraActivacion.current = false
      return
    }
    void refetchRef.current()
  }, [activo])

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

  /**
   * Sustituye un nombre en el inventario local (SPEC-19).
   *
   * Se actualiza en memoria y **no** refetchea: el id del contenedor no ha
   * cambiado, así que la fila es la misma con otro nombre. Un refetch dejaría
   * la lista parpadeando por un cambio que ya se conoce.
   */
  const renameLocal = useCallback((containerId: string, _anterior: string, nuevo: string) => {
    setContainers((previas) =>
      previas.map((c) => (c.id === containerId ? { ...c, name: nuevo } : c))
    )
  }, [])

  /**
   * Refleja en el inventario local un cambio del pin de observación (SPEC-17).
   *
   * Mismo criterio que `renameLocal`, y por el mismo motivo: el backend acaba de
   * confirmar el valor nuevo en la respuesta del `watch`, así que la fila ya
   * tiene su respuesta y no hay nada que volver a preguntar. Un refetch entero
   * por un booleano recorrería el host para descubrir algo que ya sabemos.
   *
   * Sin esto, la píldora «Observando» de la tabla seguía diciendo lo que decía
   * hasta que se pulsara el refresco manual o se cambiara de pestaña.
   */
  const setObservedLocal = useCallback((containerId: string, observed: boolean) => {
    setContainers((previas) =>
      previas.map((c) => (c.id === containerId ? { ...c, observed } : c))
    )
  }, [])

  const filteredContainers = useMemo(() => {
    return containers.filter((c) => {
      // El estado se filtra en el navegador, y **antes** que la búsqueda: así el
      // buscador siempre trabaja sobre lo que se está viendo, que es lo que espera
      // quien escribe en él.
      const matchesStatus =
        statusFilter === 'all' || c.status.toLowerCase() === statusFilter.toLowerCase()
      if (!matchesStatus) return false

      // Salud (SPEC-18). "Con problemas" son los dos estados que piden atención:
      // `unhealthy` ya falló y `starting` está dentro del `start_period`, donde
      // aún no se sabe. Un contenedor sin healthcheck (`none` o sin campo) nunca
      // entra en este filtro: no es un problema, es la ausencia del dato.
      let matchesHealth = true
      if (healthFilter === 'problemas') {
        const salud = c.health?.status
        matchesHealth = salud === 'unhealthy' || salud === 'starting'
      } else if (healthFilter === 'unhealthy') {
        matchesHealth = c.health?.status === 'unhealthy'
      } else if (healthFilter === 'healthy') {
        matchesHealth = c.health?.status === 'healthy'
      }
      if (!matchesHealth) return false

      const matchesSearch =
        c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.image.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.id.toLowerCase().includes(searchQuery.toLowerCase())
      return matchesSearch
    })
  }, [containers, searchQuery, statusFilter, healthFilter])

  return {
    containers: filteredContainers,
    rawContainers: containers,
    loading,
    error,
    statusFilter,
    setStatusFilter,
    healthFilter,
    setHealthFilter,
    searchQuery,
    setSearchQuery,
    actionInProgress,
    renameLocal,
    setObservedLocal,
    refetch: fetchContainers,
    executeAction,
  }
}
