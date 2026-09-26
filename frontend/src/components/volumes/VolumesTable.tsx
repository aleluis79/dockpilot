// SPDX-License-Identifier: AGPL-3.0-or-later
import React from 'react'
import { Box, RefreshCw, AlertCircle, Info, Trash2, HardDrive } from 'lucide-react'
import { formatBytes } from '../../utils/format'
import type { VolumeSummary } from '../../types/volume'

interface VolumesTableProps {
  volumes: VolumeSummary[]
  loading: boolean
  error: string | null
  onRefresh: () => void
  onInspect: (volume: VolumeSummary) => void
  onRequestDelete: (volume: VolumeSummary) => void
}

const formatDate = (iso: string): string => {
  if (!iso) return '-'
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return '-'
  return parsed.toLocaleDateString('es-ES', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  })
}

export const VolumesTable: React.FC<VolumesTableProps> = ({
  volumes,
  loading,
  error,
  onRefresh,
  onInspect,
  onRequestDelete,
}) => {
  if (loading && volumes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-fg-muted">
        <RefreshCw className="w-8 h-8 animate-spin mb-3 text-blue-500" />
        <p className="text-sm">Cargando volúmenes...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center p-12 bg-surface/50 rounded-xl border border-default text-fg-muted">
        <AlertCircle className="w-10 h-10 mb-2 stroke-1 text-rose-500" />
        <p className="text-sm font-medium text-fg">{error}</p>
        <button
          type="button"
          onClick={onRefresh}
          title="Reintentar carga de volúmenes"
          className="mt-4 px-3 py-1.5 text-xs font-medium text-fg bg-elevated hover:bg-fg/10 rounded-lg transition-colors cursor-pointer"
        >
          Reintentar
        </button>
      </div>
    )
  }

  if (volumes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-12 bg-surface/50 rounded-xl border border-default text-fg-muted">
        <Box className="w-10 h-10 mb-2 stroke-1 text-fg-subtle" />
        <p className="text-sm font-medium text-fg">No hay volúmenes</p>
        <p className="text-xs text-fg-subtle mt-1">
          Docker crea volúmenes al montar un contenedor; aquí aparecerán cuando lo hagas
        </p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-default bg-surface/40 backdrop-blur">
      <table className="w-full text-left text-sm text-fg-muted">
        <thead className="bg-surface/80 text-xs uppercase tracking-wider text-fg-subtle border-b border-default">
          <tr>
            <th className="py-3.5 px-4 font-semibold">Volumen</th>
            <th className="py-3.5 px-4 font-semibold">Tamaño</th>
            <th className="py-3.5 px-4 font-semibold">Creado</th>
            <th className="py-3.5 px-4 font-semibold">Uso</th>
            <th className="py-3.5 px-4 font-semibold text-right">Acciones</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-default/60">
          {volumes.map((volume) => (
            <tr key={volume.name} className="hover:bg-elevated/40 transition-colors group">
              <td className="py-3.5 px-4">
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`font-mono text-sm transition-colors ${
                        volume.is_anonymous
                          ? 'text-fg-subtle'
                          : 'text-fg group-hover:text-blue-600 dark:group-hover:text-blue-400'
                      }`}
                      title={volume.name}
                    >
                      {volume.is_anonymous ? `${volume.name.slice(0, 12)}…` : volume.name}
                    </span>
                    {volume.is_anonymous && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-elevated text-fg-subtle border border-default">
                        <HardDrive className="w-2.5 h-2.5" />
                        anónimo
                      </span>
                    )}
                  </div>
                  <span className="font-mono text-[10px] text-fg-subtle truncate max-w-sm">
                    {volume.mountpoint}
                  </span>
                </div>
              </td>
              <td className="py-3.5 px-4 font-mono text-xs tabular-nums">
                {formatBytes(volume.size)}
              </td>
              <td className="py-3.5 px-4 text-xs">{formatDate(volume.created_at)}</td>
              <td className="py-3.5 px-4">
                {volume.ref_count > 0 ? (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                    En uso ({volume.ref_count})
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-elevated text-fg-muted border border-default">
                    <span className="w-1.5 h-1.5 rounded-full bg-fg-subtle" />
                    Libre
                  </span>
                )}
              </td>
              <td className="py-3.5 px-4">
                <div className="flex items-center justify-end gap-1">
                  <button
                    type="button"
                    onClick={() => onInspect(volume)}
                    title={`Ver el detalle de ${volume.name}`}
                    className="p-1.5 text-fg-muted hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-500/10 rounded transition-colors cursor-pointer"
                  >
                    <Info className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onRequestDelete(volume)}
                    title={`Eliminar el volumen ${volume.name}`}
                    className="p-1.5 text-fg-muted hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-500/10 rounded transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
