import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LogsViewer } from '../../src/components/logs/LogsViewer'
import type { LogEntry } from '../../src/types/log'

const mockLogs: LogEntry[] = [
  { timestamp: '2026-09-25T12:00:00Z', stream: 'stdout', message: 'Iniciando servidor web' },
  { timestamp: '2026-09-25T12:00:01Z', stream: 'stderr', message: 'Error de conexión a la base de datos' },
  { timestamp: null, stream: 'system', message: '--- Conexión establecida ---' },
]

describe('LogsViewer', () => {
  it('renders log lines with timestamps and messages', () => {
    render(
      <LogsViewer
        logs={mockLogs}
        connected={true}
        containerName="web-nginx"
        onClear={vi.fn()}
      />
    )

    expect(screen.getByText('Iniciando servidor web')).toBeInTheDocument()
    expect(screen.getByText('Error de conexión a la base de datos')).toBeInTheDocument()
    expect(screen.getByText('--- Conexión establecida ---')).toBeInTheDocument()
  })

  it('filters logs according to search input', () => {
    render(
      <LogsViewer
        logs={mockLogs}
        connected={true}
        containerName="web-nginx"
        onClear={vi.fn()}
      />
    )

    const searchInput = screen.getByPlaceholderText('Buscar en logs...')
    fireEvent.change(searchInput, { target: { value: 'Error' } })

    expect(screen.getByText('Error de conexión a la base de datos')).toBeInTheDocument()
    expect(screen.queryByText('Iniciando servidor web')).not.toBeInTheDocument()
  })

  it('calls onClear callback when clicking clear button', () => {
    const handleClear = vi.fn()
    render(
      <LogsViewer
        logs={mockLogs}
        connected={true}
        containerName="web-nginx"
        onClear={handleClear}
      />
    )

    const clearButton = screen.getByTitle('Limpiar consola de logs')
    fireEvent.click(clearButton)

    expect(handleClear).toHaveBeenCalledTimes(1)
  })

  it('toggles auto-scroll mode', () => {
    render(
      <LogsViewer
        logs={mockLogs}
        connected={true}
        containerName="web-nginx"
        onClear={vi.fn()}
      />
    )

    const scrollButton = screen.getByTitle('Desactivar auto-scroll')
    expect(scrollButton).toBeInTheDocument()

    fireEvent.click(scrollButton)
    expect(screen.getByTitle('Activar auto-scroll')).toBeInTheDocument()
  })
})
