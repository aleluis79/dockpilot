import { describe, it, expect } from 'vitest'
import { TERMINAL_THEMES, getTerminalTheme } from '../../src/components/terminal/terminalThemes'

const REQUIRED_KEYS = [
  'background',
  'foreground',
  'cursor',
  'cursorAccent',
  'selectionBackground',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const

const isColor = (value: unknown) =>
  typeof value === 'string' && (/^#[0-9a-f]{3,8}$/i.test(value) || /^rgba?\(/.test(value))

describe('paletas de xterm.js', () => {
  it('define una paleta completa para dark y para light', () => {
    for (const mode of ['dark', 'light'] as const) {
      const theme = TERMINAL_THEMES[mode]
      for (const key of REQUIRED_KEYS) {
        expect(theme[key], `falta ${key} en la paleta ${mode}`).toBeDefined()
        expect(isColor(theme[key]), `${key} de la paleta ${mode} no es un color válido`).toBe(true)
      }
    }
  })

  it('expone exactamente las mismas claves en ambos temas', () => {
    expect(Object.keys(TERMINAL_THEMES.dark).sort()).toEqual(
      Object.keys(TERMINAL_THEMES.light).sort()
    )
  })

  it('mantiene la terminal legible: primer plano claro sobre fondo oscuro y al reves', () => {
    const luminance = (hex: string) => {
      const n = parseInt(hex.slice(1), 16)
      const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
        const s = c / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }

    for (const mode of ['dark', 'light'] as const) {
      const { background, foreground } = TERMINAL_THEMES[mode]
      const bg = luminance(background as string)
      const fg = luminance(foreground as string)
      const ratio = (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05)
      expect(ratio, `contraste insuficiente en la paleta ${mode}`).toBeGreaterThan(4.5)
    }
  })

  it('el fondo de la paleta clara coincide con el token bg-inset en modo claro', () => {
    // bg-inset claro = #f4f4f5 (declarado en src/index.css)
    expect(TERMINAL_THEMES.light.background).toBe('#f4f4f5')
  })

  it('getTerminalTheme devuelve la paleta solicitada', () => {
    expect(getTerminalTheme('light')).toBe(TERMINAL_THEMES.light)
    expect(getTerminalTheme('dark')).toBe(TERMINAL_THEMES.dark)
  })
})
