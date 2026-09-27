// SPDX-License-Identifier: AGPL-3.0-or-later
import { ArrowRight, Hammer } from 'lucide-react'
import { MODAL_OVERLAY } from '../ui/modalOverlay'
import { formatBytes } from '../../utils/format'
import type { ComposePlan, PlannedBuild } from '../../types/compose'

interface ComposeDeployDialogProps {
  open: boolean
  plan: ComposePlan
  onConfirm: () => void
  onCancel: () => void
}

/** Agrupa los servicios con `build` por contexto, para no repetir el mismo peso. */
function porContexto(servicios: ComposePlan['services']): [string, PlannedBuild[]][] {
  const grupos = new Map<string, PlannedBuild[]>()
  for (const servicio of servicios) {
    if (!servicio.build) continue
    const existente = grupos.get(servicio.build.context)
    if (existente) {
      existente.push(servicio.build)
    } else {
      grupos.set(servicio.build.context, [servicio.build])
    }
  }
  return [...grupos.entries()]
}

/**
 * Aviso del coste de construir, antes de arrancar (SPEC-15 §3.6).
 *
 * Existe porque `docker compose up -d` construye las imágenes que no existan, y
 * en el host de referencia los contextos son de 393 MB y 152 MB sin
 * `.dockerignore`. Un botón que dice "Iniciar" y tarda 8 minutos construyendo es
 * una promesa rota.
 *
 * Solo hay dos salidas: construir y arrancar, o cancelar. **No** se ofrece "arrancar
 * sin construir": `up --no-build` sobre una imagen que no existe falla, y un botón
 * de arranque que a veces falla es peor que uno lento a propósito.
 */
export function ComposeDeployDialog({ open, plan, onConfirm, onCancel }: ComposeDeployDialogProps) {
  const grupos = porContexto(plan.services)
  if (!open || grupos.length === 0) return null

  const servicios = plan.services.filter((s) => s.build)

  return (
    <div className={MODAL_OVERLAY} onClick={onCancel}>
      <div
        className="bg-surface border border-default rounded-lg w-full max-w-lg shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Construir antes de arrancar"
        data-testid="compose-deploy-dialog"
      >
        <div className="flex items-center gap-2 p-4 border-b border-default">
          <Hammer className="w-4 h-4 text-amber-400" />
          <h3 className="text-sm font-semibold text-fg">Esto va a construir imágenes</h3>
        </div>

        <div className="p-4 space-y-3 text-[13px] text-fg-muted">
          <p className="leading-relaxed">
            {servicios.length === 1 ? 'Un servicio' : `${servicios.length} servicios`} de{' '}
            <strong className="text-fg">{plan.project_name}</strong> no tienen imagen, así que
            Docker las construirá antes de arrancar. Puede tardar varios minutos.
          </p>

          <ul className="space-y-2">
            {grupos.map(([contexto, builds]) => {
              const primero = builds[0]
              const sinMedir = primero.error !== null
              // Los nombres se piden al plan y no al grupo: el grupo solo guarda
              // costes, y perder el nombre aquí dejaría "Servicios: " a secas.
              const nombres = plan.services
                .filter((s) => s.build?.context === contexto)
                .map((s) => s.name)
              return (
                <li
                  key={contexto}
                  className="border border-default rounded-lg px-3 py-2 bg-inset/50"
                >
                  <p className="font-mono text-[11px] text-fg truncate" title={contexto}>
                    {contexto}
                  </p>
                  <p className="text-[12px] mt-0.5">
                    {builds.length === 1
                      ? `Servicio: ${nombres[0]}`
                      : `Servicios: ${nombres.join(', ')}`}
                  </p>
                  {sinMedir ? (
                    <p className="text-[12px] text-amber-400/90 mt-0.5">
                      No se pudo medir: {primero.error}
                    </p>
                  ) : (
                    <p className="text-[12px] mt-0.5">
                      <strong className="text-fg">{formatBytes(primero.bytes_aprox)}</strong>
                      {primero.truncado && ' (cifra parcial: el contexto es más grande)'}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>

          <p className="text-[11px] text-fg-subtle leading-relaxed">
            Los pesos no aplican <code className="font-mono">.dockerignore</code>, así que
            normalmente son algo mayores que lo que se enviará de verdad.
          </p>
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-default">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-xs font-medium border border-default rounded-lg text-fg-muted hover:text-fg hover:bg-elevated-hover transition-colors"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
          >
            Construir y arrancar
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}
