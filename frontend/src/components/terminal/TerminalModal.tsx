import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Terminal as TerminalIcon, X, RotateCw, Eraser } from 'lucide-react'
import type { ContainerSummary } from '../../types/docker'
import { TerminalViewer } from './TerminalViewer'

interface TerminalModalProps {
  isOpen: boolean
  container: ContainerSummary | null
  onClose: () => void
}

export const TerminalModal: React.FC<TerminalModalProps> = ({
  isOpen,
  container,
  onClose,
}) => {
  const [shell, setShell] = useState<string>('/bin/sh')
  const [reconnectKey, setReconnectKey] = useState<number>(0)
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>('connecting')
  const clearTerminalRef = useRef<(() => void) | null>(null)

  const handleClearRef = useCallback((clearFn: () => void) => {
    clearTerminalRef.current = clearFn
  }, [])

  // Cerrar al presionar Escape
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen || !container) return null

  const handleReconnect = () => {
    setConnectionStatus('connecting')
    setReconnectKey((prev) => prev + 1)
  }

  const handleClear = () => {
    clearTerminalRef.current?.()
  }

  const cleanName = container.name?.replace(/^\//, '') || container.id.slice(0, 12)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/85 backdrop-blur-sm animate-in fade-in duration-150 overflow-hidden font-sans"
      onClick={onClose}
    >
      <div
        className="w-full max-w-5xl h-[85vh] min-h-0 flex flex-col bg-zinc-950 border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between p-4 border-b border-zinc-800/80 bg-zinc-900/90">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-emerald-500/10 text-emerald-400 rounded-xl border border-emerald-500/20">
              <TerminalIcon className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold text-zinc-100">Terminal</h2>
                <span className="font-mono text-xs px-2 py-0.5 rounded-md bg-zinc-800 text-zinc-300">
                  {cleanName}
                </span>
                {/* Status Badge */}
                <span
                  className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${
                    connectionStatus === 'connected'
                      ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                      : connectionStatus === 'connecting'
                      ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                      : connectionStatus === 'error'
                      ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                      : 'bg-zinc-800 text-zinc-400'
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      connectionStatus === 'connected'
                        ? 'bg-emerald-400 animate-pulse'
                        : connectionStatus === 'connecting'
                        ? 'bg-amber-400 animate-ping'
                        : connectionStatus === 'error'
                        ? 'bg-rose-400'
                        : 'bg-zinc-500'
                    }`}
                  />
                  <span>
                    {connectionStatus === 'connected'
                      ? 'En vivo'
                      : connectionStatus === 'connecting'
                      ? 'Conectando...'
                      : connectionStatus === 'error'
                      ? 'Error'
                      : 'Desconectado'}
                  </span>
                </span>
              </div>
              <p className="text-xs text-zinc-500 font-mono mt-0.5">{container.image}</p>
            </div>
          </div>

          {/* Acciones del Header */}
          <div className="flex items-center gap-2">
            {/* Selector de Shell */}
            <div className="flex items-center gap-1 bg-zinc-950 px-2 py-1 rounded-xl border border-zinc-800 text-xs">
              <span className="text-zinc-500 text-[11px]">Shell:</span>
              <select
                value={shell}
                onChange={(e) => setShell(e.target.value)}
                className="bg-transparent text-zinc-200 focus:outline-none cursor-pointer font-mono text-xs"
              >
                <option value="/bin/sh" className="bg-zinc-900 text-zinc-200">/bin/sh</option>
                <option value="/bin/bash" className="bg-zinc-900 text-zinc-200">/bin/bash</option>
              </select>
            </div>

            {/* Limpiar pantalla */}
            <button
              type="button"
              onClick={handleClear}
              title="Limpiar terminal"
              className="p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg transition-colors flex items-center gap-1.5 text-xs font-medium cursor-pointer"
            >
              <Eraser className="w-4 h-4" />
              <span className="hidden sm:inline">Limpiar</span>
            </button>

            {/* Reconectar */}
            <button
              type="button"
              onClick={handleReconnect}
              title="Reiniciar sesión de terminal"
              className="p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg transition-colors flex items-center gap-1.5 text-xs font-medium cursor-pointer"
            >
              <RotateCw className="w-4 h-4" />
              <span className="hidden sm:inline">Reconectar</span>
            </button>

            {/* Cerrar */}
            <button
              type="button"
              onClick={onClose}
              title="Cerrar terminal"
              className="p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Visor de Terminal */}
        <div className="flex-1 min-h-0 bg-zinc-950 flex flex-col p-2">
          <TerminalViewer
            key={`${container.id}-${shell}-${reconnectKey}`}
            containerId={container.id}
            shell={shell}
            onStatusChange={setConnectionStatus}
            onClearRef={handleClearRef}
          />
        </div>

        {/* Footer / Barra de Atajos */}
        <div className="shrink-0 px-4 py-2.5 border-t border-zinc-800/80 bg-zinc-900/90 flex flex-wrap items-center justify-between text-[11px] text-zinc-500 gap-2">
          <div className="flex items-center gap-4">
            <span>Atajos útiles:</span>
            <span className="font-mono bg-zinc-800/80 text-zinc-400 px-1.5 py-0.5 rounded">Ctrl+C: Interrumpir</span>
            <span className="font-mono bg-zinc-800/80 text-zinc-400 px-1.5 py-0.5 rounded">exit: Salir</span>
            <span className="font-mono bg-zinc-800/80 text-zinc-400 px-1.5 py-0.5 rounded">Tab: Autocompletar</span>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs rounded-lg transition-colors cursor-pointer"
          >
            Cerrar Terminal
          </button>
        </div>
      </div>
    </div>
  )
}
