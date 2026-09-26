// SPDX-License-Identifier: AGPL-3.0-or-later
import React, { useEffect, useState } from 'react'
import {
  X,
  Network as NetworkIcon,
  Loader2,
  AlertCircle,
  Tag,
  Container,
  Settings2,
} from 'lucide-react'
import { MODAL_OVERLAY } from '../ui/modalOverlay'
import { dockerApi } from '../../services/dockerApi'
import type { NetworkDetail } from '../../types/network'

interface NetworkDetailModalProps {
  name: string | null
  onClose: () => void
}

export const NetworkDetailModal: React.FC<NetworkDetailModalProps> = ({ name, onClose }) => {
  const [detail, setDetail] = useState<NetworkDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loading = detail === null && error === null

  useEffect(() => {
    if (!name) return

    let isMounted = true
    setDetail(null)
    setError(null)

    dockerApi
      .getNetwork(name)
      .then((data) => {
        if (isMounted) setDetail(data)
      })
      .catch((err: unknown) => {
        if (isMounted) {
          setError(err instanceof Error ? err.message : 'Error al cargar la red')
        }
      })

    return () => {
      isMounted = false
    }
  }, [name])

  if (!name) return null

  return (
    <div className={MODAL_OVERLAY} onClick={onClose}>
      <div
        className="bg-card border border-default rounded-lg w-full max-w-2xl max-h-[85vh] overflow-y-auto shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Detalle de la red ${name}`}
      >
        <div className="flex items-center justify-between p-4 border-b border-default sticky top-0 bg-card z-10">
          <div className="flex items-center gap-2 min-w-0">
            <NetworkIcon className="w-4.5 h-4.5 text-accent shrink-0" />
            <h3 className="text-sm font-semibold text-fg font-mono truncate">{name}</h3>
            {detail?.is_builtin && (
              <span className="px-1.5 py-0.5 text-[10px] uppercase rounded bg-elevated text-fg-subtle border border-default shrink-0">
                predefinida
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded text-fg-subtle hover:text-fg hover:bg-elevated-hover transition-colors"
            aria-label="Cerrar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-fg-subtle text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              Cargando detalle de la red...
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-700 dark:text-red-300">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {detail && (
            <>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                <div className="flex gap-1.5">
                  <dt className="text-fg-subtle">Driver</dt>
                  <dd className="text-fg font-mono">{detail.driver || '-'}</dd>
                </div>
                <div className="flex gap-1.5">
                  <dt className="text-fg-subtle">Ámbito</dt>
                  <dd className="text-fg font-mono">{detail.scope}</dd>
                </div>
                <div className="flex gap-1.5">
                  <dt className="text-fg-subtle">Interna</dt>
                  <dd className="text-fg">{detail.internal ? 'sí' : 'no'}</dd>
                </div>
                <div className="flex gap-1.5">
                  <dt className="text-fg-subtle">Adjuntable</dt>
                  <dd className="text-fg">{detail.attachable ? 'sí' : 'no'}</dd>
                </div>
                <div className="flex gap-1.5">
                  <dt className="text-fg-subtle">IPv6</dt>
                  <dd className="text-fg">{detail.enable_ipv6 ? 'sí' : 'no'}</dd>
                </div>
                <div className="flex gap-1.5">
                  <dt className="text-fg-subtle">ID</dt>
                  <dd className="text-fg font-mono truncate">{detail.id || '-'}</dd>
                </div>
              </dl>

              <div className="space-y-2">
                <div className="flex items-center gap-1.5 text-xs uppercase text-fg-subtle font-semibold">
                  <NetworkIcon className="w-3.5 h-3.5" />
                  <span>Subredes</span>
                </div>
                {detail.subnets.length > 0 ? (
                  <table className="w-full text-xs">
                    <thead className="text-fg-subtle">
                      <tr>
                        <th className="text-left font-semibold py-1">CIDR</th>
                        <th className="text-left font-semibold py-1">Puerta de enlace</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.subnets.map((s) => (
                        <tr key={s.subnet} className="border-t border-default">
                          <td className="py-1.5 font-mono text-fg">{s.subnet}</td>
                          <td className="py-1.5 font-mono text-fg-subtle">
                            {s.gateway || '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="text-xs text-fg-subtle">
                    Sin subred: Docker gestiona esta red internamente.
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-1.5 text-xs uppercase text-fg-subtle font-semibold">
                  <Container className="w-3.5 h-3.5" />
                  <span>Contenedores conectados</span>
                </div>
                {detail.containers.length > 0 ? (
                  <>
                    <div className="flex flex-wrap gap-1.5">
                      {detail.containers.map((container) => (
                        <span
                          key={container}
                          className="px-2 py-0.5 font-mono text-[11px] rounded bg-elevated text-fg border border-default"
                        >
                          {container}
                        </span>
                      ))}
                    </div>
                    <p className="text-[11px] text-fg-subtle">
                      Con contenedores conectados no se puede eliminar sin forzar, que
                      desconectaría el tráfico de la red.
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-fg-subtle">
                    Ninguno: se puede eliminar sin forzar.
                  </p>
                )}
              </div>

              {Object.keys(detail.options).length > 0 && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5 text-xs uppercase text-fg-subtle font-semibold">
                    <Settings2 className="w-3.5 h-3.5" />
                    <span>Opciones</span>
                  </div>
                  <dl className="text-[11px] space-y-0.5">
                    {Object.entries(detail.options).map(([key, value]) => (
                      <div key={key} className="flex gap-1.5">
                        <dt className="text-fg-subtle font-mono truncate">{key}</dt>
                        <dd className="text-fg font-mono truncate">{String(value)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}

              {Object.keys(detail.labels).length > 0 && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5 text-xs uppercase text-fg-subtle font-semibold">
                    <Tag className="w-3.5 h-3.5" />
                    <span>Etiquetas</span>
                  </div>
                  <dl className="text-[11px] space-y-0.5">
                    {Object.entries(detail.labels).map(([key, value]) => (
                      <div key={key} className="flex gap-1.5">
                        <dt className="text-fg-subtle font-mono truncate">{key}</dt>
                        <dd className="text-fg font-mono truncate">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
