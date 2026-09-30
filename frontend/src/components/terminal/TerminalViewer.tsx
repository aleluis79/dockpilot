// SPDX-License-Identifier: AGPL-3.0-or-later
import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useTheme } from '../../hooks/useTheme'
import { getTerminalTheme } from './terminalThemes'

interface TerminalViewerProps {
  containerId: string
  shell?: string
  onStatusChange?: (status: 'connecting' | 'connected' | 'disconnected' | 'error') => void
  onClearRef?: (clearFn: () => void) => void
}

export const TerminalViewer: React.FC<TerminalViewerProps> = ({
  containerId,
  shell = '/bin/sh',
  onStatusChange,
  onClearRef,
}) => {
  const { resolvedTheme } = useTheme()
  const terminalRef = useRef<HTMLDivElement | null>(null)
  const termInstanceRef = useRef<Terminal | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  const onStatusChangeRef = useRef(onStatusChange)
  const onClearRefRef = useRef(onClearRef)

  // El tema solo se lee al construir el Terminal. Los cambios posteriores se
  // aplican sobre la instancia viva (efecto siguiente) para no perder el
  // buffer de salida ni la posición de scroll al conmutar.
  const initialThemeRef = useRef(getTerminalTheme(resolvedTheme))

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange
    onClearRefRef.current = onClearRef
  })

  // Conmutar la paleta en caliente: se reassigna `options.theme` sobre la
  // instancia viva, sin recrear el Terminal.
  useEffect(() => {
    const term = termInstanceRef.current
    if (term) {
      term.options.theme = getTerminalTheme(resolvedTheme)
    }
  }, [resolvedTheme])

  useEffect(() => {
    if (!terminalRef.current) return

    onStatusChangeRef.current?.('connecting')

    // Inicializar instancia de XTerm
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 13,
      lineHeight: 1.2,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      theme: initialThemeRef.current,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(terminalRef.current)
    termInstanceRef.current = term

    // Proveer función de limpiar al componente padre si se solicita
    if (onClearRefRef.current) {
      onClearRefRef.current(() => term.clear())
    }

    try {
      fitAddon.fit()
    } catch {
      // Puede fallar si aún no está montado en layout
    }

    // Configurar WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.host
    const wsUrl = `${protocol}//${host}/ws/containers/${containerId}/terminal?shell=${encodeURIComponent(shell)}&cols=${term.cols || 80}&rows=${term.rows || 24}`

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      onStatusChangeRef.current?.('connected')
      try {
        fitAddon.fit()
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      } catch {
        // En caso de que fit aún no tenga dimensiones
      }
      setTimeout(() => {
        term.focus()
      }, 50)
    }

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data)
        if (payload.type === 'stdout' && payload.data) {
          term.write(payload.data)
        } else if (payload.type === 'system' && payload.data) {
          term.write(`\r\n\x1b[33m${payload.data}\x1b[0m\r\n`)
        } else if (payload.type === 'error' && payload.message) {
          term.write(`\r\n\x1b[31m[Error] ${payload.message}\x1b[0m\r\n`)
        }
      } catch {
        // Mensaje de texto sin formato JSON
        term.write(event.data)
      }
    }

    ws.onerror = () => {
      onStatusChangeRef.current?.('error')
    }

    ws.onclose = () => {
      onStatusChangeRef.current?.('disconnected')
      term.write('\r\n\x1b[90m--- Sesión de terminal desconectada ---\x1b[0m\r\n')
    }

    // Enviar pulsaciones de teclado hacia el backend vía WebSocket
    const dataDisposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'stdin', data }))
      }
    })

    // Sincronizar redimensionamiento
    const handleResize = () => {
      try {
        fitAddon.fit()
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
        }
      } catch {
        // Ignorar si el componente se está desmontando
      }
    }

    window.addEventListener('resize', handleResize)
    let resizeObserver: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        handleResize()
      })
      if (terminalRef.current) {
        resizeObserver.observe(terminalRef.current)
      }
    }

    return () => {
      window.removeEventListener('resize', handleResize)
      resizeObserver?.disconnect()
      dataDisposable.dispose()
      // Los handlers se sueltan ANTES de cerrar el socket. `close()` dispara
      // `onclose` de forma asíncrona, así que sin esto el `onclose` escribía en
      // un Terminal ya dispose() y notificaba 'disconnected' a un padre que ya
      // no lo esperaba. Es lo mismo que hace `useDockerStats` en su limpieza.
      ws.onmessage = null
      ws.onopen = null
      ws.onerror = null
      ws.onclose = null
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
      term.dispose()
    }
  }, [containerId, shell])

  return (
    <div
      ref={terminalRef}
      onClick={() => termInstanceRef.current?.focus()}
      className="w-full h-full min-h-[350px] p-3 bg-inset rounded-b-xl overflow-hidden font-mono cursor-text"
    />
  )
}
