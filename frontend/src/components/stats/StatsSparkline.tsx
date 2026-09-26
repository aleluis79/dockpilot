import React from 'react'
import type { StatsHistoryPoint } from '../../types/stats'

type StatsMetric = 'cpu_percent' | 'memory_percent'

interface StatsSparklineProps {
  points: StatsHistoryPoint[]
  metric: StatsMetric
  color: string
  height?: number
}

const VIEW_WIDTH = 100

export const StatsSparkline: React.FC<StatsSparklineProps> = ({
  points,
  metric,
  color,
  height = 32,
}) => {
  const label = metric === 'cpu_percent' ? 'cpu' : 'memoria'

  if (points.length === 0) {
    return (
      <div
        data-testid={`stats-sparkline-${label}`}
        className="h-8 flex items-center justify-center text-[10px] uppercase tracking-wider text-zinc-600"
      >
        Sin datos
      </div>
    )
  }

  const coords = points.map((point, i) => {
    const raw = point[metric] ?? 0
    const value = Math.max(0, Math.min(100, raw))
    const x = points.length === 1 ? 0 : (i / (points.length - 1)) * VIEW_WIDTH
    const y = height - 2 - (value / 100) * (height - 4)
    return { x, y }
  })

  const path = coords
    .map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(2)} ${c.y.toFixed(2)}`)
    .join(' ')

  return (
    <svg
      data-testid={`stats-sparkline-${label}`}
      viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Historial de ${label}`}
      className="w-full overflow-visible"
      style={{ height }}
    >
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {coords.map((c, i) => (
        <circle
          key={i}
          cx={c.x.toFixed(2)}
          cy={c.y.toFixed(2)}
          r="1.5"
          fill={color}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  )
}
