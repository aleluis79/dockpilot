// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from 'react'
import { AlertTriangle, HardDrive, X } from 'lucide-react'
import { MODAL_OVERLAY } from '../ui/modalOverlay'

interface ComposeDownDialogProps {
  project: string
  /** Nombres REALES de los volúmenes, tal como aparecen en el daemon. */
  volumes: string[]
  onClose: () => void
  /** `true` equivale a `down --volumes`. Irreversible. */
  onConfirm: (volumes: boolean) => void
}

/**
 * Diálogo de `down`.
 *
 * `down --volumes` es la única acción irreversible de SPEC-13, así que está
 * separada de la normal y no es el valor por defecto de nada. Las cuatro
 * salvaguardas de §3.6: nunca por defecto, confirmación en dos pasos con los
 * nombres reales a la vista, el `409` del servidor cuando el proyecto está en
 * marcha, y un botón que no comparte aspecto con el de `down` normal.
 */
export function ComposeDownDialog({
  project,
  volumes,
  onClose,
  onConfirm,
}: ComposeDownDialogProps) {
  const [armado, setArmado] = useState<boolean>(false)

  return (
    <div className={MODAL_OVERLAY} onClick={onClose}>
      <div
        className="bg-surface border border-default rounded-lg w-full max-w-md p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Bajar el proyecto ${project}`}
        data-testid="compose-down-dialog"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-fg">
              Bajar el proyecto {project}
            </h3>
            <p className="text-xs text-fg-subtle mt-1">
              Se detienen y se eliminan sus contenedores y su red. Los volúmenes{' '}
              <strong>no</strong> se tocan salvo que lo pidas explícitamente.
            </p>
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

        <div className="mt-4 space-y-2">
          <button
            type="button"
            onClick={() => onConfirm(false)}
            className="w-full px-3 py-2 text-sm rounded-lg bg-elevated text-fg hover:bg-elevated-hover transition-colors"
          >
            Bajar
          </button>

          {volumes.length === 0 ? (
            <p className="text-[11px] text-fg-subtle text-center">
              Este proyecto no declara volúmenes, así que no hay nada que borrar.
            </p>
          ) : (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 space-y-2">
              <p className="text-[11px] text-rose-700 dark:text-rose-300 font-semibold flex items-center gap-1.5">
                <HardDrive className="w-3.5 h-3.5" />
                Esto además borra {volumes.length} volumen
                {volumes.length === 1 ? '' : 'es'} de forma irreversible
              </p>
              <ul className="space-y-0.5 max-h-32 overflow-auto">
                {volumes.map((volumen) => (
                  <li key={volumen} className="text-[10px] font-mono text-rose-700/90 dark:text-rose-300/90 truncate">
                    {volumen}
                  </li>
                ))}
              </ul>
              <p className="text-[10px] text-fg-subtle">
                No se puede deshacer desde el panel.
              </p>

              {!armado ? (
                <button
                  type="button"
                  onClick={() => setArmado(true)}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-rose-500/40 text-rose-700 dark:text-rose-300 hover:bg-rose-500/10 transition-colors"
                >
                  Borrando también los volúmenes
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => onConfirm(true)}
                  className="w-full px-3 py-2 text-sm rounded-lg bg-rose-600 text-white hover:bg-rose-700 transition-colors font-semibold"
                >
                  Sí, borrar {volumes.length} volumen
                  {volumes.length === 1 ? '' : 'es'} de {project}
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end mt-4">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-fg-subtle hover:text-fg hover:bg-elevated-hover transition-colors"
          >
            Cancelar
          </button>
        </div>
      </div>
    </div>
  )
}
