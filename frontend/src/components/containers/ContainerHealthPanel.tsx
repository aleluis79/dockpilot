// SPDX-License-Identifier: AGPL-3.0-or-later
import React from 'react'
import type { HealthDetail } from '../../types/docker'

interface ContainerHealthPanelProps {
  health?: HealthDetail
}

/**
 * Por qué un contenedor no está sano (SPEC-18).
 *
 * Existe por una razón concreta: "está unhealthy" no es accionable. Lo que lo
 * convierte en accionable es **qué se está midiendo** (`Config.Healthcheck.Test`)
 * y **qué dijo la sonda** (`State.Health.Log`). Sin las dos cosas, el panel
 * informa de un síntoma y no de una causa.
 *
 * Un contenedor sin healthcheck no pinta nada: la ausencia del dato no es un
 * estado, y la mayoría de contenedores no tiene sonda.
 */
export const ContainerHealthPanel: React.FC<ContainerHealthPanelProps> = ({ health }) => {
  if (!health || health.status === 'none') return null

  const unhealthy = health.status === 'unhealthy'
  const starting = health.status === 'starting'

  const clases = unhealthy
    ? 'bg-rose-500/5 border-rose-500/20'
    : starting
      ? // `starting` es el `start_period`: la sonda aún no ha fallado, así que no
        // se pinta como problema aunque se parezca a uno.
        'bg-amber-500/5 border-amber-500/20'
      : 'bg-emerald-500/5 border-emerald-500/20'

  const titulo = unhealthy
    ? `Healthcheck fallando${health.failing_streak > 0 ? ` · ${health.failing_streak} sonda(s) seguida(s)` : ''}`
    : starting
      ? 'Healthcheck comprobando'
      : 'Healthcheck correcto'

  return (
    <section data-testid="salud-detalle" className={`p-4 rounded-xl border ${clases}`}>
      <header className="flex items-baseline justify-between gap-2">
        <h4 className="text-xs uppercase text-fg-muted font-semibold tracking-wider">
          Salud
        </h4>
        <span
          className={`text-xs font-medium ${unhealthy ? 'text-rose-700 dark:text-rose-400' : starting ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'}`}
        >
          {titulo}
        </span>
      </header>

      {starting && (
        <p className="mt-2 text-xs text-fg-muted">
          Está dentro del periodo de gracia (<code>start_period</code>): la sonda todavía no ha
          fallado, así que aún no se sabe si el contenedor está bien.
        </p>
      )}

      {health.test.length > 0 && (
        <div className="mt-3">
          <span className="text-xs text-fg-muted">Comprobando</span>
          <p className="mt-1 font-mono text-fg text-xs bg-inset rounded-lg px-2.5 py-1.5 border border-default/60 break-all">
            {health.test.join(' ')}
          </p>
        </div>
      )}

      {health.log.length > 0 && (
        <div className="mt-3">
          <span className="text-xs text-fg-muted">
            Últimas sondas ({health.log.length})
          </span>
          <ul className="mt-1 space-y-1.5">
            {health.log.map((sonda, i) => (
              <li
                key={`${sonda.started_at}-${i}`}
                data-testid={`sonda-${i}`}
                data-hora={sonda.started_at}
                className="p-2 rounded-lg bg-inset border border-default/60"
              >
                <div className="flex items-baseline justify-between gap-2 text-[11px]">
                  <span
                    className={`font-medium ${sonda.exit_code === 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}`}
                  >
                    exit {sonda.exit_code}
                  </span>
                  <span className="text-fg-subtle font-mono">{sonda.started_at || 'sin fecha'}</span>
                </div>
                {sonda.output && (
                  // `whitespace-pre-wrap` porque la salida de una sonda puede ser
                  // multilínea (un volcado de stack), y `break-all` porque puede no
                  // tener espacios. El backend ya la recorta a 4 KB.
                  <pre className="mt-1 text-[11px] text-fg-muted font-mono whitespace-pre-wrap break-all">
                    {sonda.output}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
