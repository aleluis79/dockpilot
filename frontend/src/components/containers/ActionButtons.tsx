// SPDX-License-Identifier: AGPL-3.0-or-later
import React from 'react'
import { Play, Square, RotateCw, Pause, PlayCircle, Trash2, Loader2, FileText, Terminal as TerminalIcon, Activity, ShieldAlert } from 'lucide-react'
import type { ContainerSummary } from '../../types/docker'
import { esContenedorDelPanel, MOTIVO_PROTEGIDO } from '../../utils/proteccion'

interface ActionButtonsProps {
  container: ContainerSummary
  actionInProgress?: string | null
  onAction: (
    id: string,
    action: 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'remove',
    force?: boolean
  ) => void
  onViewLogs?: (container: ContainerSummary) => void
  onViewStats?: (container: ContainerSummary) => void
  onOpenTerminal?: (container: ContainerSummary) => void
  onRequestDelete?: (container: ContainerSummary) => void
}

export const ActionButtons: React.FC<ActionButtonsProps> = ({
  container,
  actionInProgress,
  onAction,
  onViewLogs,
  onViewStats,
  onOpenTerminal,
  onRequestDelete,
}) => {
  const isRunning = container.status.toLowerCase() === 'running'
  const isPaused = container.status.toLowerCase() === 'paused'
  const isBusy = actionInProgress?.startsWith(container.id)
  // Una pieza del panel no se puede parar, pausar ni borrar desde aquí. Iniciar,
  // reanudar y reiniciar SÍ se dejan, y es lo importante: si el backend ya está
  // caído, el botón de iniciar es lo único que lo levanta (SPEC-00).
  const protegido = esContenedorDelPanel(container)

  if (isBusy) {
    return (
      <div className="flex items-center gap-1.5 text-fg-muted text-xs py-1 px-2 bg-elevated/60 rounded">
        <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600 dark:text-blue-400" />
        <span>Procesando...</span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {!isRunning ? (
        <button
          onClick={() => onAction(container.id, 'start')}
          title={`Iniciar contenedor ${container.name}`}
          className="p-1.5 text-fg-muted hover:text-emerald-700 dark:hover:text-emerald-400 hover:bg-emerald-500/10 rounded transition-colors"
        >
          <Play className="w-4 h-4" />
        </button>
      ) : (
        !protegido && (
          <button
            onClick={() => onAction(container.id, 'stop')}
            title={`Detener contenedor ${container.name}`}
            className="p-1.5 text-fg-muted hover:text-amber-700 dark:hover:text-amber-400 hover:bg-amber-500/10 rounded transition-colors"
          >
            <Square className="w-4 h-4" />
          </button>
        )
      )}

      <button
        onClick={() => onAction(container.id, 'restart')}
        title={`Reiniciar contenedor ${container.name}`}
        className="p-1.5 text-fg-muted hover:text-blue-700 dark:hover:text-blue-400 hover:bg-blue-500/10 rounded transition-colors"
      >
        <RotateCw className="w-4 h-4" />
      </button>

      {isRunning && !protegido && (
        <button
          onClick={() => onAction(container.id, 'pause')}
          title={`Pausar contenedor ${container.name}`}
          className="p-1.5 text-fg-muted hover:text-yellow-700 dark:hover:text-yellow-400 hover:bg-yellow-500/10 rounded transition-colors"
        >
          <Pause className="w-4 h-4" />
        </button>
      )}

      {isPaused && (
        <button
          onClick={() => onAction(container.id, 'unpause')}
          title={`Reanudar contenedor ${container.name}`}
          className="p-1.5 text-fg-muted hover:text-emerald-700 dark:hover:text-emerald-400 hover:bg-emerald-500/10 rounded transition-colors"
        >
          <PlayCircle className="w-4 h-4" />
        </button>
      )}

      {onViewLogs && (
        <button
          type="button"
          onClick={() => onViewLogs(container)}
          title={`Ver logs de ${container.name}`}
          className="p-1.5 text-fg-muted hover:text-blue-700 dark:hover:text-blue-400 hover:bg-blue-500/10 rounded transition-colors cursor-pointer"
        >
          <FileText className="w-4 h-4" />
        </button>
      )}

      {isRunning && onViewStats && (
        <button
          type="button"
          onClick={() => onViewStats(container)}
          title={`Ver métricas de ${container.name}`}
          className="p-1.5 text-fg-muted hover:text-blue-700 dark:hover:text-blue-400 hover:bg-blue-500/10 rounded transition-colors cursor-pointer"
        >
          <Activity className="w-4 h-4" />
        </button>
      )}

      {isRunning && onOpenTerminal && (
        <button
          type="button"
          onClick={() => onOpenTerminal(container)}
          title={`Abrir terminal interactivo de ${container.name}`}
          className="p-1.5 text-fg-muted hover:text-emerald-700 dark:hover:text-emerald-400 hover:bg-emerald-500/10 rounded transition-colors cursor-pointer"
        >
          <TerminalIcon className="w-4 h-4" />
        </button>
      )}

      {protegido ? (
        <span title={MOTIVO_PROTEGIDO} data-testid="accion-protegida" className="p-1.5 text-amber-600/70 dark:text-amber-400/70">
          <ShieldAlert className="w-4 h-4" />
        </span>
      ) : (
        <button
          onClick={() =>
            onRequestDelete ? onRequestDelete(container) : onAction(container.id, 'remove')
          }
          title={`Eliminar contenedor ${container.name}`}
          className="p-1.5 text-fg-muted hover:text-rose-700 dark:hover:text-rose-400 hover:bg-rose-500/10 rounded transition-colors"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      )}
    </div>
  )
}
