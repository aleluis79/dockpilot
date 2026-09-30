// SPDX-License-Identifier: AGPL-3.0-or-later
import React, { useEffect, useState } from 'react'
import { X, HardDrive, Loader2, AlertCircle, Folder, Container } from 'lucide-react'
import { MODAL_OVERLAY } from '../ui/modalOverlay'
import { dockerApi } from '../../services/dockerApi'
import { formatBytes } from '../../utils/format'
import type { VolumeDetail } from '../../types/volume'

interface VolumeDetailModalProps {
  name: string | null
  onClose: () => void
}

const formatDate = (iso: string): string => {
  if (!iso) return '-'
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return '-'
  return parsed.toLocaleString('es-ES', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export const VolumeDetailModal: React.FC<VolumeDetailModalProps> = ({ name, onClose }) => {
  const [detail, setDetail] = useState<VolumeDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  // El estado de carga se deriva: mientras no haya detalle ni error hay consulta.
  const loading = detail === null && error === null

  useEffect(() => {
    if (!name) return

    let isMounted = true
    // Igual que en los otros modales: sin esto, abrir el volumen B tras el A
    // pintaba los datos de A (tamaño, contenedores que lo usan) bajo B.
    setDetail(null)
    setError(null)

    dockerApi
      .getVolume(name)
      .then((data) => {
        if (isMounted) setDetail(data)
      })
      .catch((err: unknown) => {
        if (isMounted) {
          setError(err instanceof Error ? err.message : 'Error al obtener el detalle del volumen')
        }
      })

    return () => {
      isMounted = false
    }
  }, [name])

  useEffect(() => {
    if (!name) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [name, onClose])

  if (!name) return null

  return (
    <div className={`${MODAL_OVERLAY} p-4`} onClick={onClose}>
      <div
        className="w-full max-w-2xl max-h-[85vh] flex flex-col bg-surface border border-default rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 flex items-center justify-between p-4 border-b border-default">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2 bg-violet-500/10 text-violet-600 dark:text-violet-400 rounded-xl border border-violet-500/20 shrink-0">
              <HardDrive className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-fg">Detalle del volumen</h2>
              <p className="font-mono text-xs text-fg-muted truncate" title={name}>
                {detail?.is_anonymous ? `${name.slice(0, 12)}… (anónimo)` : name}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Cerrar detalle del volumen"
            className="p-1.5 text-fg-muted hover:text-fg hover:bg-fg/10 rounded-lg transition-colors cursor-pointer shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-5 text-sm text-fg-muted">
          {loading && (
            <div className="py-10 text-center text-fg-muted">
              <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2 text-blue-500" />
              <p>Cargando detalle del volumen...</p>
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
                  <p className="mt-1 font-mono text-fg tabular-nums">
                    {formatBytes(detail.size)}
                  </p>
                </div>
                <div className="p-3 bg-inset rounded-xl border border-default">
                  <span className="text-[10px] uppercase text-fg-subtle font-semibold tracking-wider">
                    Driver
                  </span>
                  <p className="mt-1 font-mono text-fg">{detail.driver}</p>
                </div>
                <div className="p-3 bg-inset rounded-xl border border-default">
                  <span className="text-[10px] uppercase text-fg-subtle font-semibold tracking-wider">
                    Ámbito
                  </span>
                  <p className="mt-1 font-mono text-fg">{detail.scope}</p>
                </div>
                <div className="p-3 bg-inset rounded-xl border border-default">
                  <span className="text-[10px] uppercase text-fg-subtle font-semibold tracking-wider">
                    Contenedores
                  </span>
                  <p className="mt-1 font-mono text-fg tabular-nums">{detail.ref_count}</p>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-1.5 text-xs uppercase text-fg-subtle font-semibold">
                  <Folder className="w-3.5 h-3.5" />
                  <span>Punto de montaje</span>
                </div>
                <code className="block p-2.5 bg-inset border border-default rounded-lg font-mono text-[11px] text-fg-muted break-all">
                  {detail.mountpoint || '(no informado)'}
                </code>
                <p className="text-[11px] text-fg-subtle">Creado: {formatDate(detail.created_at)}</p>
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-1.5 text-xs uppercase text-fg-subtle font-semibold">
                  <Container className="w-3.5 h-3.5" />
                  <span>Contenedores que lo usan</span>
                </div>
                {detail.containers.length > 0 ? (
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
                ) : detail.ref_count > 0 ? (
                  // Discrepancia: el daemon dice que hay referencias pero ningún
                  // contenedor del listado lo monta. No se puede afirmar que se
                  // borre sin forzar, porque el DELETE devolverá 409.
                  <div className="p-2.5 bg-amber-500/10 border border-amber-500/20 rounded-lg text-[11px] text-amber-700 dark:text-amber-300">
                    El daemon indica {detail.ref_count}{' '}
                    {detail.ref_count === 1 ? 'referencia' : 'referencias'}, pero{' '}
                    <strong>ningún contenedor aparece en el listado</strong> que lo monte. Es una
                    discrepancia: para eliminarlo habrá que forzar el borrado.
                  </div>
                ) : (
                  <p className="text-xs text-fg-subtle">
                    Ninguno: se puede eliminar sin forzar.
                  </p>
                )}
              </div>

              {Object.keys(detail.labels).length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-xs uppercase text-fg-subtle font-semibold">
                    <span>Etiquetas</span>
                  </div>
                  <div className="space-y-1">
                    {Object.entries(detail.labels).map(([key, value]) => (
                      <div key={key} className="flex items-start gap-2 text-xs">
                        <span className="font-mono text-fg-muted w-32 shrink-0">{key}</span>
                        <span className="font-mono text-fg break-all">{value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {Object.keys(detail.options).length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-xs uppercase text-fg-subtle font-semibold">
                    <span>Opciones</span>
                  </div>
                  <pre className="p-2.5 bg-inset border border-default rounded-lg font-mono text-[11px] text-fg-muted overflow-x-auto">
                    {JSON.stringify(detail.options, null, 2)}
                  </pre>
                </div>
              )}
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
