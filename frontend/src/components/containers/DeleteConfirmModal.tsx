import React, { useState } from 'react'
import { AlertTriangle, Trash2, X } from 'lucide-react'
import type { ContainerSummary } from '../../types/docker'

interface DeleteConfirmModalProps {
  container: ContainerSummary | null
  onClose: () => void
  onConfirm: (id: string, force: boolean) => void
}

export const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({
  container,
  onClose,
  onConfirm,
}) => {
  const [force, setForce] = useState<boolean>(false)

  if (!container) return null

  const isRunning = container.status.toLowerCase() === 'running'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="p-3 bg-rose-500/10 text-rose-400 rounded-xl border border-rose-500/20">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <h3 className="text-lg font-semibold text-zinc-100 mb-2">¿Eliminar contenedor?</h3>
        <p className="text-sm text-zinc-400 mb-4">
          Estás a punto de eliminar el contenedor{' '}
          <span className="font-semibold text-zinc-200">"{container.name}"</span> (
          <code className="text-xs font-mono text-zinc-400">{container.id.slice(0, 12)}</code>). Esta
          acción no se puede deshacer.
        </p>

        {isRunning && (
          <div className="p-3 mb-4 bg-amber-500/10 border border-amber-500/20 rounded-xl text-xs text-amber-300">
            El contenedor está actualmente en ejecución. Debe detenerse primero o marcar la opción
            de eliminación forzada.
          </div>
        )}

        <label className="flex items-center gap-2 mb-6 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
            className="w-4 h-4 rounded border-zinc-700 bg-zinc-800 text-rose-500 focus:ring-rose-500/30"
          />
          <span className="text-xs text-zinc-300">
            Forzar eliminación (<code className="font-mono text-rose-400">force=true</code>)
          </span>
        </label>

        <div className="flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-zinc-300 hover:text-zinc-100 bg-zinc-800 hover:bg-zinc-700 rounded-xl transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={() => {
              onConfirm(container.id, force)
              onClose()
            }}
            className="px-4 py-2 text-sm font-medium text-white bg-rose-600 hover:bg-rose-500 rounded-xl transition-colors flex items-center gap-2"
          >
            <Trash2 className="w-4 h-4" />
            Eliminar
          </button>
        </div>
      </div>
    </div>
  )
}
