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
