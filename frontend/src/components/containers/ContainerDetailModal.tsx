// SPDX-License-Identifier: AGPL-3.0-or-later
import React, { useEffect, useState } from 'react'
import { MODAL_OVERLAY } from '../ui/modalOverlay'
import { X, Server, Network, HardDrive, Terminal as TermIcon, Tag, Clock, Pencil } from 'lucide-react'
import type { ContainerDetail, ContainerSummary } from '../../types/docker'
import { dockerApi } from '../../services/dockerApi'
import { StatusBadge } from '../ui/StatusBadge'
import { ContainerHealthPanel } from './ContainerHealthPanel'
import { RenameContainerModal } from './RenameContainerModal'

interface ContainerDetailModalProps {
  container: ContainerSummary | null
  onClose: () => void
  /**
   * Nombres ya ocupados por otros contenedores (SPEC-19). Se pasan en vez de
   * preguntarlos: el panel ya tiene el inventario cargado, y un viaje al daemon
   * para comprobar algo que se sabe hace la acción más lenta de lo que debe.
   */
  otrosNombres?: string[]
  /** Avisa de que el nombre del contenedor cambió, para refrescar la lista. */
  onRenamed?: (containerId: string, oldName: string, newName: string) => void
}

export const ContainerDetailModal: React.FC<ContainerDetailModalProps> = ({
  container,
  onClose,
  otrosNombres,
  onRenamed,
}) => {
  const [detail, setDetail] = useState<ContainerDetail | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [renombrando, setRenombrando] = useState<boolean>(false)
  // El nombre viene en el prop `container.name`, que no cambia al renombrar: si
  // la cabecera leyera de ahí, seguiría mostrando el nombre viejo hasta que el
  // padre refrescara. Se guarda en estado local justo para eso (SPEC-19).
  const [nombre, setNombre] = useState<string>(container?.name ?? '')

  useEffect(() => {
    if (!container) return

    let isMounted = true

    // El modal no se desmonta al cerrar: sus padre lo tienen siempre montado y
    // sólo hace `return null`. Sin limpiar el `detail`, abrir el contenedor B
    // tras el A mostraba los datos de A (imagen, estado, puertos, variables)
    // bajo el nombre de B hasta que llegaba la respuesta de B.
    setDetail(null)
    setError(null)
    setLoading(true)

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

  // Si el padre cambia de contenedor, el nombre local también.
  useEffect(() => {
    setNombre(container?.name ?? '')
  }, [container?.id, container?.name])

  if (!container) return null

  return (
    <div
      className={`${MODAL_OVERLAY} p-4`}
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[85vh] flex flex-col bg-surface border border-default rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-default bg-surface/90">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-xl border border-blue-500/20">
              <Server className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-fg">{nombre}</h2>
                <StatusBadge status={container.status} health={detail?.health} />
              </div>
              <p className="font-mono text-xs text-fg-muted">{container.id}</p>
            </div>
          </div>
<button
              onClick={() => setRenombrando(true)}
              title="Cambiar el nombre del contenedor"
              className="p-1.5 text-fg-muted hover:text-fg hover:bg-fg/10 rounded-lg transition-colors"
              aria-label="Renombrar contenedor"
            >
              <Pencil className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-fg-muted hover:text-fg hover:bg-fg/10 rounded-lg transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 text-sm text-fg">
          {loading && (
            <div className="py-8 text-center text-fg-muted">
              <Clock className="w-6 h-6 animate-spin mx-auto mb-2 text-blue-600 dark:text-blue-500" />
              <p>Cargando información del contenedor...</p>
            </div>
          )}

          {error && (
            <div className="p-4 bg-rose-500/10 border border-rose-500/20 text-rose-700 dark:text-rose-400 rounded-xl">
              {error}
            </div>
          )}

          {detail && (
            <>
              {/* La salud va antes que los datos: si el healthcheck está
                  fallando, es lo primero que se lee (SPEC-18 §3.4). */}
              <ContainerHealthPanel health={detail.health} />

              {/* Información General */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-4 bg-elevated/40 rounded-xl border border-default/80">
                  <span className="text-xs uppercase text-fg-muted font-semibold tracking-wider">
                    Imagen Base
                  </span>
                  <p className="mt-1 font-mono text-fg">{detail.image}</p>
                </div>
                <div className="p-4 bg-elevated/40 rounded-xl border border-default/80">
                  <span className="text-xs uppercase text-fg-muted font-semibold tracking-wider">
                    Estado Actual
                  </span>
                  <p className="mt-1 font-medium capitalize text-fg">{detail.state}</p>
                </div>
              </div>

              {/* Comando de Ejecución */}
              {detail.command && (
                <div>
                  <div className="flex items-center gap-1.5 text-xs uppercase text-fg-muted font-semibold mb-2">
                    <TermIcon className="w-4 h-4 text-fg-muted" />
                    <span>Comando</span>
                  </div>
                  <pre className="p-3 bg-inset font-mono text-xs text-blue-700 dark:text-blue-300 rounded-lg border border-default overflow-x-auto">
                    {detail.command}
                  </pre>
                </div>
              )}

              {/* Redes */}
              {detail.networks.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 text-xs uppercase text-fg-muted font-semibold mb-2">
                    <Network className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
                    <span>Redes Docker</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {detail.networks.map((net) => (
                      <span
                        key={net}
                        className="px-2.5 py-1 font-mono text-xs rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20"
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
                  <div className="flex items-center gap-1.5 text-xs uppercase text-fg-muted font-semibold mb-2">
                    <HardDrive className="w-4 h-4 text-amber-700 dark:text-amber-400" />
                    <span>Montajes y Volúmenes</span>
                  </div>
                  <div className="space-y-1.5">
                    {detail.mounts.map((m, idx) => (
                      <div
                        key={idx}
                        className="p-2.5 font-mono text-xs bg-inset/70 border border-default/80 rounded-lg flex flex-col md:flex-row md:items-center justify-between gap-1"
                      >
                        <span className="text-fg-muted">{String(m.Source || m.Name || '-')}</span>
                        <span className="text-fg-subtle hidden md:inline">➔</span>
                        <span className="text-amber-700 dark:text-amber-300 font-semibold">
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
                  <div className="flex items-center gap-1.5 text-xs uppercase text-fg-muted font-semibold mb-2">
                    <Tag className="w-4 h-4 text-purple-700 dark:text-purple-400" />
                    <span>Variables de Entorno ({detail.env.length})</span>
                  </div>
                  <div className="max-h-40 overflow-y-auto p-3 bg-inset font-mono text-xs text-fg-muted rounded-lg border border-default space-y-1">
                    {detail.env.map((envVar, idx) => (
                      <div key={idx} className="truncate hover:text-fg">
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
        <div className="p-4 border-t border-default bg-surface/90 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-fg hover:text-fg bg-elevated hover:bg-fg/10 rounded-xl transition-colors"
          >
            Cerrar
          </button>
        </div>
      </div>

      {/* El diálogo de renombrado va por encima del detalle, no dentro: el
          detalle queda montado detrás y al cerrar se vuelve a él, que es lo que
          espera quien estaba leyendo sus datos. */}
      {renombrando && container && (
        <RenameContainerModal
          containerId={container.id}
          nombreActual={nombre}
          networks={detail?.networks}
          otrosNombres={otrosNombres ?? []}
          onClose={() => setRenombrando(false)}
          onRenamed={(anterior, nuevo) => {
            setRenombrando(false)
            // El nombre es sólo presentación: el id no cambia, así que no hace
            // falta recargar nada más que el nombre en la cabecera.
            setNombre(nuevo)
            setDetail((d) => (d ? { ...d, name: nuevo } : d))
            onRenamed?.(container.id, anterior, nuevo)
          }}
        />
      )}
    </div>
  )
}
