import React, { useState, useEffect, useRef, useMemo } from 'react'
import {
  Search,
  Trash2,
  Copy,
  Check,
  ArrowDown,
  X,
  FileText,
  AlertCircle,
} from 'lucide-react'
import type { LogEntry } from '../../types/log'

interface LogsViewerProps {
  logs: LogEntry[]
  connected: boolean
  containerName: string
  error?: string | null
  onClear: () => void
  onClose?: () => void
}

export const LogsViewer: React.FC<LogsViewerProps> = ({
  logs,
  connected,
  containerName,
  error,
  onClear,
  onClose,
}) => {
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [autoScroll, setAutoScroll] = useState<boolean>(true)
  const [copied, setCopied] = useState<boolean>(false)
  const [streamFilter, setStreamFilter] = useState<'all' | 'stdout' | 'stderr'>('all')

  const containerRef = useRef<HTMLDivElement | null>(null)

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      if (streamFilter !== 'all' && log.stream !== 'system' && log.stream !== streamFilter) {
        return false
      }
      if (!searchQuery) return true
      return log.message.toLowerCase().includes(searchQuery.toLowerCase())
    })
  }, [logs, searchQuery, streamFilter])

  // Manejo de auto-scroll hacia abajo cuando entran nuevos logs
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [filteredLogs, autoScroll])

  const handleScroll = () => {
    if (!containerRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 40
    if (!isAtBottom && autoScroll) {
      setAutoScroll(false)
    } else if (isAtBottom && !autoScroll) {
      setAutoScroll(true)
    }
  }

  const handleCopy = async () => {
    const text = filteredLogs
      .map((l) => (l.timestamp ? `[${l.timestamp}] ${l.message}` : l.message))
      .join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface text-fg rounded-2xl border border-default shadow-2xl overflow-hidden font-sans">
      {/* Barra Superior / Header */}
      <div className="shrink-0 flex flex-wrap items-center justify-between p-4 bg-surface border-b border-default gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-xl border border-blue-500/20">
            <FileText className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-fg">{containerName}</h2>
              <span className="text-xs text-fg-muted font-mono">logs</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-fg-muted mt-0.5">
              <span
                className={`w-2 h-2 rounded-full ${
                  connected ? 'bg-emerald-400 animate-pulse' : 'bg-fg-subtle'
                }`}
              />
              <span className="text-[11px]">
                {connected ? 'Streaming en vivo' : 'Desconectado'}
              </span>
            </div>
          </div>
        </div>

        {/* Toolbar de Controles */}
        <div className="flex items-center flex-wrap gap-2">
          {/* Búsqueda */}
          <div className="relative w-40 sm:w-56">
            <Search className="w-3.5 h-3.5 text-fg-muted absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Buscar en logs..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-inset border border-default rounded-lg text-fg placeholder-fg-muted focus:outline-none focus:border-blue-500/50"
            />
          </div>

          {/* Filtro Stream */}
          <select
            value={streamFilter}
            onChange={(e) => setStreamFilter(e.target.value as 'all' | 'stdout' | 'stderr')}
            className="text-xs bg-inset border border-default rounded-lg px-2 py-1.5 text-fg focus:outline-none focus:border-blue-500/50 cursor-pointer"
          >
            <option value="all">Todos</option>
            <option value="stdout">stdout</option>
            <option value="stderr">stderr</option>
          </select>

          {/* Toggle Auto-scroll */}
          <button
            onClick={() => setAutoScroll((prev) => !prev)}
            title={autoScroll ? 'Desactivar auto-scroll' : 'Activar auto-scroll'}
            className={`p-1.5 rounded-lg border text-xs flex items-center gap-1 transition-colors cursor-pointer ${
              autoScroll
                ? 'bg-blue-600/20 text-blue-600 dark:text-blue-400 border-blue-500/30'
                : 'bg-surface text-fg-muted border-default hover:text-fg'
            }`}
          >
            <ArrowDown className={`w-3.5 h-3.5 ${autoScroll ? 'text-blue-600 dark:text-blue-400' : ''}`} />
            <span className="hidden md:inline text-[11px]">Auto-scroll</span>
          </button>

          {/* Copiar */}
          <button
            onClick={handleCopy}
            title="Copiar logs al portapapeles"
            className="p-1.5 text-fg-muted hover:text-fg hover:bg-fg/10 rounded-lg border border-default transition-colors cursor-pointer"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>

          {/* Limpiar */}
          <button
            onClick={onClear}
            title="Limpiar consola de logs"
            className="p-1.5 text-fg-muted hover:text-rose-700 dark:hover:text-rose-400 hover:bg-fg/10 rounded-lg border border-default transition-colors cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>

          {/* Cerrar modal (botón X destacado) */}
          {onClose && (
            <button
              onClick={onClose}
              title="Cerrar visor (Esc)"
              className="p-1.5 text-fg-muted hover:text-white hover:bg-fg/10 rounded-lg border border-strong/60 transition-colors ml-1 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Banner de Error (si hay) */}
      {error && (
        <div className="shrink-0 flex items-center gap-2 p-3 bg-rose-500/10 border-b border-rose-500/20 text-rose-700 dark:text-rose-400 text-xs">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Contenedor de Líneas de Log con Scroll Forzado */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto p-4 font-mono text-xs leading-relaxed bg-inset space-y-0.5 select-text"
      >
        {filteredLogs.length === 0 ? (
          <div className="py-12 text-center text-fg-subtle font-sans">
            <p className="text-sm">No hay registros para mostrar</p>
            {searchQuery && (
              <p className="text-xs text-fg-subtle mt-1">
                Ninguna línea coincide con "{searchQuery}"
              </p>
            )}
          </div>
        ) : (
          filteredLogs.map((log, idx) => {
            const isStderr = log.stream === 'stderr'
            const isSystem = log.stream === 'system'

            if (isSystem) {
              return (
                <div
                  key={idx}
                  className="py-1 text-center text-[11px] text-blue-600/80 dark:text-blue-400/80 italic border-y border-default/60 my-1 font-sans"
                >
                  {log.message}
                </div>
              )
            }

            return (
              <div
                key={idx}
                className={`flex items-start gap-2 hover:bg-fg/10 px-1.5 py-0.5 rounded transition-colors ${
                  isStderr ? 'bg-rose-500/10 dark:bg-rose-950/20 text-rose-700 dark:text-rose-300' : 'text-fg'
                }`}
              >
                {log.timestamp && (
                  <span className="text-fg-subtle select-none shrink-0 text-[10px]">
                    {log.timestamp.split('T')[1]?.split('.')[0] || log.timestamp}
                  </span>
                )}
                {isStderr && (
                  <span className="text-[10px] font-semibold text-rose-700 dark:text-rose-400 bg-rose-500/10 px-1 rounded select-none shrink-0">
                    ERR
                  </span>
                )}
                <span className="break-all whitespace-pre-wrap">{log.message}</span>
              </div>
            )
          })
        )}
      </div>

      {/* Footer Info con botón de cierre adicional */}
      <div className="shrink-0 flex items-center justify-between px-4 py-2.5 bg-surface border-t border-default text-xs text-fg-muted font-sans">
        <div className="flex items-center gap-4">
          <span>Líneas mostradas: <strong className="text-fg">{filteredLogs.length}</strong></span>
          {!autoScroll && (
            <button
              onClick={() => {
                setAutoScroll(true)
                if (containerRef.current) {
                  containerRef.current.scrollTop = containerRef.current.scrollHeight
                }
              }}
              className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline flex items-center gap-1 font-medium cursor-pointer"
            >
              <ArrowDown className="w-3.5 h-3.5" />
              Reanudar scroll
            </button>
          )}
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="px-3.5 py-1 bg-elevated hover:bg-fg/10 text-fg hover:text-white rounded-lg text-xs font-medium transition-colors cursor-pointer"
          >
            Cerrar
          </button>
        )}
      </div>
    </div>
  )
}
