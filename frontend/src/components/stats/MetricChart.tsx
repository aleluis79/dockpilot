// SPDX-License-Identifier: AGPL-3.0-or-later
import React from 'react'

import { segmentos, resumen, type Punto } from '../../utils/rates'

interface MetricChartProps {
  puntos: Punto[];
  etiqueta: string;
  /** Token de la paleta de `index.css`, nunca un literal. */
  color: string;
  /** `%` para porcentajes; para tasas se formatea en bytes por segundo. */
  sufijo?: string;
  formato?: (valor: number) => string;
  /** Texto del estado vacío. Sin él no se explica por qué no hay nada. */
  vacio?: string;
  /** Periodo nominal del muestreo, en segundos. Sin él no se detectan huecos:
   *  un hueco es "más de 2,5 intervalos", y sin el intervalo no hay umbral. */
  interval_s: number;
  height?: number;
}

const ANCHO = 100;
const ALTO = 64;
const MARGEN_INFERIOR = 4;

/**
 * Una serie de métricas en SVG, sin librería (SPEC-16 §3.2 y SPEC-17 §4.7).
 *
 * Dos cosas que no sonesty y que un gráfico de puntos no hace solo:
 *
 * - **La abscisa es tiempo, no índice.** Con huecos —un contenedor parado, un
 *   tic perdido— un reparto por índice Alfredería el tiempo: la misma ventana
 *   parecería más corta cuanto más antiguo fuera el anillo.
 * - **Un corte es un corte.** Cada tramo se dibuja con su propio `path`, así que
 *   un reinicio del contenedor no puede acabar unido por una línea de 40 GB.
 */
export const MetricChart: React.FC<MetricChartProps> = ({
  puntos,
  etiqueta,
  color,
  sufijo = '',
  formato,
  vacio,
  interval_s,
  height = 96,
}) => {
  // Sólo sin puntos la serie está vacía. Con puntos pero sin valores —una única
  // muestra de una tasa, que aún no se puede derivar— NO se dice "sin
  // historial": hay historial, lo que no hay es una tasa, y mentirse aquí sería
  // repetir el error de dibujar un 0 donde no se midió nada.
  if (puntos.length === 0) {
    return (
      <div
        data-testid="metric-chart-vacio"
        className="flex h-24 flex-col items-center justify-center gap-1 text-[10px] uppercase tracking-wider text-fg-subtle"
      >
        <span>{vacio ?? 'Sin datos'}</span>
      </div>
    )
  }

  const tramos = segmentos(puntos, interval_s)
  const t0 = puntos[0].t;
  const span = Math.max(puntos[puntos.length - 1].t - t0, 1)
  const maximo = Math.max(...puntos.map((p) => p.valor ?? 0), 1)

  const x = (t: number) => ((t - t0) / span) * ANCHO;
  const y = (valor: number) => ALTO - MARGEN_INFERIOR - (valor / maximo) * (ALTO - MARGEN_INFERIOR * 2)
  const leer = (valor: number) => (formato ? formato(valor) : `${valor.toFixed(1)}${sufijo}`)
  const { actual, media, maximo: tope } = resumen(puntos)

  return (
    <figure className="flex flex-col gap-1">
      <div
        className="flex items-baseline justify-between gap-2 text-[11px] text-fg-muted"
        data-testid="metric-chart-lectura"
      >
        <span className="truncate text-fg">{etiqueta}</span>
        {actual === null ? (
          <span className="text-fg-subtle">sin datos</span>
        ) : (
          <span className="flex shrink-0 gap-2 tabular-nums">
            <span>actual {leer(actual)}</span>
            <span className="hidden sm:inline">media {leer(media ?? 0)}</span>
            <span className="hidden sm:inline">máx {leer(tope ?? 0)}</span>
          </span>
        )}
      </div>

      <svg
        data-testid="metric-chart-svg"
        viewBox={`0 0 ${ANCHO} ${ALTO}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Serie temporal de ${etiqueta}`}
        className="w-full"
        style={{ height }}
      >
        {tramos.map((tramo, i) =>
          tramo.length === 1 ? null : (
            <path
              key={i}
              data-testid="metric-chart-tramo"
              d={tramo
                .map((p, j) => {
                  const cmd = j === 0 ? 'M' : 'L'
                  return `${cmd} ${x(p.t).toFixed(2)} ${y(p.valor ?? 0).toFixed(2)}`
                })
                .join(' ')}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
          )
        )}
        {tramos.map((tramo, i) =>
          tramo.length === 1 ? (
            <circle
              key={`p${i}`}
              data-testid="metric-chart-aislado"
              cx={x(tramo[0].t)}
              cy={y(tramo[0].valor ?? 0)}
              r={1.5}
              fill={color}
            />
          ) : null
        )}
      </svg>
    </figure>
  )
}
