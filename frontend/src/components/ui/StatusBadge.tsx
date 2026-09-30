// SPDX-License-Identifier: AGPL-3.0-or-later
import React from 'react'
import type { HealthSummary } from '../../types/docker'

interface StatusBadgeProps {
  status: string
  /**
   * Salud del healthcheck (SPEC-18). Opcional, y su ausencia se pinta igual que
   * `"none"`: un contenedor sin sonda es la mayoría y no puede añadir ruido a
   * la fila.
   */
  health?: HealthSummary
}

/**
 * Píldora de estado de ejecución, con la salud del healthcheck al lado.
 *
 * Son **dos ejes distintos y no se funden** (§3.3 de SPEC-18). El estado de
 * ejecución es lo que se escanea en una tabla: un contenedor `exited` con el
 * healthcheck en `unhealthy` se titula `exited`, porque el problema ahora es que
 * está parado, no que su sonda falle.
 *
 * Y sin healthcheck el marcado es **idéntico** al de antes de esta spec: ni punto
 * extra, ni texto, ni borde. Hay un test que compara el `innerHTML` con y sin
 * `health` para que no se pueda añadir de forma inadvertida.
 */
export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, health }) => {
  const norm = (status || '').toLowerCase()

  const etiqueta = (
    estado: string,
    clases: string,
    punto: string,
    pulso = false
  ) => (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${clases}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${punto} ${pulso ? 'animate-pulse' : ''}`} />
      {estado}
    </span>
  )

  const principal =
    norm === 'running'
      ? etiqueta(
          status,
          'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20',
          'bg-emerald-400',
          true
        )
      : norm === 'paused' || norm === 'restarting'
        ? etiqueta(
            status,
            'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20',
            'bg-amber-400'
          )
        : norm === 'dead'
          ? etiqueta(
              status,
              'bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20',
              'bg-rose-400'
            )
          : etiqueta(status, 'bg-elevated text-fg-muted border-strong/50', 'bg-fg-subtle')

  const marca = <MarcaSalud health={health} />

  // Sin salud que mostrar, se devuelve la píldora sola y con el mismo marcado
  // que antes: el contenedor tampoco debe pagar un wrapper de más.
  if (!marca) return principal

  return (
    <span className="inline-flex items-center gap-1.5">
      {principal}
      {marca}
    </span>
  )
}

const MarcaSalud: React.FC<{ health?: HealthSummary }> = ({ health }) => {
  // `none` no es un estado: es la ausencia del dato. Un contenedor sin healthcheck
  // no se distingue de uno al que nunca se le miró, y no se pinta nada.
  if (!health || health.status === 'none') return null

  const texto =
    health.status === 'unhealthy' && health.failing_streak > 0
      ? `${health.status} ×${health.failing_streak}`
      : health.status

  const clases =
    health.status === 'unhealthy'
      ? 'bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20'
      : health.status === 'starting'
        ? // `starting` es el `start_period`: aún no se sabe. No es un fallo, y
          // por eso no va en rojo aunque parezca un problema.
          'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20'
        : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20'

  const punto =
    health.status === 'unhealthy'
      ? 'bg-rose-400'
      : health.status === 'starting'
        ? 'bg-amber-400 animate-pulse'
        : 'bg-emerald-400'

  return (
    <span
      data-testid="salud-badge"
      title={
        health.status === 'starting'
          ? 'Dentro del periodo de gracia: la sonda aún no ha fallado'
          : `Healthcheck: ${health.status}`
      }
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium border ${clases}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${punto}`} />
      {texto}
    </span>
  )
}