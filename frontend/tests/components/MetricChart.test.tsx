// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MetricChart } from '../../src/components/stats/MetricChart'
import type { Punto } from '../../src/utils/rates'

const COLOR = 'var(--color-chart-running)'

function puntos(lista: [number, number | null][], corteEn: number[] = []): Punto[] {
  return lista.map(([t, valor], i) => ({ t, valor, corte: corteEn.includes(i) }))
}

describe('MetricChart', () => {
  it('pinta un trazo por cada tramo de la serie', () => {
    render(<MetricChart puntos={puntos([[0, 10], [2, 20], [4, 30]])} etiqueta="CPU" color={COLOR} sufijo="%" interval_s={2} />)

    expect(screen.getAllByTestId('metric-chart-tramo')).toHaveLength(1)
  })

  it('parte el trazo en el corte y no une los extremos', () => {
    render(<MetricChart puntos={puntos([[0, 10], [2, 20], [4, null], [6, 30]], [2])} etiqueta="CPU" color={COLOR} sufijo="%" interval_s={2} />)

    // Dos tramos, y el segundo empieza en el punto del corte: un solo `path` que
    // pasara por los cuatro puntos dibujaría una caída que no ocurrió.
    const tramos = screen.getAllByTestId('metric-chart-tramo')
    expect(tramos).toHaveLength(2)
    expect(tramos[1]).toHaveAttribute('d', expect.stringContaining('M'))
  })

  it('coloca la abscisa por tiempo y no por índice', () => {
    // Dos muestras al principio, un hueco largo y dos al final. Por índice, la
    // última caería en el mismo sitio que la segunda; por tiempo, al final.
    const { container } = render(
      <MetricChart
        puntos={puntos([[0, 1], [2, 2], [30, 3], [32, 4]])}
        etiqueta="CPU"
        color={COLOR}
        sufijo="%"
      />
    )

    const d = container.querySelector('[data-testid="metric-chart-tramo"]')?.getAttribute('d') ?? ''
    const x = [...d.matchAll(/[ML] ([\d.]+)/g)].map((m) => Number(m[1]))

    expect(x[0]).toBeCloseTo(0)
    expect(x[x.length - 1]).toBeCloseTo(100)
    // La tercera muestra está a 30 de 32 de segundo, así que va casi al final y
    // no en el centro, que es donde la pondría un reparto por índice.
    expect(x[2]).toBeGreaterThan(90)
  })

  it('con un solo punto dibuja un punto y no una línea', () => {
    render(<MetricChart puntos={puntos([[10, 42]])} etiqueta="CPU" color={COLOR} sufijo="%" interval_s={2} />)

    expect(screen.getByTestId('metric-chart-aislado')).toBeInTheDocument()
    expect(screen.queryByTestId('metric-chart-tramo')).not.toBeInTheDocument()
  })

  it('sin datos explica por qué está vacío y no dibuja un SVG', () => {
    render(<MetricChart puntos={[]} etiqueta="CPU" color={COLOR} sufijo="%" interval_s={2} vacio="Sin historial todavía" />)

    expect(screen.getByText('Sin historial todavía')).toBeInTheDocument()
    expect(screen.queryByTestId('metric-chart-svg')).not.toBeInTheDocument()
  })

  it('lee actual, media y máximo y no inventa ceros', () => {
    render(
      <MetricChart
        puntos={puntos([[0, 10], [2, null], [4, 30]])}
        etiqueta="CPU"
        color={COLOR}
        sufijo="%"
        formato={(v) => `${v} %`}
      />
    )

    expect(screen.getByText('actual 30 %')).toBeInTheDocument()
    expect(screen.getByText('media 20 %')).toBeInTheDocument()
    expect(screen.getByText('máx 30 %')).toBeInTheDocument()
  })

  it('con todos los valores nulos la lectura dice que no hay datos', () => {
    render(
      <MetricChart
        puntos={puntos([[0, null], [2, null]])}
        etiqueta="CPU"
        color={COLOR}
        sufijo="%"
        formato={(v) => `${v} %`}
      />
    )

    expect(screen.getByText('sin datos')).toBeInTheDocument()
  })

  it('el color va por token y no por un literal', () => {
    const { container } = render(<MetricChart puntos={puntos([[0, 1], [2, 2]])} etiqueta="CPU" color={COLOR} sufijo="%" interval_s={2} />)

    const trazo = container.querySelector('[data-testid="metric-chart-tramo"]')
    expect(trazo).toHaveAttribute('stroke', COLOR)
  })

  it('es accesible con una etiqueta que lo describe', () => {
    render(<MetricChart puntos={puntos([[0, 1], [2, 2]])} etiqueta="CPU" color={COLOR} sufijo="%" interval_s={2} />)

    expect(screen.getByRole('img', { name: /cpu/i })).toBeInTheDocument()
  })
})