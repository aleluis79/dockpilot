// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from 'react'

import { dockerApi } from '../services/dockerApi'
import type { ContainerPrunePreview } from '../types/docker'
import type { ImagePrunePreview } from '../types/image'

/**
 * Los dos preavisos de limpieza (SPEC-21).
 *
 * Lo importante de este hook no es pedir las cosas, es lo que hace con el
 * **fallo**: `preview` a `null` significa «no se sabe», y la interfaz tiene que
 * decirlo. Un error convertido en lista vacía haría que el botón dijera «no hay
 * nada que limpiar» justo cuando lo que no se sabe es si hay algo, que es el
 * peor sitio posible para afirmar que no hay nada.
 */
export interface PruneState<T> {
  preview: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

function usePreview<T>(cargar: () => Promise<T>): PruneState<T> {
  const [preview, setPreview] = useState<T | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  // `cargar` llega como flecha nueva en cada render, y eso era un bucle: si
  // `reload` la tuviera en sus dependencias, cambiaría en cada render, el efecto
  // de abajo se dispararía en cada render, y cada respuesta volvería a
  // renderizar — un GET por render, para siempre. El ref corta el ciclo sin
  // obligar a los llamantes a memorizar nada.
  //
  // Se actualiza en un efecto y no durante el render porque un ref no es estado:
  // escribirlo al renderizar es lo que React marca como propenso a no
  // re-renderizar. El `useRef(cargar)` de arranque deja el primer render correcto
  // antes de que ningún efecto haya corrido.
  const cargarRef = useRef(cargar)
  useEffect(() => {
    cargarRef.current = cargar
  })

  // Un ref y no un `let isMounted` por llamada: aquel era del closure de una
  // ejecución concreta, y como el efecto se re-dispara, la limpieza de una
  // ejecución invalidaba la petición de otra.
  const montado = useRef<boolean>(true)
  useEffect(() => {
    montado.current = true
    return () => {
      montado.current = false
    }
  }, [])

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await cargarRef.current()
      if (montado.current) setPreview(data)
    } catch (err: unknown) {
      if (montado.current) {
        setPreview(null)
        setError(err instanceof Error ? err.message : 'No se pudo calcular la limpieza')
      }
    } finally {
      if (montado.current) setLoading(false)
    }
  }, [])

  // `reload` no se pasa como el efecto: devuelve una promesa, y un efecto que
  // devuelve una promesa es un aviso de React, no una limpieza.
  useEffect(() => {
    void reload()
  }, [reload])

  return { preview, loading, error, reload }
}

export function useImagePrunePreview(): PruneState<ImagePrunePreview> {
  return usePreview<ImagePrunePreview>(() => dockerApi.previewImagePrune())
}

export function useContainerPrunePreview(): PruneState<ContainerPrunePreview> {
  return usePreview<ContainerPrunePreview>(() => dockerApi.previewContainerPrune())
}