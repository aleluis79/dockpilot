// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ConsumerBars } from '../../../../src/components/system/charts/ConsumerBars'
import type { TopConsumer } from '../../../../src/types/system'

const consumidor = (name: string, size: number, kind = 'volume'): TopConsumer => ({
  kind,
  name,
  size,
  detail: '',
})

describe('ConsumerBars', () => {
  it('la barra más larga es la del mayor consumidor', () => {
    render(
      <ConsumerBars
        titulo="Mayores volúmenes"
        consumidores={[
          consumidor('datos-postgres', 900),
          consumidor('cache', 100),
          consumidor('uploads', 500),
        ]}
      />
    )

    const barras = screen.getAllByTestId(/^consumer-barra-/)
    // 900 es el mayor, así que su barra va llena.
    expect(barras[0]).toHaveStyle({ width: '100%' })
    // El orden también se normaliza a mayor primero, no como venga.
    expect(screen.getByTestId('consumer-nombre-datos-postgres')).toBeInTheDocument()
    const nombres = screen
      .getAllByTestId(/^consumer-nombre-/)
      .map((e) => e.getAttribute('data-consumer'))
    expect(nombres).toEqual(['datos-postgres', 'uploads', 'cache'])
  })

  it('cada consumidor lleva su tamaño', () => {
    render(<ConsumerBars titulo="Mayores volúmenes" consumidores={[consumidor('datos', 2048)]} />)

    expect(screen.getByTestId('consumer-fila-datos')).toHaveTextContent('2.0 KB')
  })

  it('usa el formateador que le pasan', () => {
    render(
      <ConsumerBars
        titulo="Mayores volúmenes"
        consumidores={[consumidor('datos', 3)]}
        format={(v) => `${v} unidades`}
      />
    )

    expect(screen.getByTestId('consumer-fila-datos')).toHaveTextContent('3 unidades')
  })

  it('sin consumidores dice que no hay datos', () => {
    render(<ConsumerBars titulo="Mayores volúmenes" consumidores={[]} />)

    expect(screen.getByText(/sin datos/i)).toBeInTheDocument()
  })

  it('un solo consumidor ocupa el ancho completo', () => {
    render(<ConsumerBars titulo="Mayores volúmenes" consumidores={[consumidor('solo', 10)]} />)

    expect(screen.getByTestId('consumer-barra-solo')).toHaveStyle({ width: '100%' })
  })

  it('todos a cero no dibuja barras de ancho cero', () => {
    render(
      <ConsumerBars
        titulo="Mayores volúmenes"
        consumidores={[consumidor('a', 0), consumidor('b', 0)]}
      />
    )

    // Una barra de ancho cero parecería un dato, y no lo es.
    expect(screen.getByText(/sin datos/i)).toBeInTheDocument()
    expect(screen.queryByTestId(/^consumer-barra-/)).toBeNull()
  })

  it('el detalle del consumidor se muestra cuando viene', () => {
    render(
      <ConsumerBars
        titulo="Mayores imágenes"
        consumidores={[{ ...consumidor('nginx:latest', 10, 'image'), detail: '1.2 GB en disco' }]}
      />
    )

    expect(screen.getByText('1.2 GB en disco')).toBeInTheDocument()
  })
})
