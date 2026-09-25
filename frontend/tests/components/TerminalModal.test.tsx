import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TerminalModal } from '../../src/components/terminal/TerminalModal'
import type { ContainerSummary } from '../../src/types/docker'

// Mock de @xterm/xterm y @xterm/addon-fit para entorno jsdom
vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    cols = 80
    rows = 24
    open = vi.fn()
    write = vi.fn()
    clear = vi.fn()
    dispose = vi.fn()
    onData = vi.fn().mockReturnValue({ dispose: vi.fn() })
    onResize = vi.fn().mockReturnValue({ dispose: vi.fn() })
    loadAddon = vi.fn()
  }
  return {
    Terminal: MockTerminal,
  }
})

vi.mock('@xterm/addon-fit', () => {
  class MockFitAddon {
    fit = vi.fn()
  }
  return {
    FitAddon: MockFitAddon,
  }
})

describe('TerminalModal', () => {
  const mockContainer: ContainerSummary = {
    id: 'c12345678901',
    name: 'web-app',
    image: 'nginx:alpine',
    status: 'running',
    state: 'running',
    created: 1727290000,
    ports: [],
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders modal with container name and shell selector when open', () => {
    render(
      <TerminalModal
        isOpen={true}
        container={mockContainer}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByText('Terminal')).toBeInTheDocument()
    expect(screen.getByText('web-app')).toBeInTheDocument()
    expect(screen.getByRole('combobox')).toBeInTheDocument()
    expect(screen.getByText('Limpiar')).toBeInTheDocument()
  })

  it('does not render when isOpen is false', () => {
    render(
      <TerminalModal
        isOpen={false}
        container={mockContainer}
        onClose={vi.fn()}
      />
    )

    expect(screen.queryByText('Terminal')).not.toBeInTheDocument()
  })

  it('allows switching shell between /bin/sh and /bin/bash', () => {
    render(
      <TerminalModal
        isOpen={true}
        container={mockContainer}
        onClose={vi.fn()}
      />
    )

    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('/bin/sh')

    fireEvent.change(select, { target: { value: '/bin/bash' } })
    expect(select.value).toBe('/bin/bash')
  })

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn()
    render(
      <TerminalModal
        isOpen={true}
        container={mockContainer}
        onClose={onClose}
      />
    )

    const closeBtn = screen.getByTitle('Cerrar terminal')
    fireEvent.click(closeBtn)

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
