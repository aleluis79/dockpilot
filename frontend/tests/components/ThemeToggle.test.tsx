import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ThemeToggle } from '../../src/components/layout/ThemeToggle'
import { ThemeProvider } from '../../src/components/layout/ThemeProvider'
import { THEME_STORAGE_KEY } from '../../src/types/theme'

class MockMediaQueryList {
  media: string
  matches: boolean

  constructor(media: string, matches: boolean) {
    this.media = media
    this.matches = matches
  }

  addEventListener() {}
  removeEventListener() {}
}

const LABEL = {
  system: 'Sistema',
  light: 'Claro',
  dark: 'Oscuro',
} as const

describe('ThemeToggle', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.className = ''
    document.documentElement.removeAttribute('data-theme')
    vi.stubGlobal('matchMedia', (query: string) => new MockMediaQueryList(query, false))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const renderToggle = () =>
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>
    )

  it('renderiza un unico boton, no un control segmentado', () => {
    renderToggle()

    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('el aria-label declara el estado actual y el siguiente modo', () => {
    renderToggle()

    // modo por defecto: system -> siguiente light
    expect(screen.getByRole('button')).toHaveAccessibleName(
      `Tema: ${LABEL.system}. Cambiar a ${LABEL.light}`
    )
    // region viva para que el lector de pantalla anuncie el cambio de estado
    expect(screen.getByRole('button')).toHaveAttribute('aria-live', 'polite')
  })

  it('el icono visible corresponde al modo activo, no al siguiente', () => {
    renderToggle()

    const active = document.querySelector('[data-active-icon="system"]')
    expect(active).toBeInTheDocument()
    expect(active).toHaveClass('opacity-100', 'rotate-0')
    expect(document.querySelector('[data-active-icon="light"]')).toHaveClass('opacity-0')
  })

  it('al pulsar avanza en el orden system -> light -> dark -> system', () => {
    renderToggle()
    const button = screen.getByRole('button')

    fireEvent.click(button)
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(button).toHaveAccessibleName(`Tema: ${LABEL.light}. Cambiar a ${LABEL.dark}`)

    fireEvent.click(button)
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    fireEvent.click(button)
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')
  })

  it('el icono rota al cambiar de modo', () => {
    renderToggle()
    const button = screen.getByRole('button')

    fireEvent.click(button)

    expect(document.querySelector('[data-active-icon="light"]')).toHaveClass('opacity-100')
    expect(document.querySelector('[data-active-icon="system"]')).toHaveClass('opacity-0')
  })

  it('los iconos ocupan exactamente la caja del contenedor y quedan centrados', () => {
    renderToggle()

    // Los SVG de lucide traen width/height=24 como atributo de presentacion.
    // Con `absolute inset-0` ese ancho explicito gana sobre `right: 0` y el
    // icono se ancla en la esquina superior izquierda, desbordando la caja.
    // `h-full w-full` fuerza que llene el contenedor y quede centrado.
    for (const icon of document.querySelectorAll('[data-active-icon]')) {
      expect(icon.getAttribute('class')).toContain('h-full')
      expect(icon.getAttribute('class')).toContain('w-full')
    }
  })

  it('respeta el movimiento reducido desactivando la transicion', () => {
    renderToggle()

    // En SVG `className` es un SVGAnimatedString, hay que leer el atributo
    const icon = document.querySelector('[data-active-icon="system"]')
    expect(icon?.getAttribute('class')).toContain('motion-reduce:transition-none')
  })

  it('arranca en el modo persistido y no en system', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    renderToggle()

    expect(screen.getByRole('button')).toHaveAccessibleName(
      `Tema: ${LABEL.dark}. Cambiar a ${LABEL.system}`
    )
    expect(document.querySelector('[data-active-icon="dark"]')).toBeInTheDocument()
  })
})
