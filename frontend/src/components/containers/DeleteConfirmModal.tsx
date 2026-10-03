// SPDX-License-Identifier: AGPL-3.0-or-later
import React, { useState } from 'react'
import { MODAL_OVERLAY } from '../ui/modalOverlay'
import { AlertTriangle, Trash2, X } from 'lucide-react'
import type { ContainerSummary } from '../../types/docker'
import { esContenedorDelPanel } from '../../utils/proteccion'

/**
 * Descriptor genérico de lo que se va a eliminar.
 * `ContainerSummary` cumple esta forma, así que el uso con contenedores no
 * necesita cambiar (SPEC-07 §3.6).
 */
export interface DeletableTarget {
  id: string;
  name: string;
}

interface DeleteConfirmModalProps {
  container: ContainerSummary | null;
  onClose: () => void;
  onConfirm: (id: string, force: boolean) => void;
  /** Objetivo alternativo para recursos que no son contenedores (imágenes). */
  target?: DeletableTarget | null;
  title?: string;
  description?: React.ReactNode;
  warning?: React.ReactNode;
  confirmLabel?: string;
  forceLabel?: React.ReactNode;
}

const RUNNING_WARNING = (
  <>
    El contenedor está actualmente en ejecución. Debe detenerse primero o marcar la opción de
    eliminación forzada.
  </>
)

export const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({
  container,
  onClose,
  onConfirm,
  target,
  title,
  description,
  warning,
  confirmLabel,
  forceLabel,
}) => {
  const [force, setForce] = useState<boolean>(false)

  // `target` tiene prioridad: es el modo genérico (imágenes)
  const resolved: DeletableTarget | null =
    target ?? (container ? { id: container.id, name: container.name } : null)

  if (!resolved) return null

  // Segunda barrera, y no la primera. El botón de borrar no se pinta para un
  // contenedor del panel, pero este modal es genérico y lo usan también las
  // imágenes: si algún camino lo abriera, aquí se para en seco y se dice por qué,
  // en vez de ofrecer un botón que dejaría el panel apagado sin red detrás
  // (SPEC-00).
  if (container && esContenedorDelPanel(container)) {
    return (
      <div className={`${MODAL_OVERLAY} p-4`} onClick={onClose}>
        <div
          className="w-full max-w-md bg-surface border border-default rounded-2xl shadow-2xl overflow-hidden p-6"
          onClick={(e) => e.stopPropagation()}
          role="alertdialog"
          data-testid="borrado-protegido"
        >
          <div className="flex items-center justify-between mb-4">
            <div className="p-3 bg-amber-500/10 text-amber-700 dark:text-amber-400 rounded-xl border border-amber-500/20">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <button
              onClick={onClose}
              className="p-1.5 text-fg-muted hover:text-fg hover:bg-fg/10 rounded-lg transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <h3 className="text-lg font-semibold text-fg mb-2">
            &quot;{resolved.name}&quot; es el propio panel
          </h3>
          <p className="text-sm text-fg-muted">
            No se puede eliminar desde aquí. Si lo hiciera, el panel quedaría apagado y Docker no
            lo volvería a levantar, porque un <code className="font-mono">stop</code> que viene de
            la API cuenta como parada deliberada y suspende la política de reinicio. Para
            desmontarlo, desde fuera: <code className="font-mono">docker compose down</code>.
          </p>
          <div className="flex items-center justify-end mt-6">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-fg hover:text-fg bg-elevated hover:bg-fg/10 rounded-xl transition-colors"
            >
              Entendido
            </button>
          </div>
        </div>
      </div>
    )
  }

  const isRunning = container?.status.toLowerCase() === 'running'
  const resolvedWarning = warning ?? (isRunning ? RUNNING_WARNING : null)

  return (
    <div
      className={`${MODAL_OVERLAY} p-4`}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-surface border border-default rounded-2xl shadow-2xl overflow-hidden p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="p-3 bg-rose-500/10 text-rose-700 dark:text-rose-400 rounded-xl border border-rose-500/20">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-fg-muted hover:text-fg hover:bg-fg/10 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <h3 className="text-lg font-semibold text-fg mb-2">
          {title ?? '¿Eliminar contenedor?'}
        </h3>
        {description ? (
          <p className="text-sm text-fg-muted mb-4">{description}</p>
        ) : (
          <p className="text-sm text-fg-muted mb-4">
            Estás a punto de eliminar el contenedor{' '}
            <span className="font-semibold text-fg">"{resolved.name}"</span> (
            <code className="text-xs font-mono text-fg-muted">{resolved.id.slice(0, 12)}</code>). Esta
            acción no se puede deshacer.
          </p>
        )}

        {resolvedWarning && (
          <div className="p-3 mb-4 bg-amber-500/10 border border-amber-500/20 rounded-xl text-xs text-amber-700 dark:text-amber-300">
            {resolvedWarning}
          </div>
        )}

        <label className="flex items-center gap-2 mb-6 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
            className="w-4 h-4 rounded border-strong bg-elevated text-rose-700 dark:text-rose-500 focus:ring-rose-500/30"
          />
          <span className="text-xs text-fg">
            {forceLabel ?? (
              <>
                Forzar eliminación (
                <code className="font-mono text-rose-700 dark:text-rose-400">force=true</code>)
              </>
            )}
          </span>
        </label>

        <div className="flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-fg hover:text-fg bg-elevated hover:bg-fg/10 rounded-xl transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={() => {
              onConfirm(resolved.id, force)
              onClose()
            }}
            className="px-4 py-2 text-sm font-medium text-white bg-rose-600 hover:bg-rose-500 rounded-xl transition-colors flex items-center gap-2"
          >
            <Trash2 className="w-4 h-4" />
            {confirmLabel ?? 'Eliminar'}
          </button>
        </div>
      </div>
    </div>
  )
}
