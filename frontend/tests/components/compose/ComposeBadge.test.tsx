import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ComposeBadge } from '../../../src/components/compose/ComposeBadge'

describe('ComposeBadge', () => {
  it('muestra el nombre del proyecto', () => {
    render(<ComposeBadge project="tickets-app" />)

    expect(screen.getByText('tickets-app')).toBeInTheDocument()
  })

  it('no pinta nada cuando el recurso no es de un proyecto', () => {
    // Regresión: una columna `Proyecto` vacía en el 100% de las filas es ruido.
    // El componente no debe ni siquiera renderizar un contenedor.
    const { container } = render(<ComposeBadge project={null} />)

    expect(container).toBeEmptyDOMElement()
  })

  it('no pinta nada con el proyecto vacío', () => {
    const { container } = render(<ComposeBadge project="" />)

    expect(container).toBeEmptyDOMElement()
  })
})
