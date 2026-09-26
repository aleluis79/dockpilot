// SPDX-License-Identifier: AGPL-3.0-or-later
import React from 'react'
import { Box, RefreshCw, AlertCircle, Play, Info, Trash2 } from 'lucide-react'
import { formatBytes } from '../../utils/format'
import type { LocalImageSummary } from '../../types/image'

interface ImagesTableProps {
  images: LocalImageSummary[]
  loading: boolean
  error: string | null
  onRefresh: () => void
  onRun: (image: LocalImageSummary) => void
  onInspect: (image: LocalImageSummary) => void
  onRequestDelete: (image: LocalImageSummary) => void
  /** Mensaje del estado vacío: distinguible entre host vacío y sin coincidencias. */
  emptyMessage?: string
  emptyHint?: string
}

const formatDate = (epoch: number): string => {
  if (!epoch) return '-'
  return new Date(epoch * 1000).toLocaleDateString('es-ES', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  })
}

export const ImagesTable: React.FC<ImagesTableProps> = ({
  images,
  loading,
  error,
  onRefresh,
  onRun,
  onInspect,
  onRequestDelete,
  emptyMessage = 'No hay imágenes locales',
  emptyHint = 'Descarga una imagen para poder crear contenedores con ella',
}) => {
  if (loading && images.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-fg-muted">
        <RefreshCw className="w-8 h-8 animate-spin mb-3 text-blue-500" />
        <p className="text-sm">Cargando imágenes locales...</p>
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
          title="Reintentar carga de imágenes"
          className="mt-4 px-3 py-1.5 text-xs font-medium text-fg bg-elevated hover:bg-fg/10 rounded-lg transition-colors cursor-pointer"
        >
          Reintentar
        </button>
      </div>
    )
  }

  if (images.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-12 bg-surface/50 rounded-xl border border-default text-fg-muted">
        <Box className="w-10 h-10 mb-2 stroke-1 text-fg-subtle" />
        <p className="text-sm font-medium text-fg">{emptyMessage}</p>
        <p className="text-xs text-fg-subtle mt-1">{emptyHint}</p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-default bg-surface/40 backdrop-blur">
      <table className="w-full text-left text-sm text-fg-muted">
        <thead className="bg-surface/80 text-xs uppercase tracking-wider text-fg-subtle border-b border-default">
          <tr>
            <th className="py-3.5 px-4 font-semibold">Imagen</th>
            <th className="py-3.5 px-4 font-semibold">Tamaño</th>
            <th className="py-3.5 px-4 font-semibold">Creada</th>
            <th className="py-3.5 px-4 font-semibold">Estado</th>
            <th className="py-3.5 px-4 font-semibold text-right">Acciones</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-default/60">
          {images.map((image) => {
            const primary = image.tags[0] ?? image.id
            return (
              <tr key={image.id} className="hover:bg-elevated/40 transition-colors group">
                <td className="py-3.5 px-4">
                  <div className="flex flex-col gap-1">
                    <span className="font-mono text-sm text-fg group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                      {primary}
                    </span>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {image.tags.slice(1).map((tag) => (
                        <span
                          key={tag}
                          className="px-1.5 py-0.5 font-mono text-[10px] rounded bg-elevated text-fg-muted border border-default"
                        >
                          {tag}
                        </span>
                      ))}
                      <span className="font-mono text-[10px] text-fg-subtle">{image.id}</span>
                    </div>
                  </div>
                </td>
                <td className="py-3.5 px-4 font-mono text-xs tabular-nums">
                  {formatBytes(image.size)}
                </td>
                <td className="py-3.5 px-4 text-xs">{formatDate(image.created)}</td>
                <td className="py-3.5 px-4">
                  {image.containers > 0 ? (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                      En uso ({image.containers})
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
                      onClick={() => onRun(image)}
                      title={`Ejecutar un contenedor con ${primary}`}
                      className="p-1.5 text-fg-muted hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-500/10 rounded transition-colors cursor-pointer"
                    >
                      <Play className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onInspect(image)}
                      title={`Ver el detalle de ${primary}`}
                      className="p-1.5 text-fg-muted hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-500/10 rounded transition-colors cursor-pointer"
                    >
                      <Info className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onRequestDelete(image)}
                      title={`Eliminar la imagen ${primary}`}
                      className="p-1.5 text-fg-muted hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-500/10 rounded transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
