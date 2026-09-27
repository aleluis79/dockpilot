// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, useEffect } from 'react'
import { X, Server, FolderOpen, FileText, ArrowRight, RefreshCw } from 'lucide-react'
import { MODAL_OVERLAY } from '../ui/modalOverlay'
import { dockerApi } from '../../services/dockerApi'
import type { ComposeProjectDetail } from '../../types/compose'

interface ProjectDetailModalProps {
  project: string
  onClose: () => void
  onNavigateTab?: (tab: 'containers' | 'volumes' | 'networks') => void
}

/**
 * Nombre real de un recurso de compose, junto al lógico que declara el archivo.
 *
 * Los dos son necesarios y no son intercambiables: el archivo declara `elastic`
 * y en Docker la red se llama `tienda_elastic`. Mostrar solo el lógico lleva a
 * error en cuanto el usuario copia el nombre para una terminal (SPEC-11 §3.2).
 */
function RealName({ logical, real }: { logical: string; real: string }) {
  return (
    <span className="flex flex-col min-w-0">
      <span className="font-mono text-fg truncate">{real}</span>
      {logical && logical !== real && (
        <span className="text-[10px] text-fg-subtle font-mono">
          en el archivo: {logical}
        </span>
      )}
    </span>
  )
}

export function ProjectDetailModal({
  project,
  onClose,
  onNavigateTab,
}: ProjectDetailModalProps) {
  const [detail, setDetail] = useState<ComposeProjectDetail | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let ignore = false
    const load = async () => {
      try {
        const data = await dockerApi.getComposeProject(project)
        if (!ignore) setDetail(data)
      } catch (err: unknown) {
        if (!ignore) {
          setError(
            err instanceof Error ? err.message : 'Error desconocido al leer el proyecto'
          )
        }
      } finally {
        if (!ignore) setLoading(false)
      }
    }
    void load()
    return () => {
      ignore = true
    }
  }, [project])

  return (
    <div className={MODAL_OVERLAY} onClick={onClose}>
      <div
        className="bg-surface border border-default rounded-lg w-full max-w-2xl max-h-[85vh] overflow-y-auto shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Detalle del proyecto ${project}`}
        data-testid="project-detail-modal"
      >
        <div className="flex items-center justify-between p-4 border-b border-default sticky top-0 bg-surface z-10">
          <div className="flex items-center gap-2 min-w-0">
            <Server className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
            <h3 className="text-sm font-semibold text-fg truncate font-mono">
              {project}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="p-1 rounded text-fg-subtle hover:text-fg hover:bg-elevated-hover transition-colors shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {loading && (
          <div className="p-4 flex items-center gap-2 text-xs text-fg-subtle">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            Leyendo el proyecto...
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="m-4 p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-700 dark:text-rose-300 text-xs"
          >
            {error}
          </div>
        )}

        {detail && (
          <div className="p-4 space-y-4 text-xs">
            {detail.orphaned && (
              <p className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-300">
                Este proyecto no tiene contenedores, pero conserva{' '}
                {detail.networks.length} red{detail.networks.length === 1 ? '' : 'es'}{' '}
                y {detail.volumes.length} volumen
                {detail.volumes.length === 1 ? '' : 'es'}. Ese espacio lo ocupa compose
                y ya no lo usa nadie.
              </p>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
              <div className="flex gap-1.5 min-w-0">
                <span className="text-fg-subtle shrink-0">Versión de compose</span>
                <span className="text-fg font-mono truncate">
                  {detail.compose_version || '—'}
                </span>
              </div>
              <div className="flex gap-1.5 min-w-0">
                <span className="text-fg-subtle shrink-0">Contenedores</span>
                <span className="text-fg font-mono">
                  {detail.containers_running} en ejecución de {detail.containers_total}
                </span>
              </div>
            </div>

            {detail.working_dir && (
              <div className="flex items-start gap-1.5 min-w-0">
                <FolderOpen className="w-3.5 h-3.5 text-fg-subtle shrink-0 mt-0.5" />
                <span className="min-w-0">
                  <span className="text-fg-subtle block">Directorio de trabajo</span>
                  <span className="text-fg font-mono break-all">
                    {detail.working_dir}
                  </span>
                </span>
              </div>
            )}

            {detail.config_files.length > 0 && (
              <div className="flex items-start gap-1.5 min-w-0">
                <FileText className="w-3.5 h-3.5 text-fg-subtle shrink-0 mt-0.5" />
                <span className="min-w-0">
                  <span className="text-fg-subtle block">
                    Archivo de configuración
                  </span>
                  {detail.config_files.map((file) => (
                    <span key={file} className="text-fg font-mono break-all block">
                      {file}
                    </span>
                  ))}
                  <span className="text-fg-subtle block mt-1">
                    Esta spec solo muestra la ruta: leer el archivo es cosa de SPEC-12.
                  </span>
                </span>
              </div>
            )}

            <div>
              <h4 className="text-xs font-semibold text-fg mb-1.5">
                Servicios ({detail.services.length})
              </h4>
              {detail.services.length === 0 ? (
                <p className="text-fg-subtle">Sin contenedores, así que sin servicios.</p>
              ) : (
                <ul className="space-y-2">
                  {detail.services.map((service) => (
                    <li
                      key={service.name || '(sin servicio)'}
                      data-testid={`service-${service.name || 'sin-servicio'}`}
                      className="p-2.5 rounded-lg border border-default bg-elevated"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-medium text-fg font-mono">
                          {service.name || '(sin etiqueta de servicio)'}
                        </span>
                        <span className="text-fg-subtle shrink-0">
                          {service.replicas} contenedor
                          {service.replicas === 1 ? '' : 'es'} · {service.running} en
                          ejecución
                        </span>
                      </div>
                      {service.image && (
                        <div className="text-fg-subtle font-mono truncate mt-0.5">
                          {service.image}
                        </div>
                      )}
                      {service.container_names.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {service.container_names.map((name) => (
                            <span
                              key={name}
                              className="px-1.5 py-0.5 rounded bg-elevated-hover text-[10px] font-mono text-fg-muted"
                            >
                              {name}
                            </span>
                          ))}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <h4 className="text-xs font-semibold text-fg mb-1.5">
                  Redes ({detail.networks.length})
                </h4>
                {detail.networks.length === 0 ? (
                  <p className="text-fg-subtle">Sin redes propias.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {detail.networks.map((network) => (
                      <li key={network.name} data-testid={`network-logical-${network.logical_name || network.name}`}>
                        <RealName logical={network.logical_name} real={network.name} />
                        <span className="text-fg-subtle block font-mono text-[10px]">
                          {network.driver}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <h4 className="text-xs font-semibold text-fg mb-1.5">
                  Volúmenes ({detail.volumes.length})
                </h4>
                {detail.volumes.length === 0 ? (
                  <p className="text-fg-subtle">Sin volúmenes.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {detail.volumes.map((volume) => (
                      <li key={volume.name} data-testid={`volume-logical-${volume.logical_name || volume.name}`}>
                        <RealName logical={volume.logical_name} real={volume.name} />
                        <span className="text-fg-subtle block font-mono text-[10px]">
                          {volume.driver}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {onNavigateTab && detail.containers_total > 0 && (
              <div className="pt-1 border-t border-default">
                <button
                  type="button"
                  onClick={() => onNavigateTab('containers')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-elevated text-fg hover:bg-elevated-hover transition-colors"
                >
                  Ver contenedores
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
                <span className="sr-only">en la vista de contenedores</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
