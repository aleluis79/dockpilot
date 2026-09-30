import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatusBadge } from '../../src/components/ui/StatusBadge'

describe('StatusBadge', () => {
  it('renders green badge for running status', () => {
    render(<StatusBadge status="running" />)
    const badge = screen.getByText('running')
    expect(badge).toBeInTheDocument()
    expect(badge.className).toContain('emerald')
  })

  it('renders yellow badge for paused or restarting status', () => {
    const { rerender } = render(<StatusBadge status="paused" />)
    expect(screen.getByText('paused').className).toContain('amber')

    rerender(<StatusBadge status="restarting" />)
    expect(screen.getByText('restarting').className).toContain('amber')
  })

  it('renders neutral badge with theme tokens for exited status', () => {
    render(<StatusBadge status="exited" />)
    const badge = screen.getByText('exited')
    expect(badge).toBeInTheDocument()
    // El badge neutro usa tokens del sistema de temas, no colores literales
    expect(badge.className).toContain('bg-elevated')
    expect(badge.className).toContain('text-fg-muted')
    expect(badge.className).not.toContain('zinc')
  })

  it('renders red badge for dead status', () => {
    render(<StatusBadge status="dead" />)
    const badge = screen.getByText('dead')
    expect(badge).toBeInTheDocument()
    expect(badge.className).toContain('rose')
  })
})

// --- Healthchecks (SPEC-18) ----------------------------------------------------

describe('StatusBadge con salud', () => {
  const SIN_SALUD = { status: 'none' as const, failing_streak: 0 }

  it('no cambia un píxel sin healthcheck', () => {
    // El caso mayoritario: la mayoría de contenedores no declara sonda. Mostrar
    // "none" al lado de cada uno sería gritar sobre lo que no está mal, así que
    // sin healthcheck el marcado tiene que ser idéntico byte a byte (SPEC-18 §3.3).
    const { container: sinCampo } = render(<StatusBadge status="running" />)
    const marcadoOriginal = sinCampo.innerHTML

    const { container: conNone } = render(<StatusBadge status="running" health={SIN_SALUD} />)

    expect(conNone.innerHTML).toBe(marcadoOriginal)
  })

  it('running con unhealthy muestra las DOS cosas', () => {
    // "Está en marcha" y "no está bien" son ejes distintos y no se funden: el
    // estado de ejecución es lo que se escanea en una tabla.
    render(<StatusBadge status="running" health={{ status: 'unhealthy', failing_streak: 8 }} />)

    expect(screen.getByText('running')).toBeInTheDocument()
    expect(screen.getByTestId('salud-badge')).toBeInTheDocument()
    expect(screen.getByTestId('salud-badge')).toHaveTextContent('unhealthy')
  })

  it('starting no se pinta como error', () => {
    // Con `start_period` una sonda recién arrancada sale `starting`: aún no se
    // sabe, y no es un fallo.
    render(<StatusBadge status="running" health={{ status: 'starting', failing_streak: 0 }} />)

    const salud = screen.getByTestId('salud-badge')
    expect(salud).toHaveTextContent('starting')
    expect(salud.className).toContain('amber')
    expect(salud.className).not.toContain('rose')
  })

  it('healthy se marca en verde y de forma discreta', () => {
    render(<StatusBadge status="running" health={{ status: 'healthy', failing_streak: 0 }} />)

    const salud = screen.getByTestId('salud-badge')
    expect(salud).toHaveTextContent('healthy')
    expect(salud.className).toContain('emerald')
  })

  it('muestra el contador de fallos cuando los hay', () => {
    render(<StatusBadge status="running" health={{ status: 'unhealthy', failing_streak: 8 }} />)

    expect(screen.getByTestId('salud-badge')).toHaveTextContent('8')
  })

  it('unhealthy en un contenedor parado no se pinta en rojo de error', () => {
    // `exited` manda: el estado de ejecución es el titular.
    render(<StatusBadge status="exited" health={{ status: 'unhealthy', failing_streak: 3 }} />)

    expect(screen.getByText('exited')).toBeInTheDocument()
    expect(screen.getByTestId('salud-badge')).toHaveTextContent('unhealthy')
  })
})
