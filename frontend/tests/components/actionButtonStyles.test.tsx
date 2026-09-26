import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { VolumesView } from '../../src/components/volumes/VolumesView'
import { NetworksView } from '../../src/components/networks/NetworksView'
import { ImagesView } from '../../src/components/images/ImagesView'
import { Navbar } from '../../src/components/layout/Navbar'
import { ThemeProvider } from '../../src/components/layout/ThemeProvider'

/**
 * Los botones de accion repetidos tienen que verse igual en todas las vistas.
 *
 * Se comparan los atributos directamente porque son la unica fuente de la
 * verdad del estilo: es un requisito puramente visual, y una coincidencia
 * parcial (mismo color, distinto radio o sin la sombra) se cuela sin que nada
 * lo note hasta que alguien lo ve.
 */

/** Limpiar sin uso: accion destructiva, estilo ambar. */
const LIMPIAR = /^Limpiar no /i
/** Accion principal: estilo azul con sombra. */
const PRINCIPAL = /Nuevo Contenedor|Descargar imagen|Nueva Red/i

function stub() {
  return vi.fn(async (url: string) => {
    const ruta = String(url).replace('/api/v1', '').split('?')[0]
    const json = async (d: unknown) => ({ ok: true, status: 200, json: async () => d })

    if (ruta === '/volumes/prune') return json({ count: 2, bytes: 53747987 })
    if (ruta === '/volumes') {
      return json([
        {
          name: 'datos-app', driver: 'local', scope: 'local', created_at: '2026-09-20T10:00:00-03:00',
          mountpoint: '/m', size: 104857600, ref_count: 0, is_anonymous: false, labels: {},
        },
      ])
    }
    if (ruta === '/networks') {
      return json([
        {
          id: 'n1', name: 'huerfana', driver: 'bridge', scope: 'local', internal: false,
          attachable: false, enable_ipv6: false, created: '2026-08-15T18:20:00-03:00',
          subnets: [], container_count: 0, is_builtin: false,
        },
      ])
    }
    if (ruta === '/images/local') {
      return json([
        {
          id: 'sha256:img1', tags: ['nginx:alpine'], size: 25000000,
          created: 1727290000, containers: 0, repo_digests: [],
        },
      ])
    }
    return json([])
  })
}

const clases = (name: RegExp) => screen.getByRole('button', { name }).className
// En un SVG, `className` es un SVGAnimatedString y no una cadena: hay que leer
// el atributo para poder compararlo.
/** Nombres de las filas visibles: el nombre accesible de una fila incluye el driver. */
const nombresVisibles = (): string[] =>
  screen
    .queryAllByRole('button')
    .filter((b) => b.closest('tr') !== null && (b.textContent ?? '').trim() !== '')
    .map((b) => (b.textContent ?? '').trim())
    .sort()

const icono = (name: RegExp) =>
  screen.getByRole('button', { name }).querySelector('svg')?.getAttribute('class')

describe('estilo de los botones de accion', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    // El Navbar monta ThemeToggle, que lee el tema y consulta matchMedia
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })
    )
    localStorage.clear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('el de limpiar de redes usa las mismas clases que el de volumenes', async () => {
    vi.stubGlobal('fetch', stub())

    const { unmount } = render(<VolumesView onDeleted={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: LIMPIAR })).toBeInTheDocument())
    const referencia = clases(LIMPIAR)
    const iconoReferencia = icono(LIMPIAR)
    unmount()

    render(<NetworksView />)
    await waitFor(() => expect(screen.getByRole('button', { name: LIMPIAR })).toBeInTheDocument())

    expect(clases(LIMPIAR)).toBe(referencia)
    expect(icono(LIMPIAR)).toBe(iconoReferencia)
  })

  it('"Nueva Red" usa las mismas clases que "Nuevo Contenedor" y "Descargar imagen"', async () => {
    vi.stubGlobal('fetch', stub())

    const { unmount } = render(
      <ThemeProvider>
        <Navbar onRefresh={vi.fn()} loading={false} onOpenCreateModal={vi.fn()} />
      </ThemeProvider>
    )
    const referencia = clases(/Nuevo Contenedor/i)
    const iconoReferencia = icono(/Nuevo Contenedor/i)
    unmount()

    const segunda = render(<ImagesView onRunImage={vi.fn()} onDeleted={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Descargar imagen/ })).toBeInTheDocument())
    expect(clases(/Descargar imagen/i)).toBe(referencia)
    segunda.unmount()

    render(<NetworksView />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Nueva Red/ })).toBeInTheDocument())

    expect(clases(/Nueva Red/i)).toBe(referencia)
    expect(icono(/Nueva Red/i)).toBe(iconoReferencia)
  })

  it('el buscador de redes usa las mismas clases que los de volumenes e imagenes', async () => {
    vi.stubGlobal('fetch', stub())

    const { unmount } = render(<VolumesView onDeleted={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('Buscar volúmenes')).toBeInTheDocument())
    const referencia = screen.getByLabelText('Buscar volúmenes').className
    const iconoReferencia = document
      .getElementById('volumes-search')
      ?.parentElement?.querySelector('svg')
      ?.getAttribute('class')
    unmount()

    const segunda = render(<ImagesView onRunImage={vi.fn()} onDeleted={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('Buscar imágenes')).toBeInTheDocument())
    expect(screen.getByLabelText('Buscar imágenes').className).toBe(referencia)
    segunda.unmount()

    render(<NetworksView />)
    await waitFor(() => expect(screen.getByLabelText('Buscar redes')).toBeInTheDocument())

    expect(screen.getByLabelText('Buscar redes').className).toBe(referencia)
    expect(
      document
        .getElementById('networks-search')
        ?.parentElement?.querySelector('svg')
        ?.getAttribute('class')
    ).toBe(iconoReferencia)
  })

  it('el buscador de redes filtra de verdad, no solo se parece', async () => {
    vi.stubGlobal('fetch', stub())
    render(<NetworksView />)

    await waitFor(() => expect(nombresVisibles()).toContain('huerfana'))
    fireEvent.change(screen.getByLabelText('Buscar redes'), { target: { value: 'no-existe' } })

    await waitFor(() => expect(nombresVisibles()).toEqual([]))
    expect(screen.getByText(/No hay redes que coincidan/)).toBeInTheDocument()
  })

  it('los botones principales no se confunden con los de limpiar', async () => {
    vi.stubGlobal('fetch', stub())
    render(<NetworksView />)

    await waitFor(() => expect(screen.getByRole('button', { name: LIMPIAR })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Nueva Red/ })).toBeInTheDocument()

    // Limpiar es ambar y crear es azul: son acciones de naturaleza distinta
    expect(clases(LIMPIAR)).not.toBe(clases(/Nueva Red/i))
    expect(PRINCIPAL.test('Nueva Red')).toBe(true)
  })
})
