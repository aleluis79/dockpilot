// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from 'react'
import { AlertTriangle, X, RefreshCw } from 'lucide-react'
import { MODAL_OVERLAY } from '../ui/modalOverlay'
import { useComposeCommand } from '../../hooks/useComposeCommand'
import { ETIQUETA_ACCION, VISUAL_ACCION, VISUAL_CANCELAR } from './composeActions'
import type { ComposeAction } from '../../types/compose'

interface ComposeActionPanelProps {
  project: string
  path: string
  onClose: () => void
  onRefrescar?: () => void
  /** Arranca esta acción en cuanto se abre, en vez de esperar a un clic. */
  accionInicial?: ComposeAction | null
  /** Solo tiene efecto con `accionInicial: 'down'`. Irreversible. */
  volumes?: boolean
  /**
   * `up --remove-orphans`. `false` en el despliegue desde el plan, donde el
   * nombre puede chocar con otro proyecto y el flag se llevaría por delante
   * contenedores ajenos (SPEC-15 §3.3).
   */
  removeOrphans?: boolean
}

/** Acciones que se ofrecen sin confirmación previa. `down` tiene su diálogo. */
const ACCIONES: ComposeAction[] = ['up', 'stop', 'pull']

export function ComposeActionPanel({
  project,
  path,
  onClose,
  onRefrescar,
  accionInicial = null,
  volumes = false,
  removeOrphans = true,
}: ComposeActionPanelProps) {
  const [accion, setAccion] = useState<ComposeAction | null>(accionInicial)
  const {
    output,
    command,
    enCurso,
    error,
    exitCode,
    duracionMs,
    cancelado,
    ejecutar,
    cancelar,
    limpiar,
  } = useComposeCommand({ onRefrescar })

  // El proyecto se manda siempre: es lo que hace exacta la comprobación de que
  // `down --volumes` no se lance con contenedores en marcha (SPEC-13 §3.2).
  const lanzar = (nueva: ComposeAction) => {
    setAccion(nueva)
    ejecutar({
      action: nueva,
      path,
      project_name: project,
      volumes: nueva === 'down' ? volumes : undefined,
      remove_orphans: nueva === 'up' ? removeOrphans : undefined,
    })
  }

  // La acción inicial se lanza al abrir el panel, una sola vez.
  useEffect(() => {
    if (accionInicial) lanzar(accionInicial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stdout = output.filter((l) => l.stream === 'stdout').map((l) => l.data).join('')
  const stderr = output.filter((l) => l.stream === 'stderr').map((l) => l.data).join('')

  return (
    <div className={MODAL_OVERLAY} onClick={onClose}>
      <div
        data-testid="compose-action-panel"
        data-project={project}
        data-remove-orphans={String(removeOrphans)}
        className="bg-surface border border-default rounded-lg w-full max-w-3xl max-h-[85vh] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Acciones del proyecto ${project}`}
      >
        <div className="flex items-center justify-between p-4 border-b border-default shrink-0">
          <h3 className="text-sm font-semibold text-fg font-mono truncate">{project}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="p-1 rounded text-fg-subtle hover:text-fg hover:bg-elevated-hover transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="p-4 space-y-3 flex-1 min-h-0 overflow-y-auto">
          <div className="flex flex-wrap items-center gap-2">
            {ACCIONES.map((action) => {
              const { icon: Icon, hover } = VISUAL_ACCION[action]
              return (
                <button
                  key={action}
                  type="button"
                  onClick={() => lanzar(action)}
                  disabled={enCurso}
                  className={`px-3 py-1.5 text-xs rounded-lg bg-elevated text-fg ${hover} transition-colors disabled:opacity-50 flex items-center gap-1.5`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {ETIQUETA_ACCION[action]}
                </button>
              )
            })}

            {accion && enCurso && (
              /* Icono propio: `Square` significa «parar el proyecto», y cortar el
                 comando que lo levanta es otra cosa. */
              <button
                type="button"
                onClick={cancelar}
                className="px-3 py-1.5 text-xs rounded-lg bg-rose-500/10 text-rose-700 dark:text-rose-300 border border-rose-500/30 transition-colors flex items-center gap-1.5"
              >
                <VISUAL_CANCELAR.icon className="w-3.5 h-3.5" />
                Cancelar
              </button>
            )}

            {accion && !enCurso && (
              <button
                type="button"
                onClick={() => {
                  limpiar()
                  setAccion(null)
                }}
                className="px-2.5 py-1.5 text-xs rounded-lg text-fg-muted hover:text-fg hover:bg-elevated-hover transition-colors flex items-center gap-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Limpiar
              </button>
            )}
          </div>

          {/* El comando exacto se ve siempre: quien para o borra algo tiene que
              poder comprobar qué se ejecutó. */}
          {command.length > 0 && (
            <p
              data-testid="compose-command"
              className="text-[10px] font-mono text-fg-subtle break-all"
            >
              {command.join(' ')}
            </p>
          )}

          {error && (
            <div
              data-testid="compose-error"
              role="alert"
              className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-700 dark:text-rose-300 text-xs"
            >
              {error}
            </div>
          )}

          {accion && (
            <div
              data-testid="compose-exit"
              className={`p-2.5 rounded-lg border text-[11px] ${
                cancelado
                  ? 'bg-elevated border-default text-fg-muted'
                  : exitCode === 0
                    ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-700 dark:text-emerald-400'
                    : 'bg-amber-500/10 border-amber-500/20 text-amber-700 dark:text-amber-400'
              }`}
            >
              {cancelado ? (
                <>Cancelado: el proceso se detuvo, el proyecto queda como estaba.</>
              ) : exitCode === null ? (
                <>Ejecutando…</>
              ) : exitCode === 0 ? (
                <>
                  Docker Compose terminó bien en{' '}
                  {((duracionMs ?? 0) / 1000).toFixed(1)} s.
                </>
              ) : (
                <>
                  Docker Compose terminó con error {exitCode} en{' '}
                  {((duracionMs ?? 0) / 1000).toFixed(1)} s. El comando se ejecutó y
                  compose no tuvo éxito: el detalle está en la salida de abajo.
                </>
              )}
            </div>
          )}

          {enCurso && accion && (
            <p className="text-[11px] text-fg-subtle flex items-center gap-1.5">
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              Esperando a Docker Compose…
            </p>
          )}

          <div className="space-y-2">
            <pre
              data-testid="compose-output"
              className="max-h-64 overflow-auto p-2.5 rounded-lg bg-inset border border-default text-[11px] font-mono text-fg whitespace-pre-wrap break-words"
            >
              {stdout}
            </pre>
            {stderr && (
              <pre
                data-testid="compose-stderr"
                className="max-h-40 overflow-auto p-2.5 rounded-lg bg-amber-500/5 border border-amber-500/20 text-[11px] font-mono text-amber-700 dark:text-amber-300 whitespace-pre-wrap break-words"
              >
                {stderr}
              </pre>
            )}
          </div>

          {!accion && (
            <p className="text-[11px] text-fg-subtle flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              Bajar el proyecto y borrar sus volúmenes se hace desde el diálogo de
              eliminación, no desde aquí.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
