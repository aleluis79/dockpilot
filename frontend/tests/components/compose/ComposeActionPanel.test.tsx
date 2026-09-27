import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { ComposeActionPanel } from '../../../src/components/compose/ComposeActionPanel'
import type { ComposeMessage } from '../../../src/types/compose'

class SocketFalso {
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  enviados: string[] = []
  cerrado = false
  static ultimos: SocketFalso[] = []

  constructor() {
    SocketFalso.ultimos.push(this)
  }
  send(d: string) {
    this.enviados.push(d)
  }
  close() {
    this.cerrado = true
  }
  emitir(m: ComposeMessage) {
    this.onmessage?.({ data: JSON.stringify(m) })
  }
}

const START: ComposeMessage = {
  type: 'start',
  action: 'up',
  project: 'tienda',
  path: '/p/dc.yml',
  command: ['docker', 'compose', '-f', '/p/dc.yml', 'up', '-d', '--remove-orphans'],
}

/** Renderiza y lanza la acción `up`, que es la que usa el resto de los tests. */
function renderYArrancar() {
  render(<ComposeActionPanel project="tienda" path="/p/dc.yml" onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: /levantar/i }))
  return SocketFalso.ultimos[SocketFalso.ultimos.length - 1]
}

describe('ComposeActionPanel', () => {
  beforeEach(() => {
    SocketFalso.ultimos = []
    vi.stubGlobal('WebSocket', SocketFalso as unknown as typeof WebSocket)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('muestra la salida en el orden recibido', () => {
    const ws = renderYArrancar()

    act(() => {
      ws.emitir(START)
      ws.emitir({ type: 'output', stream: 'stdout', data: 'primera\n' })
      ws.emitir({ type: 'output', stream: 'stdout', data: 'segunda\n' })
    })

    expect(screen.getByTestId('compose-output').textContent).toBe('primera\nsegunda\n')
  })

  it('distingue stderr de stdout', () => {
    const ws = renderYArrancar()

    act(() => {
      ws.emitir(START)
      ws.emitir({ type: 'output', stream: 'stdout', data: 'ok\n' })
      ws.emitir({ type: 'output', stream: 'stderr', data: 'aviso\n' })
    })

    expect(screen.getByTestId('compose-stderr').textContent).toBe('aviso\n')
  })

  it('muestra el comando exacto que se ejecuta', () => {
    // Quien borra algo tiene que poder ver qué se ejecutó.
    const ws = renderYArrancar()

    act(() => ws.emitir(START))

    const comando = screen.getByTestId('compose-command')
    expect(comando.textContent).toContain('docker compose')
    expect(comando.textContent).toContain('--remove-orphans')
  })

  it('el botón cancelar aparece mientras corre y desaparece al terminar', () => {
    const ws = renderYArrancar()

    act(() => ws.emitir(START))
    expect(screen.getByRole('button', { name: /cancelar/i })).toBeInTheDocument()

    act(() => ws.emitir({ type: 'exit', action: 'up', code: 0, duration_ms: 100 }))
    expect(screen.queryByRole('button', { name: /cancelar/i })).not.toBeInTheDocument()
  })

  it('cancelar envía el mensaje y deja que el servidor cierre el canal', () => {
    const ws = renderYArrancar()
    act(() => ws.emitir(START))

    fireEvent.click(screen.getByRole('button', { name: /cancelar/i }))

    expect(ws.enviados.map((e) => JSON.parse(e).type)).toEqual(['cancel'])
    // El socket sigue abierto: el proceso muere en el servidor, y es él quien
    // confirma con `exit`.
    expect(ws.cerrado).toBe(false)
  })

  it('informa de la duración de la acción', () => {
    const ws = renderYArrancar()

    act(() => {
      ws.emitir(START)
      ws.emitir({ type: 'exit', action: 'up', code: 0, duration_ms: 12_400 })
    })

    expect(screen.getByTestId('compose-exit')).toHaveTextContent(/12[,.]4/)
  })

  it('un fallo de compose se presenta como fallo de compose, no del panel', () => {
    const ws = renderYArrancar()

    act(() => {
      ws.emitir(START)
      ws.emitir({ type: 'output', stream: 'stderr', data: 'port is already allocated\n' })
      ws.emitir({ type: 'exit', action: 'up', code: 1, duration_ms: 300 })
    })

    const salida = screen.getByTestId('compose-exit')
    expect(salida).toHaveTextContent(/compose/i)
    expect(salida).toHaveTextContent(/1/)
    // No es un aviso de "el panel falló".
    expect(screen.queryByTestId('compose-error')).not.toBeInTheDocument()
  })

  it('un error del servidor se muestra como error', () => {
    const ws = renderYArrancar()

    act(() =>
      ws.emitir({
        type: 'error',
        code: 409,
        message: 'El proyecto tiene contenedores en marcha',
      })
    )

    expect(screen.getByTestId('compose-error')).toHaveTextContent(/en marcha/)
  })

  it('no ofrece build', () => {
    // `build` queda fuera de la spec a propósito: es el flujo más largo y el que
    // más falla.
    render(<ComposeActionPanel project="tienda" path="/p/dc.yml" onClose={vi.fn()} />)

    expect(screen.queryByRole('button', { name: /construir|build/i })).not.toBeInTheDocument()
  })
})
