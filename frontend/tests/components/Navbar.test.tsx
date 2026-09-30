import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Navbar } from '../../src/components/layout/Navbar'
import { ThemeProvider } from '../../src/components/layout/ThemeProvider'

/** El Navbar monta el ThemeToggle, que necesita el provider. */
const conTema = (ui: React.ReactNode) => render(<ThemeProvider>{ui}</ThemeProvider>)

describe('Navbar: indicador de conexión', () => {
  it('dice «Conectado» cuando no hay error', () => {
    conTema(<Navbar onRefresh={() => {}} loading={false} error={null} />)

    expect(screen.getByText('Conectado')).toBeInTheDocument()
    expect(screen.queryByText('Sin conexión')).not.toBeInTheDocument()
  })

  it('deja de decir «Conectado» cuando el backend falla', () => {
    // El indicador era decorativo: ponía «Conectado» siempre. Con el daemon
    // parado, cada vista enseñaba su propio error mientras la barra afirmaba
    // justo lo contrario.
    conTema(
      <Navbar
        onRefresh={() => {}}
        loading={false}
        error="No se pudo conectar con Docker: Error al conectar con Docker daemon"
      />
    )

    expect(screen.getByText('Sin conexión')).toBeInTheDocument()
    expect(screen.queryByText('Conectado')).not.toBeInTheDocument()
  })

  it('el tooltip lleva el motivo del fallo', () => {
    const { container } = conTema(
      <Navbar onRefresh={() => {}} loading={false} error="socket cerrado" />
    )

    const indicador = container.querySelector('[title="socket cerrado"]')
    expect(indicador).not.toBeNull()
  })

  it('sin prop `error` se comporta como conectado (retrocompatible)', () => {
    conTema(<Navbar onRefresh={() => {}} loading={false} />)

    expect(screen.getByText('Conectado')).toBeInTheDocument()
  })

  it('sigue funcionando el resto y abre los modales', () => {
    const onRefresh = vi.fn()
    const onOpenCreateModal = vi.fn()
    const onOpenHelp = vi.fn()

    conTema(
      <Navbar
        onRefresh={onRefresh}
        loading={false}
        onOpenCreateModal={onOpenCreateModal}
        onOpenHelp={onOpenHelp}
      />
    )

    fireEvent.click(screen.getByTitle('Refrescar lista'))
    expect(onRefresh).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Nuevo Contenedor' }))
    expect(onOpenCreateModal).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Abrir la ayuda' }))
    expect(onOpenHelp).toHaveBeenCalled()
  })
})