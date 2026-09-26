// SPDX-License-Identifier: AGPL-3.0-or-later
import React, { useEffect, useState } from 'react'
import { X, Layers, Settings2, History, Loader2, AlertCircle, Hash, User, Folder } from 'lucide-react'
import { MODAL_OVERLAY } from '../ui/modalOverlay'
import { dockerApi } from '../../services/dockerApi'
import { formatBytes } from '../../utils/format'
import type { ImageDetail } from '../../types/image'

interface ImageDetailModalProps {
  imageId: string | null
  onClose: () => void
}

const formatDate = (epoch: number): string => {
  if (!epoch) return '-'
  return new Date(epoch * 1000).toLocaleString('es-ES', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const joinCommand = (value: string[] | null | undefined): string =>
  value && value.length > 0 ? value.join(' ') : '(ninguno)'

export const ImageDetailModal: React.FC<ImageDetailModalProps> = ({ imageId, onClose }) => {
  const [detail, setDetail] = useState<ImageDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  // El estado de carga se deriva en lugar de guardarse: mientras no haya
  // detalle ni error, hay una petición en vuelo.
  const loading = detail === null && error === null

  useEffect(() => {
    if (!imageId) return

    let isMounted = true
    setError(null)

    dockerApi
      .getImage(imageId)
      .then((data) => {
        if (isMounted) setDetail(data)
      })
      .catch((err: unknown) => {
        if (isMounted) {
          setError(err instanceof Error ? err.message : 'Error al obtener el detalle de la imagen')
        }
      })

    return () => {
      isMounted = false
    }
  }, [imageId])

  useEffect(() => {
    if (!imageId) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [imageId, onClose])

  if (!imageId) return null

  const primary = detail?.tags[0] ?? imageId

  return (
    <div className={`${MODAL_OVERLAY} p-4`} onClick={onClose}>
      <div
        className="w-full max-w-3xl max-h-[85vh] flex flex-col bg-surface border border-default rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 flex items-center justify-between p-4 border-b border-default">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2 bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-xl border border-blue-500/20 shrink-0">
              <Layers className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-fg">Detalle de la imagen</h2>
              <p className="font-mono text-xs text-fg-muted truncate">{primary}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Cerrar detalle de la imagen"
            className="p-1.5 text-fg-muted hover:text-fg hover:bg-fg/10 rounded-lg transition-colors cursor-pointer shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-5 text-sm text-fg-muted">
          {loading && (
            <div className="py-10 text-center text-fg-muted">
              <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2 text-blue-500" />
              <p>Cargando detalle de la imagen...</p>
            </div>
          )}

          {error && (
            <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-700 dark:text-rose-400 rounded-xl text-xs flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
              <span>{error}</span>
            </div>
          )}

          {detail && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="p-3 bg-inset rounded-xl border border-default">
                  <span className="text-[10px] uppercase text-fg-subtle font-semibold tracking-wider">
                    Tamaño
                  </span>
                  <p className="mt-1 font-mono text-fg tabular-nums">{formatBytes(detail.size)}</p>
                </div>
                <div className="p-3 bg-inset rounded-xl border border-default">
                  <span className="text-[10px] uppercase text-fg-subtle font-semibold tracking-wider">
                    Capas
                  </span>
                  <p className="mt-1 font-mono text-fg tabular-nums">{detail.layer_count}</p>
                </div>
                <div className="p-3 bg-inset rounded-xl border border-default">
                  <span className="text-[10px] uppercase text-fg-subtle font-semibold tracking-wider">
                    Arquitectura
                  </span>
                  <p className="mt-1 font-mono text-fg">{detail.architecture || '-'}</p>
                </div>
                <div className="p-3 bg-inset rounded-xl border border-default">
                  <span className="text-[10px] uppercase text-fg-subtle font-semibold tracking-wider">
                    Sistema
                  </span>
                  <p className="mt-1 font-mono text-fg">{detail.os || '-'}</p>
                </div>
              </div>

              <div>
                <div className="flex items-center gap-1.5 text-xs uppercase text-fg-subtle font-semibold mb-2">
                  <Hash className="w-3.5 h-3.5" />
                  <span>Identificadores</span>
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-start gap-2 text-xs">
                    <span className="text-fg-subtle w-16 shrink-0">ID</span>
                    <code className="font-mono text-fg-muted break-all">{detail.id}</code>
                  </div>
                  {detail.tags.map((tag) => (
                    <div key={tag} className="flex items-start gap-2 text-xs">
                      <span className="text-fg-subtle w-16 shrink-0">Tag</span>
                      <code className="font-mono text-blue-600 dark:text-blue-400">{tag}</code>
                    </div>
                  ))}
                  {detail.repo_digests.map((digest) => (
                    <div key={digest} className="flex items-start gap-2 text-xs">
                      <span className="text-fg-subtle w-16 shrink-0">Digest</span>
                      <code className="font-mono text-fg-muted break-all">{digest}</code>
                    </div>
                  ))}
                  <div className="flex items-start gap-2 text-xs">
                    <span className="text-fg-subtle w-16 shrink-0">Creada</span>
                    <span className="text-fg-muted">{formatDate(detail.created)}</span>
                  </div>
                </div>
              </div>

              <div>
                <div className="flex items-center gap-1.5 text-xs uppercase text-fg-subtle font-semibold mb-2">
                  <Settings2 className="w-3.5 h-3.5" />
                  <span>Configuración</span>
                </div>
                <div className="space-y-2">
                  <div className="flex items-start gap-2 text-xs">
                    <span className="text-fg-subtle w-24 shrink-0">Entrypoint</span>
                    <code className="font-mono text-fg break-all">
                      {joinCommand(detail.entrypoint)}
                    </code>
                  </div>
                  <div className="flex items-start gap-2 text-xs">
                    <span className="text-fg-subtle w-24 shrink-0">Cmd</span>
                    <code className="font-mono text-fg break-all">{joinCommand(detail.cmd)}</code>
                  </div>
                  <div className="flex items-start gap-2 text-xs">
                    <User className="w-3.5 h-3.5 text-fg-subtle shrink-0 mt-px" />
                    <span className="text-fg-subtle w-20 shrink-0">Usuario</span>
                    <span className="font-mono text-fg-muted">{detail.user || '(root)'}</span>
                  </div>
                  <div className="flex items-start gap-2 text-xs">
                    <Folder className="w-3.5 h-3.5 text-fg-subtle shrink-0 mt-px" />
                    <span className="text-fg-subtle w-20 shrink-0">Directorio</span>
                    <span className="font-mono text-fg-muted">{detail.working_dir || '/'}</span>
                  </div>
                  <div className="flex items-start gap-2 text-xs">
                    <span className="text-fg-subtle w-24 shrink-0">Puertos</span>
                    <div className="flex flex-wrap gap-1.5">
                      {Object.keys(detail.exposed_ports).length > 0 ? (
                        Object.keys(detail.exposed_ports).map((port) => (
                          <span
                            key={port}
                            className="px-2 py-0.5 font-mono text-[10px] rounded bg-elevated text-emerald-700 dark:text-emerald-400 border border-default"
                          >
                            {port}
                          </span>
                        ))
                      ) : (
                        <span className="text-fg-subtle">Ninguno</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-start gap-2 text-xs">
                    <span className="text-fg-subtle w-24 shrink-0">Variables</span>
                    <div className="min-w-0 space-y-0.5">
                      {detail.env.length > 0 ? (
                        detail.env.map((variable) => (
                          <div key={variable} className="font-mono text-fg-muted break-all">
                            {variable}
                          </div>
                        ))
                      ) : (
                        <span className="text-fg-subtle">Ninguna</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <div className="flex items-center gap-1.5 text-xs uppercase text-fg-subtle font-semibold mb-2">
                  <History className="w-3.5 h-3.5" />
                  <span>Historial</span>
                  <span className="text-fg-subtle font-normal normal-case">
                    ({detail.history.length} capas)
                  </span>
                </div>
                {detail.history.length > 0 ? (
                  <div className="space-y-1.5">
                    {detail.history.map((entry) => (
                      <div
                        key={entry.id}
                        className="p-2.5 bg-inset border border-default rounded-lg flex flex-col md:flex-row md:items-center gap-2"
                      >
                        <span className="font-mono text-[10px] text-fg-subtle shrink-0">
                          {entry.id}
                        </span>
                        <code className="font-mono text-[11px] text-fg-muted break-all flex-1">
                          {entry.created_by || '(sin instrucción)'}
                        </code>
                        <span className="font-mono text-[11px] text-fg-subtle shrink-0">
                          {formatBytes(entry.size)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-fg-subtle">
                    El daemon no ha devuelto historial para esta imagen.
                  </p>
                )}
              </div>
            </>
          )}
        </div>

        <div className="p-3 border-t border-default flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-medium text-fg bg-elevated hover:bg-fg/10 rounded-lg transition-colors cursor-pointer"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  )
}
