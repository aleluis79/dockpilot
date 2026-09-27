// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from 'react'
import {
  ChevronUp,
  Server,
  Cpu,
  MemoryStick,
  HardDrive,
  Layers,
  X,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react'
import { SystemDetailPanel } from './SystemDetailPanel'
import { useSystemOverview } from '../../hooks/useSystemOverview'
import { formatBytes } from '../../utils/format'
import type { CleanupTab } from '../../types/system'

interface SystemSummaryBarProps {
  /** Lleva a la vista que ya sabe liberar el espacio. Opcional: sin él, sin enlaces. */
  onNavigateTab?: (tab: CleanupTab) => void
}

/**
 * Franja de resumen del host, visible sobre las pestañas.
 *
 * Muestra el espacio **recuperable** en lugar del total ocupado: lo accionable
 * es lo que se puede liberar. El detalle completo vive en `SystemDetailPanel`.
 */
export function SystemSummaryBar({ onNavigateTab }: SystemSummaryBarProps) {
  const { overview, loading, refreshing, error, refetch } = useSystemOverview()
  const [detailOpen, setDetailOpen] = useState<boolean>(false)

  const botonRefrescar = (
    <button
      type="button"
      onClick={() => void refetch()}
      disabled={refreshing}
      aria-label="Refrescar resumen del host"
      title="Refrescar resumen del host"
      className="p-1.5 rounded hover:bg-elevated-hover transition-colors disabled:opacity-50"
    >
      <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
    </button>
  )

  if (loading) {
    return (
      <div
        className="flex items-center gap-2 py-2 text-xs text-fg-subtle border-b border-default bg-elevated"
        data-testid="system-summary"
      >
        Leyendo el estado del host...
        <span className="ml-auto">{botonRefrescar}</span>
      </div>
    )
  }

  // Sin datos no hay nada que refrescar que mejorar, pero sí una salida: sin
  // este botón, un fallo de red al cargar dejaba la franja bloqueada hasta
  // recargar la página a mano.
  if (!overview) {
    return (
      <div
        className="flex items-center gap-2 py-2 text-xs text-fg-subtle border-b border-default bg-elevated"
        data-testid="system-summary"
      >
        <Server className="w-3.5 h-3.5" />
        <span>Resumen del host no disponible: {error ?? 'sin respuesta del daemon'}</span>
        <span className="ml-auto">{botonRefrescar}</span>
      </div>
    )
  }

  const { info, usage } = overview
  const totalReclaimable = usage.images.reclaimable + usage.volumes.reclaimable

  return (
    <div className="border border-default rounded-lg bg-elevated" data-testid="system-summary">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 py-2 text-xs text-fg-subtle">
        <span className="flex items-center gap-1.5" title="Versión del Docker Engine">
          <Server className="w-3.5 h-3.5" />
          <span className="font-mono text-fg">{info.server_version || 'desconocida'}</span>
        </span>

        <span className="flex items-center gap-1.5" title="Núcleos lógicos">
          <Cpu className="w-3.5 h-3.5" />
          <span>
            {info.ncpu} <span className="sr-only">núcleos</span>
          </span>
        </span>

        <span className="flex items-center gap-1.5" title="Memoria RAM total">
          <MemoryStick className="w-3.5 h-3.5" />
          <span>{formatBytes(info.memory_total)}</span>
        </span>

        <span className="flex items-center gap-1.5" title="Driver de almacenamiento">
          <HardDrive className="w-3.5 h-3.5" />
          <span className="font-mono">{info.storage_driver || 'desconocido'}</span>
        </span>

        <span title="Contenedores e imágenes del host">
          {info.containers_total} contenedores · {info.images_total} imágenes
        </span>

        <span
          className="flex items-center gap-1.5"
          title="Espacio que el daemon considera recuperable"
        >
          <Layers className="w-3.5 h-3.5" />
          <span>
            {formatBytes(totalReclaimable)} recuperable
          </span>
        </span>

        {/* Un refresco fallido con datos ya en pantalla no debe borrar lo que se
            está leyendo: se avisa en línea y se conserva la cifra anterior. */}
        {error && (
          <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
            <AlertTriangle className="w-3.5 h-3.5" />
            No se pudo actualizar: {error}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          {botonRefrescar}
          <button
            type="button"
            onClick={() => setDetailOpen((v) => !v)}
            className="flex items-center gap-1 px-2 py-1 rounded hover:bg-elevated-hover transition-colors"
            aria-expanded={detailOpen}
          >
            Detalle
            <ChevronUp className={`w-3.5 h-3.5 transition-transform ${detailOpen ? '' : 'rotate-180'}`} />
          </button>
        </div>
      </div>

      {detailOpen && (
        <div className="relative border-t border-default">
          <button
            type="button"
            onClick={() => setDetailOpen(false)}
            className="absolute top-2 right-2 p-1 rounded hover:bg-elevated-hover transition-colors z-10"
            aria-label="Cerrar detalle"
          >
            <X className="w-3.5 h-3.5" />
          </button>
          <SystemDetailPanel overview={overview} onNavigateTab={onNavigateTab} />
        </div>
      )}
    </div>
  )
}
