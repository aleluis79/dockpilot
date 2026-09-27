import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ComposeDownDialog } from '../../../src/components/compose/ComposeDownDialog'

describe('ComposeDownDialog', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('ofrece down y down --volumes por separado', () => {
    render(
      <ComposeDownDialog
        project="tienda"
        volumes={['tienda_app_data', 'tienda_cache']}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    )

    // Dos opciones separadas: bajar el proyecto y bajar sus volúmenes no son lo
    // mismo, y la segunda nunca es la que se pulsa sin querer.
    expect(screen.getByRole('button', { name: /^bajar$/i })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /borrando también los volúmenes/i })
    ).toBeInTheDocument()
  })

  it('no activa volumes por defecto', () => {
    // Es la única acción irreversible de la spec: nunca puede ser la que se
    // pulsa por inercia.
    const onConfirm = vi.fn()
    render(
      <ComposeDownDialog
        project="tienda"
        volumes={['tienda_app_data']}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /^bajar$/i }))

    expect(onConfirm).toHaveBeenCalledWith(false)
  })

  it('confirma con volumes solo en la opción destructiva', () => {
    const onConfirm = vi.fn()
    render(
      <ComposeDownDialog
        project="tienda"
        volumes={['tienda_app_data']}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />
    )

    // Armar y después confirmar: son dos pulsaciones, no una.
    fireEvent.click(screen.getByRole('button', { name: /borrando también los volúmenes/i }))
    expect(onConfirm).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /sí, borrar/i }))
    expect(onConfirm).toHaveBeenCalledWith(true)
  })

  it('muestra los nombres reales de los volúmenes que se van a perder', () => {
    // Mostrar el recuento no basta: quien borra necesita ver QUÉ se borra.
    render(
      <ComposeDownDialog
        project="tienda"
        volumes={['tienda_app_data', 'tienda_cache']}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    )

    expect(screen.getByText('tienda_app_data')).toBeInTheDocument()
    expect(screen.getByText('tienda_cache')).toBeInTheDocument()
  })

  it('escribe el nombre del proyecto en la confirmación destructiva', () => {
    render(
      <ComposeDownDialog
        project="tienda"
        volumes={['tienda_app_data']}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    )

    // Armar la confirmación muestra el botón con el nombre del proyecto dentro.
    fireEvent.click(screen.getByRole('button', { name: /borrando también los volúmenes/i }))

    const boton = screen.getByRole('button', { name: /sí, borrar/i })
    expect(boton.textContent).toContain('tienda')
    expect(screen.getByText(/no se puede deshacer/i)).toBeInTheDocument()
  })

  it('el botón destructivo no comparte aspecto con el normal', () => {
    render(
      <ComposeDownDialog
        project="tienda"
        volumes={['tienda_app_data']}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    )

    const normal = screen.getByRole('button', { name: /^bajar$/i })
    const destructivo = screen.getByRole('button', { name: /borrando también los volúmenes/i })
    // Distinto color de fondo: que no se pulse sin querer.
    expect(normal.className).not.toBe(destructivo.className)
    expect(destructivo.className).toMatch(/red|rose/)
  })

  it('exige una segunda pulsación para la opción destructiva', () => {
    const onConfirm = vi.fn()
    render(
      <ComposeDownDialog
        project="tienda"
        volumes={['tienda_app_data']}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /borrando también los volúmenes/i }))
    // Primera pulsación solo arma la confirmación.
    expect(onConfirm).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /sí, borrar/i }))
    expect(onConfirm).toHaveBeenCalledWith(true)
  })

  it('avisa de que no hay volúmenes que borrar', () => {
    render(
      <ComposeDownDialog
        project="tienda"
        volumes={[]}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    )

    expect(screen.getByText(/no declara volúmenes/i)).toBeInTheDocument()
  })

  it('cancela sin confirmar', () => {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    render(
      <ComposeDownDialog
        project="tienda"
        volumes={['tienda_app_data']}
        onClose={onClose}
        onConfirm={onConfirm}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /cancelar/i }))

    expect(onClose).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
