// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from 'react'

import { dockerApi } from '../services/dockerApi'

/**
 * Qué contenedores están fijados, y cuánto tarda el panel en enterarse.
 *
 * El pin vive en el backend y en memoria (§4.3), así que se puede ir sin que
 * nadie avise: el TTL se lleva el anillo con el pin dentro, y un reinicio del
 * backend se lleva todos de golpe. La tabla no tiene forma de notar ninguna de
 * las dos cosas si nadie pregunta, y preguntar con `GET /containers` es pagar
 * una `containers.list()` por enterarse de un booleano. Por eso esta ruta
 * aparte: sale de un diccionario en memoria y no toca el daemon.
 *
 * **La respuesta es la única que escribe.** No hay valor optimista en ningún
 * sitio, y es a propósito: si el toggle escribiera a mano y esta ruta llegara
 * después con lo que sabía antes del POST, la píldora parpadearía al revés
 * durante un ciclo entero. Con una sola fuente no hay carrera que ganar.
 *
 * El sondeo es de 15 s porque lo único que cambia sin intervención es lo raro —
 * un reinicio del backend, el TTL—. Los cambios que hace el operador no esperan
 * a este reloj: llegan por `refresh()`, que el modal llama al mover el pin.
 */
const INTERVALO_MS = 15_000

/** Ordena para comparar sin depender del orden que devuelva el servidor. */
function mismaLista(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export interface ObservedState {
  /** Ids cortos de los fijados. Vacío hasta la primera respuesta. */
  ids: string[];
  /** Pedirlo otra vez ahora. La llama el modal al mover el pin. */
  refresh: () => void;
}

export function useObservedIds({ activo = true }: { activo?: boolean } = {}): ObservedState {
  const [ids, setIds] = useState<string[]>([])
  const [tick, setTick] = useState(0)

  // Un flag y no un estado: un fallo en esta ruta no es un error del panel, es
  // una marca que no se ha podido leer. Ponerlo en `error` de la tabla haría
  // aparecer una alerta roja por algo que no ha fallado.
  const montado = useRef(true)
  useEffect(() => {
    montado.current = true
    return () => {
      montado.current = false
    }
  }, [])

  const refresh = useCallback(() => setTick((n) => n + 1), [])

  useEffect(() => {
    let cancelado = false

    const leer = async () => {
      try {
        const data = await dockerApi.listObserved()
        if (cancelado || !montado.current) return
        const ordenados = [...data].sort()
        // Referencia estable si no cambió nada: si el array fuera nuevo en cada
        // tic, todo el que dependa de él se re-renderizaría para nada.
        setIds((prev) => (mismaLista(prev, ordenados) ? prev : ordenados))
      } catch {
        // Sin mensaje a propósito. La lista de contenedores sigue siendo válida
        // y lo único que puede quedar viejo es una marca; avisar de eso sería
        // más ruido que el propio desfase.
      }
    }

    if (!activo) return

    void leer()
    const reloj = setInterval(() => void leer(), INTERVALO_MS)
    return () => {
      cancelado = true
      clearInterval(reloj)
    }
  }, [activo, tick])

  return { ids, refresh }
}