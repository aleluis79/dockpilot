import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { HelpModal } from '../../src/components/help/HelpModal'
import { VISTAS } from '../../src/vistas'

/**
 * El manual se navega por secciones, no se lee de un tirón: solo está montada
 * la sección activa. Por eso los tests saltan a la que les interesa en vez de
 * buscar contenido suelto por todo el diálogo.
 */
const irA = (nombre: RegExp) => fireEvent.click(screen.getByRole('button', { name: nombre }))

const dialogo = () => screen.getByRole('dialog')
const contenido = () => within(dialogo())

describe('HelpModal', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.restoreAllMocks())

  it('es un diálogo modal accesible', () => {
    render(<HelpModal open onClose={vi.fn()} />)

    expect(dialogo()).toHaveAttribute('aria-modal', 'true')
    expect(dialogo()).toHaveAttribute('aria-label')
  })

  it('no se pinta si está cerrado', () => {
    render(<HelpModal open={false} onClose={vi.fn()} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('abre en la sección General', () => {
    render(<HelpModal open onClose={vi.fn()} />)
    expect(contenido().getByRole('heading', { name: 'General' })).toBeInTheDocument()
  })

  it('avisa de que la app no tiene autenticación', () => {
    // Es la advertencia más importante del manual: sin auth, exponer el panel
    // es dar control del host a cualquiera que llegue al puerto.
    render(<HelpModal open onClose={vi.fn()} />)

    expect(contenido().getByText(/no tiene autenticación/i)).toBeInTheDocument()
    expect(contenido().getByText(/127\.0\.0\.1/)).toBeInTheDocument()
    expect(contenido().getByRole('note')).toBeInTheDocument()
  })

  it('documenta la franja de resumen del host', () => {
    render(<HelpModal open onClose={vi.fn()} />)
    expect(contenido().getByText(/Resumen del host/i)).toBeInTheDocument()
  })

  it('documenta todas las pestañas del panel', () => {
    // Regresión: la ayuda decía "cuatro pestañas" después de que existieran
    // cinco. Ahora recorre la lista real, así que añadir una pestaña sin
    // documentarla rompe este test.
    render(<HelpModal open onClose={vi.fn()} />)
    irA(/pestañas/i)

    for (const vista of VISTAS) {
      expect(
        contenido().getByRole('heading', { name: new RegExp(`^${vista.label}$`) })
      ).toBeInTheDocument()
    }
  })

  it('cuenta las pestañas que documenta', () => {
    // El texto suelto ("cinco pestañas") es donde se desfasó la ayuda: si el
    // número no cuadra con la lista real, el test lo delata.
    render(<HelpModal open onClose={vi.fn()} />)
    irA(/pestañas/i)

    const enPalabras = ['una', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete']
    const dicho = enPalabras.find((n) => contenido().queryByText(new RegExp(`${n} pestañas`)))

    expect(dicho).toBeDefined()
    expect(enPalabras.indexOf(dicho as string) + 1).toBe(VISTAS.length)
  })

  it('documenta la pestaña de proyectos y lo que se puede hacer en ella', () => {
    render(<HelpModal open onClose={vi.fn()} />)
    irA(/pestañas/i)

    expect(contenido().getByText(/Huerfano/i)).toBeInTheDocument()
    expect(contenido().getByText(/no ejecuta nada/i)).toBeInTheDocument()
  })

  it('documenta que bajar un proyecto con volúmenes es la acción más destructiva', () => {
    render(<HelpModal open onClose={vi.fn()} />)
    irA(/irreversibles/i)

    expect(contenido().getByText(/dos confirmaciones/i)).toBeInTheDocument()
    expect(
      contenido().getByText(/acción más destructiva del panel/i)
    ).toBeInTheDocument()
  })

  it('explica que el detalle del host es una foto, no un histórico', () => {
    render(<HelpModal open onClose={vi.fn()} />)
    irA(/pestañas/i)

    // Sin esto, alguien esperará curvas de CPU y de memoria y le sorprenderá que no
    // aparezcan: no hay histórico porque el backend no guarda muestras.
    expect(contenido().getByText(/fotos del momento/i)).toBeInTheDocument()
  })

  it('documenta que se puede elegir el archivo sin copiar la ruta', () => {
    render(<HelpModal open onClose={vi.fn()} />)
    irA(/pestañas/i)

    // El explorador es la respuesta a "tengo que teclear la ruta", que era el
    // complaint real: los proyectos que no están en marcha no dejan etiquetas y
    // no salen en la tabla, así que hay que ir a buscarlos.
    expect(
      contenido().getByText(/no tener que copiar la ruta a mano/i)
    ).toBeInTheDocument()
  })

  it('aclara que el campo de la ruta sigue siendo editable', () => {
    render(<HelpModal open onClose={vi.fn()} />)
    irA(/pestañas/i)

    // El explorador solo recorre el directorio personal: si se presentara como la
    // única forma de elegir archivo, sería un problema.
    expect(contenido().getByText(/sigue siendo editable/i)).toBeInTheDocument()
  })

  it('explica el límite del explorador cuando algo no funciona', () => {
    render(<HelpModal open onClose={vi.fn()} />)
    irA(/si algo no funciona/i)

    expect(
      contenido().getByRole('heading', { name: /no deja subir ni salir/i })
    ).toBeInTheDocument()
  })

  it('documenta que Desplegar avisa del coste de construir', () => {
    render(<HelpModal open onClose={vi.fn()} />)
    irA(/pestañas/i)

    // Sin esto, un "Desplegar" que tarda 8 minutos construyendo se lee como que
    // el panel está colgado.
    expect(contenido().getByText(/antes de\s+hacerlo/i)).toBeInTheDocument()
  })

  it('explica el bloqueo por nombre de proyecto ocupado', () => {
    render(<HelpModal open onClose={vi.fn()} />)
    irA(/si algo no funciona/i)

    expect(
      contenido().getByRole('heading', { name: /nombre está ocupado/i })
    ).toBeInTheDocument()
  })

  it('explica que compose puede faltar sin que se rompa el inventario', () => {
    render(<HelpModal open onClose={vi.fn()} />)
    irA(/no funciona/i)

    expect(contenido().getAllByText(/docker compose/i).length).toBeGreaterThan(0)
    expect(contenido().getByText(/siguen\s+funcionando/i)).toBeInTheDocument()
  })

  it('explica qué significa que un volumen no tenga contenedores', () => {
    render(<HelpModal open onClose={vi.fn()} />)
    irA(/pestañas/i)

    // El detalle importa: es lo que evita borrar un volumen en uso por error
    expect(contenido().getByText(/se puede borrar sin forzar/i)).toBeInTheDocument()
  })

  it('explica que las operaciones irreversibles no se pueden deshacer', () => {
    render(<HelpModal open onClose={vi.fn()} />)
    irA(/irreversibles/i)

    expect(contenido().getByText(/no se puede deshacer/i)).toBeInTheDocument()
    expect(contenido().getByText(/Limpiar sin uso/i)).toBeInTheDocument()
    // "forzar" sale repetido, así que se afirma sobre la frase que explica qué hace
    expect(
      contenido().getByText(/mata el proceso sin apagado limpio/i)
    ).toBeInTheDocument()
  })

  it('dice qué está protegido y no se toca', () => {
    render(<HelpModal open onClose={vi.fn()} />)
    irA(/irreversibles/i)

    expect(contenido().getByText(/predefinidas/i)).toBeInTheDocument()
    expect(contenido().getByText(/no se tocan/i)).toBeInTheDocument()
  })

  it('explica de dónde salen los datos en vivo', () => {
    render(<HelpModal open onClose={vi.fn()} />)
    irA(/datos en vivo/i)

    expect(
      contenido().getByText(/se mantienen abiertos por/i)
    ).toBeInTheDocument()
    expect(contenido().getAllByText(/WebSocket/i).length).toBeGreaterThan(0)
  })

  it('avisa de que lo en pantalla puede estar caducado si se cae la conexión', () => {
    render(<HelpModal open onClose={vi.fn()} />)
    irA(/datos en vivo/i)

    expect(contenido().getByText(/reintenta solo/i)).toBeInTheDocument()
  })

  it('incluye resolución de problemas con el socket y los puertos', () => {
    render(<HelpModal open onClose={vi.fn()} />)
    irA(/no funciona/i)

    expect(contenido().getByText(/\/var\/run\/docker\.sock/)).toBeInTheDocument()
    expect(contenido().getByText(/PORT_FRONTEND/)).toBeInTheDocument()
    expect(contenido().getByText(/FRONTEND_PORT/)).toBeInTheDocument()
  })

  it('se cierra con el aspa y con el botón del pie', () => {
    const onClose = vi.fn()
    render(<HelpModal open onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Cerrar ayuda' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    // El nombre accesible del aspa es "Cerrar ayuda", así que el del pie es
    // distinto y no hay ambigüedad
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('se cierra con la tecla Escape', () => {
    const onClose = vi.fn()
    render(<HelpModal open onClose={onClose} />)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('se cierra al pulsar el fondo, pero no al pulsar dentro', () => {
    const onClose = vi.fn()
    render(<HelpModal open onClose={onClose} />)

    // El fondo es el contenedor del overlay, padre del panel
    fireEvent.click(dialogo().parentElement as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(contenido().getByRole('heading', { name: 'General' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('marca la sección activa', () => {
    render(<HelpModal open onClose={vi.fn()} />)
    irA(/pestañas/i)

    expect(screen.getByRole('button', { name: /pestañas/i })).toHaveAttribute(
      'aria-current',
      'page'
    )
    expect(screen.getByRole('button', { name: 'General' })).not.toHaveAttribute(
      'aria-current'
    )
  })

  it('vuelve a la sección General al reabrirse', () => {
    // Si no, se reencuentra el manual a mitad de camino tras cerrarlo
    const { rerender } = render(<HelpModal open onClose={vi.fn()} />)
    irA(/irreversibles/i)

    rerender(<HelpModal open={false} onClose={vi.fn()} />)
    rerender(<HelpModal open onClose={vi.fn()} />)

    expect(contenido().getByRole('heading', { name: 'General' })).toBeInTheDocument()
  })

  describe('legibilidad sobre la pantalla', () => {
    it('aprovecha el ancho disponible en vez de quedarse en una columna estrecha', () => {
      render(<HelpModal open onClose={vi.fn()} />)
      const clases = dialogo().className

      // max-w-2xl son 672px: en un monitor de 1920 se desperdicia la mitad
      expect(clases).toMatch(/max-w-(4xl|5xl|6xl|7xl)/)
      expect(clases).not.toContain('max-w-2xl')
      expect(clases).not.toContain('max-w-md')
    })

    it('usa casi toda la altura disponible', () => {
      render(<HelpModal open onClose={vi.fn()} />)
      const clases = dialogo().className

      expect(clases).toMatch(/max-h-\[9\dvh\]/)
    })

    it('no se queda en letra de 11px, que es ilegible de sostiene', () => {
      const { container } = render(<HelpModal open onClose={vi.fn()} />)
      // 11px es el tamaño que motivó la queja: se sube a 13px como mínimo
      expect(container.querySelector('.text-\\[11px\\]')).toBeNull()
    })

    it('el cuerpo del texto es de 13px o más', () => {
      const { container } = render(<HelpModal open onClose={vi.fn()} />)
      const cuerpos = [...container.querySelectorAll('p')]
      expect(cuerpos.length).toBeGreaterThan(0)
      for (const p of cuerpos) {
        const clases = p.className
        const tamano = clases.match(/text-(xs|sm|base|lg|\[(1[1-9]|\d\d)px\])/)
        expect(tamano).not.toBeNull()
        if (tamano?.[1] === 'xs') throw new Error('queda texto de 12px o menor')
        if (tamano?.[1]?.startsWith('[')) {
          const px = Number(tamano[1].replace(/\D/g, ''))
          expect(px).toBeGreaterThanOrEqual(13)
        }
      }
    })

    it('la navegación lateral también se lee sin esfuerzo', () => {
      render(<HelpModal open onClose={vi.fn()} />)
      const nav = screen.getByRole('navigation', { name: /secciones/i })
      expect(nav.className).not.toContain('w-40')
    })
  })

  it('acota la medida de línea para que no se lea a lo largo de la pantalla', () => {
    // Con max-w-5xl el texto llega a ~100 caracteres por línea, cuando lo
    // cómodo está entre 60 y 75. Acotarlo es lo que hace legible el manual.
    const { container } = render(<HelpModal open onClose={vi.fn()} />)
    const parrafos = [...container.querySelectorAll('p')]

    expect(parrafos.length).toBeGreaterThan(0)
    for (const p of parrafos) {
      if (p.className.includes('leading-relaxed')) {
        expect(p.className).toMatch(/max-w-\[\d+ch\]/)
      }
    }
  })

  it('aprovecha el ancho con dos columnas donde el contenido lo permite', () => {
    const { container } = render(<HelpModal open onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /pestañas/i }))

    // Las cuatro pestañas se reparten en dos columnas en pantallas anchas
    const rejilla = [...container.querySelectorAll('div')].find((d) =>
      d.className.includes('sm:grid-cols-2')
    )
    expect(rejilla).toBeDefined()
  })
})
