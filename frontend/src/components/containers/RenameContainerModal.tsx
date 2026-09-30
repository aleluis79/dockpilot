// SPDX-License-Identifier: AGPL-3.0-or-later
import React, { useState } from 'react'
import { Pencil, RefreshCw } from 'lucide-react'
import { MODAL_OVERLAY } from '../ui/modalOverlay'
import { dockerApi } from '../../services/dockerApi'
import { redPropia, validarNombreContenedor } from '../../utils/containerName'

interface RenameContainerModalProps {
  containerId: string
  nombreActual: string
  /** Redes conectadas; una propia hace que el nombre sea un nombre DNS (SPEC-19 §3.3). */
  networks?: string[]
  /** Nombres ya ocupados, para avisar sin llamar al daemon. */
  otrosNombres: string[]
  onClose: () => void
  onRenamed: (oldName: string, newName: string) => void
}

/**
 * Diálogo de renombrado (SPEC-19).
 *
 * Tres cosas que hacen que sea más barato de lo que parece:
 *
 * - **No recrea el contenedor.** El id, el estado y los volúmenes no cambian, y
 *   el panel identifica por id, así que ninguna WebSocket abierta se rompe.
 * - **La validación es local.** El panel ya tiene el inventario cargado, así
 *   que sabe si el nombre está ocupado sin hacer un viaje. El `409` del daemon
 *   sigue siendo la verdad, pero es el caso raro, no el común.
 * - **No bloquea contenedores de compose.** Compose los identifica por
 *   etiquetas, no por nombre, y sigue funcionando tras el renombrado.
 */
export const RenameContainerModal: React.FC<RenameContainerModalProps> = ({
  containerId,
  nombreActual,
  networks,
  otrosNombres,
  onClose,
  onRenamed,
}) => {
  const [nombre, setNombre] = useState<string>(nombreActual)
  const [enviando, setEnviando] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  const validacion = validarNombreContenedor(nombre, {
    nombreActual,
    otrosNombres,
  })
  const dns = redPropia(networks)
  // El botón del diálogo es "Renombrar" y el de la cabecera también, así que
  // se distinguen por el texto exacto.
  const cambia = nombre.trim() !== nombreActual

  const confirmar = async () => {
    if (!validacion.valido || !cambia) return
    setEnviando(true)
    setError(null)
    try {
      const respuesta = await dockerApi.renameContainer(containerId, { name: nombre.trim() })
      onRenamed(respuesta.old_name, respuesta.new_name)
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'No se pudo renombrar el contenedor')
    } finally {
      setEnviando(false)
    }
  }

  return (
    <div className={MODAL_OVERLAY} onClick={onClose}>
      <div
        className="w-full max-w-md bg-surface border border-default rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Renombrar contenedor"
        data-testid="rename-modal"
      >
        <div className="p-5 border-b border-default">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-xl border border-blue-500/20">
              <Pencil className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-fg">Renombrar contenedor</h3>
              <p className="text-xs text-fg-muted">
                Ahora se llama <span className="font-mono">{nombreActual}</span>
              </p>
            </div>
          </div>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label
              htmlFor="rename-container-name"
              className="block text-xs font-semibold text-fg mb-1.5"
            >
              Nombre nuevo
            </label>
            <input
              id="rename-container-name"
              type="text"
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              aria-describedby={validacion.valido ? undefined : 'rename-error'}
              className={`w-full px-2.5 py-1.5 text-sm font-mono bg-inset border rounded-lg text-fg placeholder-fg-subtle focus:outline-none ${
                validacion.valido ? 'border-default focus:border-blue-500/50' : 'border-rose-500/60'
              }`}
            />
          </div>

          {!validacion.valido && (
            <p id="rename-error" role="alert" className="text-xs text-rose-600 dark:text-rose-400">
              {validacion.error}
            </p>
          )}

          {validacion.valido && cambia && dns && (
            <div
              role="note"
              className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-700 dark:text-amber-400 leading-relaxed space-y-1.5"
            >
              {/* Cada frase va en su propio elemento y sin partirse: una frase
                  cortada por un <span> se lee mal en un lector de pantalla y
                  además no se puede buscar con getByText. */}
              <p className="font-medium">
                En una red personalizada el nombre del contenedor es su nombre de red.
              </p>
              <p>
                Está en <span className="font-mono">{dns}</span>, así que al
                renombrarlo el nombre anterior dejará de resolver y cualquier cosa que
                lo use por su nombre se quedará sin encontrarlo.
              </p>
            </div>
          )}

          {validacion.valido && cambia && !dns && (
            <p className="text-xs text-fg-muted leading-relaxed">
              Está en la red por defecto, donde no hay nombres entre contenedores: renombrarlo
              no rompe la resolución de nada.
            </p>
          )}

          {error && (
            <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 pb-5">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded-lg bg-elevated text-fg hover:bg-elevated-hover transition-colors"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => void confirmar()}
            disabled={!validacion.valido || !cambia || enviando}
            className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50 flex items-center gap-1.5"
          >
            {enviando && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
            Renombrar
          </button>
        </div>
      </div>
    </div>
  )
}