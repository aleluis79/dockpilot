import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ComposeEditor } from '../../../src/components/compose/ComposeEditor'

describe('ComposeEditor', () => {
  it('precarga el contenido del archivo', () => {
    render(<ComposeEditor value={'services:\n  web:\n    image: nginx'} onChange={vi.fn()} />)

    expect(screen.getByTestId('compose-editor')).toHaveValue(
      'services:\n  web:\n    image: nginx'
    )
  })

  it('refleja la edición en el callback', () => {
    const onChange = vi.fn()
    render(<ComposeEditor value="" onChange={onChange} />)

    fireEvent.change(screen.getByTestId('compose-editor'), {
      target: { value: 'services: {}' },
    })

    expect(onChange).toHaveBeenCalledWith('services: {}')
  })

  it('avisa de que la edición no se guarda en disco', () => {
    // El editor sirve para probar un cambio, no para reemplazar el archivo: el
    // panel no escribe en el disco del usuario.
    render(<ComposeEditor value="" onChange={vi.fn()} />)

    expect(screen.getByText(/no se guarda/i)).toBeInTheDocument()
  })

  it('informa de si el contenido está editado respecto al original', () => {
    const { rerender } = render(
      <ComposeEditor value="original" original="original" onChange={vi.fn()} />
    )
    expect(screen.queryByTestId('editor-dirty')).not.toBeInTheDocument()

    rerender(
      <ComposeEditor value="cambiado" original="original" onChange={vi.fn()} />
    )
    expect(screen.getByTestId('editor-dirty')).toBeInTheDocument()
  })

  it('permite insertar una ruta de ejemplo', () => {
    const onChange = vi.fn()
    render(<ComposeEditor value="" onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: /ejemplo/i }))

    expect(onChange).toHaveBeenCalled()
    expect(String(onChange.mock.calls[0][0])).toContain('services:')
  })

  it('no ofrece botón de guardar al disco', () => {
    render(<ComposeEditor value="" onChange={vi.fn()} />)

    expect(screen.queryByRole('button', { name: /guardar/i })).not.toBeInTheDocument()
  })
})
