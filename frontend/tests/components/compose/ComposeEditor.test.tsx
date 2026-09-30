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

  it('no ofrece insignia de "editado" contra un original que no tiene', () => {
    // El editor nunca carga el contenido del disco: hacerlo abriría una segunda
    // vía de lectura sin límite de tamaño propio (SPEC-14 §3.3). Una insignia
    // "editado" compararía el texto contra sí mismo, así que no existe. El
    // aviso real vive en `ComposePlanModal`, junto al botón que depende de él.
    render(<ComposeEditor value="services: {}" onChange={vi.fn()} />)

    expect(screen.queryByTestId('editor-dirty')).not.toBeInTheDocument()
    expect(
      screen.getByText(/no se guarda/i),
      'el editor debe seguir diciendo que no guarda'
    ).toBeInTheDocument()
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
