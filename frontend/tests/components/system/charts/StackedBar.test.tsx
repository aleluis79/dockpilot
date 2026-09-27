// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StackedBar } from '../../../../src/components/system/charts/StackedBar'

interface Tramo {
  label: string
  value: number
  /** Token del tema, p. ej. `var(--color-chart-images)`. */
  color: string
  /** Texto del valor en la leyenda. Si no se pasa, se usa el número crudo. */
  format?: (value: number) => string
}

const imagenes: Tramo = { label: 'Imágenes', value: 600, color: 'var(--color-chart-images)' }
const contenedores: Tramo = {
  label: 'Contenedores',
  value: 300,
  color: 'var(--color-chart-containers)',
}
const volumenes: Tramo = { label: 'Volúmenes', value: 100, color: 'var(--color-chart-volumes)' }

describe('StackedBar', () => {
  it('reparte el ancho entre los tramos', () => {
    render(<StackedBar titulo="Disco" tramos={[imagenes, contenedores, volumenes]} />)

    const barras = screen.getAllByTestId(/^stacked-tramo-/)
    expect(barras).toHaveLength(3)
    // 600 + 300 + 100 = 1000, así que 60 / 30 / 10.
    expect(barras[0]).toHaveStyle({ width: '60%' })
    expect(barras[1]).toHaveStyle({ width: '30%' })
    expect(barras[2]).toHaveStyle({ width: '10%' })
  })

  it('ordena los tramos de mayor a menor', () => {
    render(<StackedBar titulo="Disco" tramos={[volumenes, imagenes, contenedores]} />)

    // El orden de declaración es ruido: lo que importa es qué se lleva el espacio.
    const etiquetas = screen.getAllByTestId(/^stacked-leyenda-/).map((e) => e.textContent)
    expect(etiquetas[0]).toContain('Imágenes')
    expect(etiquetas[1]).toContain('Contenedores')
    expect(etiquetas[2]).toContain('Volúmenes')
  })

  it('cada tramo lleva su número en la leyenda', () => {
    render(<StackedBar titulo="Disco" tramos={[imagenes, contenedores]} />)

    // La gráfica localiza la proporción; el número da el valor.
    expect(screen.getByTestId('stacked-leyenda-Imágenes')).toHaveTextContent('600')
  })

  it('usa el formateador que le pasan para el valor', () => {
    render(
      <StackedBar
        titulo="Disco"
        tramos={[{ ...imagenes, format: (v) => `${(v / 1024).toFixed(0)} kB` }]}
      />
    )

    // 600 bytes son 0,58 kB: al redondear a entero, 1 kB.
    expect(screen.getByTestId('stacked-leyenda-Imágenes')).toHaveTextContent('1 kB')
  })

  it('una categoría a cero no dibuja tramo ni leyenda', () => {
    render(
      <StackedBar
        titulo="Disco"
        tramos={[imagenes, { ...volumenes, value: 0 }, contenedores]}
      />
    )

    // Un tramo de ancho cero es indistinguible de un hueco, y su leyenda solo
    // añade ruido.
    expect(screen.queryByTestId('stacked-leyenda-Volúmenes')).toBeNull()
    expect(screen.getAllByTestId(/^stacked-tramo-/)).toHaveLength(2)
  })

  it('con total cero dice que no hay datos y no dibuja barra', () => {
    render(<StackedBar titulo="Disco" tramos={[{ ...imagenes, value: 0 }]} />)

    expect(screen.getByText(/sin datos/i)).toBeInTheDocument()
    expect(screen.queryByTestId('stacked-barra')).toBeNull()
  })

  it('sin tramos dice que no hay datos', () => {
    render(<StackedBar titulo="Disco" tramos={[]} />)

    expect(screen.getByText(/sin datos/i)).toBeInTheDocument()
  })

  it('la descripción accesible incluye los valores, no solo la etiqueta', () => {
    render(<StackedBar titulo="Disco" tramos={[imagenes, contenedores]} />)

    // Un gráfico sin equivalente textual es invisible para un lector de pantalla.
    const grafica = screen.getByRole('img', { name: /disco/i })
    expect(grafica.getAttribute('aria-label')).toContain('Imágenes')
    expect(grafica.getAttribute('aria-label')).toContain('600')
    expect(grafica.getAttribute('aria-label')).toContain('300')
  })

  it('un color desconocido no rompe el render', () => {
    // El color llega como token, pero un `undefined` por un dato raro no puede
    // dejar la gráfica en blanco sin avisar.
    render(
      <StackedBar
        titulo="Disco"
        tramos={[{ ...imagenes, color: undefined as unknown as string }]}
      />
    )

    expect(screen.getByTestId('stacked-tramo-Imágenes')).toBeInTheDocument()
  })

  it('los valores negativos se ignoran en vez de romper el reparto', () => {
    render(<StackedBar titulo="Disco" tramos={[imagenes, { ...volumenes, value: -50 }]} />)

    const barras = screen.getAllByTestId(/^stacked-tramo-/)
    expect(barras).toHaveLength(1)
    expect(barras[0]).toHaveStyle({ width: '100%' })
  })
})
