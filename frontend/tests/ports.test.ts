import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { wsUrl } from '../src/services/wsUrl'

/**
 * Guarda contra la desincronizacion de puertos.
 *
 * Un puerto equivocado aqui no da ningun error visible: el proxy de Vite
 * seguiria funcionando, la app arrancaria igual y el fallo solo apareceria al
 * abrir `/docs` o al servir el build de produccion. Por eso se comprueba por
 * lectura de los ficheros, y no en tiempo de ejecucion.
 */

// Raiz del repositorio: este test vive en frontend/ pero vigila el Makefile
// y el config del backend, que son los otros dos sitios donde se declaran.
const raiz = resolve(__dirname, '../..')
const leer = (...partes: string[]) => readFileSync(resolve(raiz, ...partes), 'utf-8')

const PUERTO_BACKEND = 8181
const PUERTO_FRONTEND = 8182

describe('puertos', () => {
  it('el Makefile declara los puertos acordados', () => {
    const makefile = leer('Makefile')
    expect(makefile).toMatch(new RegExp(`PORT_BACKEND\\s*:=?\\s*${PUERTO_BACKEND}\\b`))
    expect(makefile).toMatch(new RegExp(`PORT_FRONTEND\\s*:=?\\s*${PUERTO_FRONTEND}\\b`))
  })

  it('el Makefile no deja puertos viejos pululando', () => {
    const makefile = leer('Makefile')
    expect(makefile).not.toMatch(/PORT_BACKEND\s*:=?\s*8000\b/)
    expect(makefile).not.toMatch(/PORT_FRONTEND\s*:=?\s*5173\b/)
  })

  it('Vite sirve en el puerto del frontend y proxea al del backend', () => {
    const vite = leer('frontend', 'vite.config.ts')

    expect(vite).toMatch(new RegExp(`port:\\s*${PUERTO_FRONTEND}\\b`))
    expect(vite).toContain(`http://127.0.0.1:${PUERTO_BACKEND}`)
    expect(vite).toContain(`ws://127.0.0.1:${PUERTO_BACKEND}`)
  })

  it('el CORS del backend deriva del mismo puerto que el frontend', () => {
    const config = leer('backend', 'app', 'core', 'config.py')
    expect(config).toMatch(new RegExp(`FRONTEND_PORT:\\s*int\\s*=\\s*${PUERTO_FRONTEND}\\b`))
  })

  it('ningún fichero de src declara un puerto del backend', () => {
    // El host de los WebSocket se deriva de window.location; si aparece un
    // puerto literal aqui, es que alguien reintrodujo el acoplamiento.
    const hook = leer('frontend', 'src', 'hooks', 'useDockerLogs.ts')
    const stats = leer('frontend', 'src', 'hooks', 'useDockerStats.ts')
    const pull = leer('frontend', 'src', 'hooks', 'useImagePull.ts')
    const api = leer('frontend', 'src', 'services', 'dockerApi.ts')

    for (const contenido of [hook, stats, pull, api]) {
      expect(contenido).not.toMatch(/127\.0\.0\.1:\d{4}/)
      expect(contenido).not.toMatch(/localhost:\d{4}/)
    }
  })

  it('wsUrl se deriva de la página, sin host de reserva', () => {
    // jsdom sirve la pagina en localhost; el helper debe usar ese host
    expect(wsUrl('/ws/x')).toMatch(/^ws:\/\/[^/]+\/ws\/x$/)
    expect(wsUrl('/ws/x')).toContain(window.location.host)
  })

  it('wsUrl usa wss cuando la página es https', () => {
    // `location.protocol` no es redefinible en esta version de jsdom, asi que
    // se sustituye el objeto entero. En jsdom `window === globalThis`, de modo
    // que el helper lee el stub.
    vi.stubGlobal('location', { protocol: 'https:', host: 'dockpilot.local' })
    try {
      expect(wsUrl('/ws/x')).toBe('wss://dockpilot.local/ws/x')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

  it('el guardián de puertos del Makefile usa el prefijo TCP:', () => {
    // Sin `TCP:`, lsof interpreta "8181" como nombre de protocolo, falla y
    // devuelve vacío: el aviso de "puerto ocupado" no se dispara nunca.
    const makefile = leer('Makefile')
    // Con el espacio incluido: `[^\s]*` a secas solo capturaria `lsof -ti`
    const consultas = makefile.match(/lsof -ti TCP:[^\s]*/g) ?? []
    expect(consultas.length).toBeGreaterThan(0)
    for (const consulta of consultas) {
      expect(consulta).toMatch(/^lsof -ti TCP:/)
    }
  })

  it('Vite no se desliza a otro puerto si el suyo está ocupado', () => {
    // Sin strictPort, Vite se mueve al siguiente libre y la app se sirve en una
    // URL que nadie ha documentado, sin decir nada.
    const vite = leer('frontend', 'vite.config.ts')
    expect(vite).toMatch(/strictPort:\s*true/)
  })

  it('make up no afirma haber arrancado sin comprobar el puerto', () => {
    const makefile = leer('Makefile')
    const up = makefile.slice(makefile.indexOf('\nup:'), makefile.indexOf('\ndown:'))
    expect(up).toContain('lsof -ti TCP:$(PORT_BACKEND)')
    expect(up).toContain('lsof -ti TCP:$(PORT_FRONTEND)')
    expect(up).toMatch(/ERROR: algun servicio no pudo tomar su puerto/)
  })
