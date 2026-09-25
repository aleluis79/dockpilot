import React, { useEffect, useState } from 'react'
import { X, Server, Network, HardDrive, Terminal as TermIcon, Tag, Clock } from 'lucide-react'
import type { ContainerDetail, ContainerSummary } from '../../types/docker'
import { dockerApi } from '../../services/dockerApi'
import { StatusBadge } from '../ui/StatusBadge'

interface ContainerDetailModalProps {
  container: ContainerSummary | null
  onClose: () => void
}

export const ContainerDetailModal: React.FC<ContainerDetailModalProps> = ({
  container,
  onClose,
}) => {
  const [detail, setDetail] = useState<ContainerDetail | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!container) return

    let isMounted = true

    dockerApi
      .getContainer(container.id)
      .then((data) => {
        if (isMounted) {
          setDetail(data)
          setError(null)
        }
      })
      .catch((err: unknown) => {
        if (isMounted) {
          setError(err instanceof Error ? err.message : 'Error al obtener detalle del contenedor')
        }
      })
      .finally(() => {
        if (isMounted) setLoading(false)
      })

    return () => {
      isMounted = false
    }
  }, [container])

  if (!container) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[85vh] flex flex-col bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-zinc-800 bg-zinc-900/90">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-blue-500/10 text-blue-400 rounded-xl border border-blue-500/20">
              <Server className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-zinc-100">{container.name}</h2>
                <StatusBadge status={container.status} />
              </div>
              <p className="font-mono text-xs text-zinc-500">{container.id}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 text-sm text-zinc-300">
          {loading && (
            <div className="py-8 text-center text-zinc-500">
              <Clock className="w-6 h-6 animate-spin mx-auto mb-2 text-blue-500" />
              <p>Cargando información del contenedor...</p>
            </div>
          )}

          {error && (
            <div className="p-4 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-xl">
              {error}
            </div>
          )}

          {detail && (
            <>
              {/* Información General */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-4 bg-zinc-800/40 rounded-xl border border-zinc-800/80">
                  <span className="text-xs uppercase text-zinc-500 font-semibold tracking-wider">
                    Imagen Base
                  </span>
                  <p className="mt-1 font-mono text-zinc-200">{detail.image}</p>
                </div>
                <div className="p-4 bg-zinc-800/40 rounded-xl border border-zinc-800/80">
                  <span className="text-xs uppercase text-zinc-500 font-semibold tracking-wider">
                    Estado Actual
                  </span>
                  <p className="mt-1 font-medium capitalize text-zinc-200">{detail.state}</p>
                </div>
              </div>

              {/* Comando de Ejecución */}
              {detail.command && (
                <div>
                  <div className="flex items-center gap-1.5 text-xs uppercase text-zinc-500 font-semibold mb-2">
                    <TermIcon className="w-4 h-4 text-zinc-400" />
                    <span>Comando</span>
                  </div>
                  <pre className="p-3 bg-zinc-950 font-mono text-xs text-blue-300 rounded-lg border border-zinc-800 overflow-x-auto">
                    {detail.command}
                  </pre>
                </div>
              )}

              {/* Redes */}
              {detail.networks.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 text-xs uppercase text-zinc-500 font-semibold mb-2">
                    <Network className="w-4 h-4 text-emerald-400" />
                    <span>Redes Docker</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {detail.networks.map((net) => (
                      <span
                        key={net}
                        className="px-2.5 py-1 font-mono text-xs rounded-lg bg-emerald-500/10 text-emerald-300 border border-emerald-500/20"
                      >
                        {net}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Montajes y Volúmenes */}
              {detail.mounts.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 text-xs uppercase text-zinc-500 font-semibold mb-2">
                    <HardDrive className="w-4 h-4 text-amber-400" />
                    <span>Montajes y Volúmenes</span>
                  </div>
                  <div className="space-y-1.5">
                    {detail.mounts.map((m, idx) => (
                      <div
                        key={idx}
                        className="p-2.5 font-mono text-xs bg-zinc-950/70 border border-zinc-800/80 rounded-lg flex flex-col md:flex-row md:items-center justify-between gap-1"
                      >
                        <span className="text-zinc-400">{String(m.Source || m.Name || '-')}</span>
                        <span className="text-zinc-600 hidden md:inline">➔</span>
                        <span className="text-amber-300 font-semibold">
                          {String(m.Destination || '-')}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Variables de Entorno */}
              {detail.env.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 text-xs uppercase text-zinc-500 font-semibold mb-2">
                    <Tag className="w-4 h-4 text-purple-400" />
                    <span>Variables de Entorno ({detail.env.length})</span>
                  </div>
                  <div className="max-h-40 overflow-y-auto p-3 bg-zinc-950 font-mono text-xs text-zinc-400 rounded-lg border border-zinc-800 space-y-1">
                    {detail.env.map((envVar, idx) => (
                      <div key={idx} className="truncate hover:text-zinc-200">
                        {envVar}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-zinc-800 bg-zinc-900/90 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-zinc-300 hover:text-zinc-100 bg-zinc-800 hover:bg-zinc-700 rounded-xl transition-colors"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  )
}
