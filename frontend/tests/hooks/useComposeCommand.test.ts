import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useComposeCommand } from '../../src/hooks/useComposeCommand'
import type { ComposeMessage } from '../../src/types/compose'

class SocketFalso {
  // Los valores y las constantes de la API real: el hook compara `readyState`
  // contra `WebSocket.CLOSED`, y un doble sin ellos no ejercita esa guarda.
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  static ultimaUrl: string | null = null
  static ultimoPayload: string | null = null
  static abiertos: SocketFalso[] = []

  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  enviados: string[] = []
  readyState: number = SocketFalso.CONNECTING

  constructor(url: string) {
    SocketFalso.ultimaUrl = url
    SocketFalso.abiertos.push(this)
    // Al abrirse, el socket pasa a OPEN sin que haya que hacerlo a mano.
    this.readyState = SocketFalso.OPEN
  }

  get cerrado() {
    return this.readyState === SocketFalso.CLOSED
  }

  send(data: string) {
    this.enviados.push(data)
    SocketFalso.ultimoPayload = data
  }

  close() {
    this.readyState = SocketFalso.CLOSED
  }

  /** Simula que el servidor manda un mensaje. */
  emitir(mensaje: ComposeMessage) {
    this.onmessage?.({ data: JSON.stringify(mensaje) })
  }

  /** El navegador dispara `error` al abortar un handshake en curso. */
  fallar() {
    this.onerror?.()
  }

  get abierto() {
    return !this.cerrado
  }
}

function instalar() {
  SocketFalso.ultimaUrl = null
  SocketFalso.ultimoPayload = null
  SocketFalso.abiertos = []
  vi.stubGlobal('WebSocket', SocketFalso as unknown as typeof WebSocket)
  return SocketFalso
}

const START: ComposeMessage = {
  type: 'start',
  action: 'up',
  project: 'tienda',
  path: '/p/dc.yml',
  command: ['docker', 'compose', '-f', '/p/dc.yml', 'up', '-d'],
}

