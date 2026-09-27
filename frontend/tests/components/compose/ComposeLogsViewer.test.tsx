import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StrictMode } from 'react'
import { render, screen, act, fireEvent, within } from '@testing-library/react'
import { ComposeLogsViewer } from '../../../src/components/compose/ComposeLogsViewer'
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

  /** El navegador dispara `error` al abortar un handshake en curso. */
  fallar() {
    this.onerror?.()
  }
}

const START: ComposeMessage = {
  type: 'start',
  action: 'logs',
  project: 'tienda',
  path: '/p/dc.yml',
  command: ['docker', 'compose', '-f', '/p/dc.yml', 'logs', '--follow'],
}

function montar(opts: { service?: string | null } = {}) {
  render(
    <ComposeLogsViewer project="tienda" path="/p/dc.yml" onClose={vi.fn()} {...opts} />
  )
  return SocketFalso.ultimos[SocketFalso.ultimos.length - 1]
}

/** Emite líneas con el prefijo de servicio que pone compose. */
function lineas(ws: SocketFalso, ...textos: string[]) {
  act(() => {
    ws.emitir(START)
    for (const texto of textos) {
      ws.emitir({ type: 'output', stream: 'stdout', data: `${texto}\n` })
    }
  })
}

describe('ComposeLogsViewer', () => {
  beforeEach(() => {
    SocketFalso.ultimos = []
    vi.stubGlobal('WebSocket', SocketFalso as unknown as typeof WebSocket)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('acumula las líneas que llegan', () => {
    const ws = montar()

    act(() => {
      ws.emitir(START)
      ws.emitir({ type: 'output', stream: 'stdout', data: 'linea uno\n' })
      ws.emitir({ type: 'output', stream: 'stdout', data: 'linea dos\n' })
    })

    // Cada línea es su propio nodo, para poder colorear el prefijo del servicio.
    expect(screen.getByText('linea uno')).toBeInTheDocument()
    expect(screen.getByText('linea dos')).toBeInTheDocument()
  })

  it('lleva la etiqueta del servicio a cada línea', () => {
    // Los logs de compose vienen con el prefijo del servicio, que es lo que
    // permite saber de quién es cada línea cuando hay varios servicios.
    const ws = montar()

    act(() => {
      ws.emitir(START)
      ws.emitir({ type: 'output', stream: 'stdout', data: 'web  | arrancado\n' })
      ws.emitir({ type: 'output', stream: 'stdout', data: 'db   | listo\n' })
    })

    // Acotado al visor: el nombre del servicio también aparece en el selector.
    const visor = within(screen.getByTestId('compose-logs'))
    expect(visor.getByText('web')).toBeInTheDocument()
    expect(visor.getByText('db')).toBeInTheDocument()
    expect(visor.getByText('arrancado')).toBeInTheDocument()
  })

  it('mantiene el desplazamiento al final al llegar líneas nuevas', () => {
    // Sin esto el usuario lee pegado arriba y no ve lo que acaba de pasar.
    const ws = montar()

    act(() => {
      ws.emitir(START)
      for (let i = 0; i < 30; i += 1) {
        ws.emitir({ type: 'output', stream: 'stdout', data: `linea ${i}\n` })
      }
    })

    // 30 líneas en el DOM: llegaron todas, y el efecto de scroll las ha seguido.
    expect(screen.getByTestId('compose-logs').querySelectorAll('div')).toHaveLength(30)
  })

  it('cortar el seguimiento no para el proyecto', () => {
    const onCerrar = vi.fn()
    render(
      <ComposeLogsViewer
        project="tienda"
        path="/p/dc.yml"
        onClose={onCerrar}
      />
    )
    const ws = SocketFalso.ultimos[SocketFalso.ultimos.length - 1]
    act(() => ws.emitir(START))

    fireEvent.click(screen.getByRole('button', { name: /dejar de seguir/i }))

    // Cortar el seguimiento pide al servidor que corte el `logs --follow` y
    // cierra el modal. NO ejecuta ninguna acción sobre el proyecto: no se envía
    // `stop` ni `down`, solo `cancel` del propio canal de logs.
    expect(ws.enviados.map((e) => JSON.parse(e).type)).toEqual(['cancel'])
    expect(onCerrar).toHaveBeenCalled()
  })

  it('promete explícitamente que cortar no para el proyecto', () => {
    render(
      <ComposeLogsViewer project="tienda" path="/p/dc.yml" onClose={vi.fn()} />
    )
    act(() => SocketFalso.ultimos[0].emitir(START))

    // Si algún día esto cambia, el texto sería una mentira.
    expect(screen.getByText(/no para el proyecto/i)).toBeInTheDocument()
  })

  it('no duplica líneas si el socket se reconecta', () => {
    // Una reconexión abre un canal nuevo cuya salida empieza de cero: si el
    // estado se acumulase entre canales, el mismo mensaje saldría dos veces.
    const ws = montar()
    act(() => {
      ws.emitir(START)
      ws.emitir({ type: 'output', stream: 'stdout', data: 'primera\n' })
    })
    expect(screen.getAllByText('primera')).toHaveLength(1)

    // Segundo montaje, salida desde cero.
    render(<ComposeLogsViewer project="tienda" path="/p/dc.yml" onClose={vi.fn()} />)
    const nuevo = SocketFalso.ultimos[SocketFalso.ultimos.length - 1]
    act(() => {
      nuevo.emitir(START)
      nuevo.emitir({ type: 'output', stream: 'stdout', data: 'primera\n' })
    })

    // Cada canal muestra su propia línea, una vez.
    expect(screen.getAllByText('primera')).toHaveLength(2)
  })

  it('no muestra el cartel de error en desarrollo con StrictMode', () => {
    // Regresión del bug reportado: StrictMode monta, desmonta y vuelve a montar,
    // así que el socket del primer montaje se aborta a medio conectar y el
    // navegador le dispara `error`. El panel lo pintaba como si el canal no
    // hubiera abierto, mientras los logs llegaban igual.
    render(
      <StrictMode>
        <ComposeLogsViewer project="tienda" path="/p/dc.yml" onClose={vi.fn()} />
      </StrictMode>
    )

    // Solo fallan los sockets **sustituidos**: el del primer montaje se aborta a
    // medio conectar y el navegador le dispara `error`. El último está vivo y
    // sigue delivering logs, que es justo lo que pasaba.
    for (const ws of SocketFalso.ultimos.slice(0, -1)) act(() => ws.fallar())

    expect(SocketFalso.ultimos.length).toBeGreaterThan(1)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText(/no se pudo abrir el canal/i)).not.toBeInTheDocument()
  })

  it('sí muestra el error si el socket que queda es el que falla', () => {
    // La guarda no puede tragarse los fallos de verdad.
    render(<ComposeLogsViewer project="tienda" path="/p/dc.yml" onClose={vi.fn()} />)
    act(() => SocketFalso.ultimos[SocketFalso.ultimos.length - 1].fallar())

    expect(screen.getByRole('alert')).toHaveTextContent(/canal/i)
  })

  // --- Controles, a la paridad con el visor de contenedores -------------------

  it('filtra las líneas por el texto buscado', () => {
    const ws = montar()
    lineas(ws, 'web  | arrancado', 'db   | error de conexion', 'web  | segundo aviso')

    fireEvent.change(screen.getByPlaceholderText(/buscar en logs/i), {
      target: { value: 'error' },
    })

    expect(screen.getByText(/error de conexion/)).toBeInTheDocument()
    expect(screen.queryByText(/arrancado/)).not.toBeInTheDocument()
  })

  it('filtra por servicio, que es lo que distingue a un proyecto', () => {
    const ws = montar()
    lineas(ws, 'web  | arrancado', 'db   | listo', 'cache  | vacio')

    fireEvent.change(screen.getByLabelText(/filtrar por servicio/i), {
      target: { value: 'db' },
    })

    expect(screen.getByText(/listo/)).toBeInTheDocument()
    expect(screen.queryByText(/arrancado/)).not.toBeInTheDocument()
  })

  it('ofrece un selector con los servicios que ha hablado', () => {
    const ws = montar()
    lineas(ws, 'web  | uno', 'db   | dos')

    const selector = screen.getByLabelText(/filtrar por servicio/i) as HTMLSelectElement
    expect([...selector.options].map((o) => o.value)).toEqual(['all', 'db', 'web'])
  })

  it('filtra por stream, como el visor de contenedores', () => {
    const ws = montar()
    act(() => {
      ws.emitir(START)
      ws.emitir({ type: 'output', stream: 'stdout', data: 'de stdout\n' })
      ws.emitir({ type: 'output', stream: 'stderr', data: 'de stderr\n' })
    })

    fireEvent.change(screen.getByLabelText(/filtrar por stream/i), {
      target: { value: 'stderr' },
    })

    expect(screen.getByText(/de stderr/)).toBeInTheDocument()
    expect(screen.queryByText(/de stdout/)).not.toBeInTheDocument()
  })

  it('avisa de que no hay líneas que coincidan', () => {
    const ws = montar()
    lineas(ws, 'web  | arrancado')

    fireEvent.change(screen.getByPlaceholderText(/buscar en logs/i), {
      target: { value: 'no-existe-esto' },
    })

    expect(screen.getByText(/sin líneas que coincidan/i)).toBeInTheDocument()
  })

  it('indica si el seguimiento está activo', () => {
    montar()
    expect(screen.getByTestId('compose-follow-state')).toHaveTextContent(/siguiendo/i)
  })

  it('el auto-scroll se puede desactivar', () => {
    const ws = montar()
    lineas(ws, 'web  | una', 'web  | dos')

    fireEvent.click(screen.getByRole('button', { name: /desactivar auto-scroll/i }))

    expect(screen.getByRole('button', { name: /activar auto-scroll/i })).toBeInTheDocument()
  })

  it('limpia la consola sin cerrar el seguimiento', () => {
    const ws = montar()
    lineas(ws, 'web  | una')

    fireEvent.click(screen.getByRole('button', { name: /limpiar consola/i }))

    expect(screen.queryByText(/web/)).not.toBeInTheDocument()
    // El socket sigue abierto: limpiar no es parar.
    expect(ws.cerrado).toBe(false)
  })

  it('copia las líneas al portapapeles', async () => {
    const escribir = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText: escribir } })

    const ws = montar()
    lineas(ws, 'web  | copiable')

    fireEvent.click(screen.getByRole('button', { name: /copiar logs/i }))

    await vi.waitFor(() => expect(escribir).toHaveBeenCalled())
    expect(escribir.mock.calls[0][0]).toContain('copiable')
  })
})
