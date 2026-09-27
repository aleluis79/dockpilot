// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from 'react'
import { wsUrl } from '../services/wsUrl'
import type { ComposeAction, ComposeCommandParams, ComposeMessage } from '../types/compose'

export interface LineaCompose {
  stream: 'stdout' | 'stderr'
  data: string
}

interface UseComposeCommandOptions {
  /** Refresca el inventario de proyectos: lo que se acaba de cambiar. */
  onRefrescar?: () => void
}

/** Acciones cuyo éxito deja obsoleto el inventario de SPEC-11. */
const INVALIDAN_INVENTARIO: ReadonlySet<ComposeAction> = new Set<ComposeAction>([
  'up',
  'down',
  'stop',
  'pull',
])

/**
 * Canal de una acción del ciclo de vida de un proyecto.
 *
 * El socket se abre y se cierra con la acción. Cancelar **no** cierra el socket:
 * se envía `cancel` y se espera al `exit` del servidor, porque es el proceso del
 * backend el que tiene que matar al de compose, y el usuario necesita saber
 * cuándo lo ha conseguido.
 */
export function useComposeCommand({ onRefrescar }: UseComposeCommandOptions = {}) {
  const [output, setOutput] = useState<LineaCompose[]>([])
  const [command, setCommand] = useState<string[]>([])
  const [enCurso, setEnCurso] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [duracionMs, setDuracionMs] = useState<number | null>(null)
  const [cancelado, setCancelado] = useState<boolean>(false)
  const socketRef = useRef<WebSocket | null>(null)
  // Último `onRefrescar` sin meterte en las dependencias: así el socket no se
  // reconecta cada vez que `App` recrea el callback. Se sincroniza **en un
  // efecto**, nunca durante el render.
  const refrescarRef = useRef(onRefrescar)
  useEffect(() => {
    refrescarRef.current = onRefrescar
  }, [onRefrescar])

  const cerrar = useCallback(() => {
    const socket = socketRef.current
    socketRef.current = null
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close()
  }, [])

  useEffect(() => cerrar, [cerrar])

  const ejecutar = useCallback(
    (params: ComposeCommandParams) => {
      // Un canal anterior podría seguir emitiendo y mezclar su salida con la
      // nueva. Se cierra antes de abrir el siguiente.
      cerrar()

      setOutput([])
      setCommand([])
      setError(null)
      setExitCode(null)
      setDuracionMs(null)
      setCancelado(false)
      setEnCurso(true)

      const parametros = new URLSearchParams({ path: params.path })
      if (params.project_name) parametros.set('project_name', params.project_name)
      if (params.service) parametros.set('service', params.service)
      if (params.follow !== undefined) parametros.set('follow', String(params.follow))
      if (params.volumes !== undefined) parametros.set('volumes', String(params.volumes))

      const socket = new WebSocket(
        wsUrl(`/ws/compose/${params.action}?${parametros.toString()}`)
      )
      socketRef.current = socket

      /*
       * Guarda de socket obsoleto: los callbacks solo hacen algo si su socket
       * sigue siendo el actual.
       *
       * Sin esto, cerrar un socket **a medio conectar** dispara `error` en el
       * navegador, y eso pasa en cada desmontaje: al cerrar y volver a montar
       * (StrictMode lo hace dos veces en desarrollo) se aborta el handshake en
       * curso del socket viejo. El resultado era un cartel de "no se pudo abrir
       * el canal" mientras los logs llegaban igual, que es lo más confuso que
       * puede verse.
       *
       * También cubre el caso de encadenar dos acciones: la salida del socket
       * anterior no se mezcla con la nueva.
       */
      const esElActual = () => socketRef.current === socket

      socket.onopen = () => {
        if (!esElActual()) return
        setError(null)
      }

      socket.onmessage = (evento) => {
        if (!esElActual()) return
        let mensaje: ComposeMessage
        try {
          mensaje = JSON.parse(evento.data as string) as ComposeMessage
        } catch {
          return
        }

        switch (mensaje.type) {
          case 'start':
            setCommand(mensaje.command)
            break
          case 'output':
            setOutput((previas) => [...previas, { stream: mensaje.stream, data: mensaje.data }])
            break
          case 'exit': {
            setEnCurso(false)
            setExitCode(mensaje.code)
            setDuracionMs(mensaje.duration_ms)
            // El servidor manda -1 cuando el proceso recibe SIGKILL: no tiene un
            // código real que reportar. No es un fallo de compose.
            if (mensaje.code === -1) setCancelado(true)
            if (mensaje.code === 0 && INVALIDAN_INVENTARIO.has(mensaje.action as ComposeAction)) {
              refrescarRef.current?.()
            }
            break
          }
          case 'error':
            setEnCurso(false)
            setError(mensaje.message)
            break
        }
      }

      socket.onerror = () => {
        if (!esElActual()) return
        setEnCurso(false)
        setError('No se pudo abrir el canal con el backend')
      }

      socket.onclose = () => {
        // El socket puede cerrarse sin `exit` (error de red, o cierre normal al
        // desmontar). Sin esto la acción se quedaría "en curso" para siempre.
        if (!esElActual()) return
        setEnCurso(false)
      }
    },
    [cerrar]
  )

  const cancelar = useCallback(() => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ type: 'cancel' }))
  }, [])

  const limpiar = useCallback(() => {
    cerrar()
    setOutput([])
    setCommand([])
    setError(null)
    setExitCode(null)
    setDuracionMs(null)
    setCancelado(false)
    setEnCurso(false)
  }, [cerrar])

  return {
    output,
    command,
    enCurso,
    error,
    exitCode,
    duracionMs,
    cancelado,
    ejecutar,
    cancelar,
    limpiar,
  }
}