describe('useComposeCommand', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.restoreAllMocks())

  it('construye la URL con la acción y los parámetros', () => {
    const WS = instalar()
    const { result } = renderHook(() => useComposeCommand())

    act(() => {
      result.current.ejecutar({
        action: 'logs',
        path: '/p/dc.yml',
        project_name: 'tienda',
        service: 'web',
        follow: true,
      })
    })

    const url = WS.ultimaUrl!
    expect(url).toContain('/ws/compose/logs')
    expect(url).toContain('path=%2Fp%2Fdc.yml')
    expect(url).toContain('project_name=tienda')
    // El servicio viaja como parámetro, pero el backend lo pasa POSICIONAL a
    // compose, que no tiene `--service`.
    expect(url).toContain('service=web')
    expect(url).toContain('follow=true')
  })

  it('recoge la salida en orden', () => {
    const WS = instalar()
    const { result } = renderHook(() => useComposeCommand())

    act(() => {
      result.current.ejecutar({ action: 'up', path: '/p/dc.yml' })
    })
    const ws = WS.abiertos[0]

    act(() => {
      ws.emitir(START)
      ws.emitir({ type: 'output', stream: 'stdout', data: 'uno\n' })
      ws.emitir({ type: 'output', stream: 'stderr', data: 'aviso\n' })
    })

    expect(result.current.output.map((l) => l.data)).toEqual(['uno\n', 'aviso\n'])
    expect(result.current.command).toEqual(START.command)
  })

  it('marca la acción como en curso hasta el exit', () => {
    const WS = instalar()
    const { result } = renderHook(() => useComposeCommand())

    act(() => result.current.ejecutar({ action: 'up', path: '/p/dc.yml' }))
    const ws = WS.abiertos[0]

    act(() => ws.emitir(START))
    expect(result.current.enCurso).toBe(true)

    act(() =>
      ws.emitir({ type: 'exit', action: 'up', code: 0, duration_ms: 1200 })
    )
    expect(result.current.enCurso).toBe(false)
    expect(result.current.duracionMs).toBe(1200)
  })

  it('trata un fallo de compose como salida, no como error del panel', () => {
    // Un `up` que falla por un puerto ocupado NO es un error de DockPilot: el
    // proceso se ejecutó bien, fue compose el que no tuvo éxito.
    const WS = instalar()
    const { result } = renderHook(() => useComposeCommand())

    act(() => result.current.ejecutar({ action: 'up', path: '/p/dc.yml' }))
    const ws = WS.abiertos[0]
    act(() => {
      ws.emitir(START)
      ws.emitir({ type: 'output', stream: 'stderr', data: 'port is already allocated\n' })
      ws.emitir({ type: 'exit', action: 'up', code: 1, duration_ms: 300 })
    })

    expect(result.current.error).toBeNull()
    expect(result.current.exitCode).toBe(1)
  })

  it('guarda el mensaje de error del servidor', () => {
    const WS = instalar()
    const { result } = renderHook(() => useComposeCommand())

    act(() => result.current.ejecutar({ action: 'up', path: '/p/dc.yml' }))
    act(() =>
      WS.abiertos[0].emitir({
        type: 'error',
        code: 409,
        message: 'El proyecto tiene contenedores en marcha',
      })
    )

    expect(result.current.error).toMatch(/en marcha/)
    expect(result.current.enCurso).toBe(false)
  })

  it('envía cancel y espera a que el servidor confirme con exit', () => {
    const WS = instalar()
    const { result } = renderHook(() => useComposeCommand())

    act(() => result.current.ejecutar({ action: 'up', path: '/p/dc.yml' }))
    const ws = WS.abiertos[0]
    act(() => ws.emitir(START))

    act(() => result.current.cancelar())
    // Cancelar es enviar `cancel` y esperar: el proceso muere en el servidor.
    expect(ws.enviados.map((e) => JSON.parse(e).type)).toEqual(['cancel'])
    expect(result.current.enCurso).toBe(true)

    act(() =>
      ws.emitir({ type: 'exit', action: 'up', code: -1, duration_ms: 50 })
    )
    expect(result.current.enCurso).toBe(false)
  })

  it('no hace nada al cancelar si no hay ninguna acción en curso', () => {
    const WS = instalar()
    const { result } = renderHook(() => useComposeCommand())

    act(() => result.current.cancelar())

    expect(WS.abiertos).toHaveLength(0)
  })

  it('cierra el socket anterior al empezar otra acción', () => {
    const WS = instalar()
    const { result } = renderHook(() => useComposeCommand())

    act(() => result.current.ejecutar({ action: 'up', path: '/p/dc.yml' }))
    const primero = WS.abiertos[0]
    act(() => primero.emitir(START))

    act(() => result.current.ejecutar({ action: 'stop', path: '/p/dc.yml' }))

    // Sin esto el socket viejo seguiría emitiendo y las salidas se mezclarían.
    expect(primero.cerrado).toBe(true)
    expect(WS.abiertos).toHaveLength(2)
  })

  it('ignora el error de un socket que ya no es el actual', () => {
    // Regresión: al cerrar un socket a medio conectar —que es lo que pasa al
    // desmontar y montar, como hace StrictMode en desarrollo— el navegador
    // dispara `error`. Sin esta guarda, un desmontaje normal se veía como
    // "no se pudo abrir el canal" mientras los logs llegaban igual.
    const WS = instalar()
    const { result } = renderHook(() => useComposeCommand())

    act(() => result.current.ejecutar({ action: 'logs', path: '/p/dc.yml' }))
    const primero = WS.abiertos[0]
    act(() => result.current.ejecutar({ action: 'up', path: '/p/dc.yml' }))

    act(() => primero.fallar())

    expect(result.current.error).toBeNull()
    expect(result.current.enCurso).toBe(true)
  })

  it('ignora la salida de un socket superseded, no la mezcla con la nueva', () => {
    const WS = instalar()
    const { result } = renderHook(() => useComposeCommand())

    act(() => result.current.ejecutar({ action: 'up', path: '/p/dc.yml' }))
    const primero = WS.abiertos[0]
    act(() => result.current.ejecutar({ action: 'stop', path: '/p/dc.yml' }))

    act(() => primero.emitir({ type: 'output', stream: 'stdout', data: 'vieja\n' }))

    expect(result.current.output).toEqual([])
  })

  it('sí informa del error del socket que está en curso', () => {
    // La guarda no puede tragarse los errores de verdad: si el socket actual
    // falla, el usuario tiene que enterarse.
    const WS = instalar()
    const { result } = renderHook(() => useComposeCommand())

    act(() => result.current.ejecutar({ action: 'up', path: '/p/dc.yml' }))
    act(() => WS.abiertos[0].fallar())

    expect(result.current.error).toMatch(/canal/i)
    expect(result.current.enCurso).toBe(false)
  })

  it('no reporta error cuando el socket se sustituye a sí mismo', () => {
    // La secuencia real: el componente abre el socket desde un efecto, StrictMode
    // desmonta y vuelve a montar, y el socket del primer montaje se aborta a
    // medio conectar. Ese `error` pertenece a un socket muerto.
    const WS = instalar()
    const { result } = renderHook(() => useComposeCommand())

    act(() => result.current.ejecutar({ action: 'logs', path: '/p/dc.yml' }))
    const primero = WS.abiertos[0]

    act(() => result.current.ejecutar({ action: 'logs', path: '/p/dc.yml' }))
    act(() => primero.fallar())

    expect(result.current.error).toBeNull()
  })

  it('limpia la salida al empezar una acción nueva', () => {
    const WS = instalar()
    const { result } = renderHook(() => useComposeCommand())

    act(() => result.current.ejecutar({ action: 'up', path: '/p/dc.yml' }))
    act(() => WS.abiertos[0].emitir({ type: 'output', stream: 'stdout', data: 'vieja\n' }))
    expect(result.current.output).toHaveLength(1)

    act(() => result.current.ejecutar({ action: 'up', path: '/p/dc.yml' }))
    expect(result.current.output).toEqual([])
  })

  it('pide refrescar el inventario al terminar up o down con éxito', () => {
    // El inventario de SPEC-11 queda obsoleto en cuanto cambia el estado del
    // proyecto, así que el backend avisa y el frontend recarga.
    const onRefrescar = vi.fn()
    const WS = instalar()
    const { result } = renderHook(() => useComposeCommand({ onRefrescar }))

    act(() => result.current.ejecutar({ action: 'up', path: '/p/dc.yml' }))
    act(() => {
      WS.abiertos[0].emitir(START)
      WS.abiertos[0].emitir({ type: 'exit', action: 'up', code: 0, duration_ms: 10 })
    })

    expect(onRefrescar).toHaveBeenCalled()
  })

  it('no refresca al terminar logs', async () => {
    // Un `logs` que acaba no invalida nada: el inventario sigue igual.
    const onRefrescar = vi.fn()
    const WS = instalar()
    const { result } = renderHook(() => useComposeCommand({ onRefrescar }))

    act(() => result.current.ejecutar({ action: 'logs', path: '/p/dc.yml' }))
    act(() => {
      WS.abiertos[0].emitir({ ...START, action: 'logs' })
      WS.abiertos[0].emitir({ type: 'exit', action: 'logs', code: 0, duration_ms: 10 })
    })

    await waitFor(() => expect(result.current.enCurso).toBe(false))
    expect(onRefrescar).not.toHaveBeenCalled()
  })

  it('no refresca si la acción falló', () => {
    const onRefrescar = vi.fn()
    const WS = instalar()
    const { result } = renderHook(() => useComposeCommand({ onRefrescar }))

    act(() => result.current.ejecutar({ action: 'down', path: '/p/dc.yml' }))
    act(() => {
      WS.abiertos[0].emitir({ ...START, action: 'down' })
      WS.abiertos[0].emitir({ type: 'exit', action: 'down', code: 1, duration_ms: 10 })
    })

    expect(onRefrescar).not.toHaveBeenCalled()
  })

  it('marca cancelado cuando el exit trae el código del servidor', () => {
    const WS = instalar()
    const { result } = renderHook(() => useComposeCommand())

    act(() => result.current.ejecutar({ action: 'up', path: '/p/dc.yml' }))
    act(() => {
      WS.abiertos[0].emitir(START)
      result.current.cancelar()
      WS.abiertos[0].emitir({ type: 'exit', action: 'up', code: -1, duration_ms: 5 })
    })

    // El proceso recibió SIGKILL y no tiene código real: el servidor manda -1.
    expect(result.current.cancelado).toBe(true)
  })

  it('cierra el socket al desmontar', () => {
    // Si el socket quedara vivo, el `docker compose` del backend seguiría
    // ejecutándose sin que nadie lo escuchara.
    const WS = instalar()
    const { result, unmount } = renderHook(() => useComposeCommand())

    act(() => result.current.ejecutar({ action: 'up', path: '/p/dc.yml' }))
    const ws = WS.abiertos[0]
    expect(ws.cerrado).toBe(false)

    unmount()
    expect(ws.cerrado).toBe(true)
  })
})
