// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ITheme } from '@xterm/xterm'
import type { ResolvedTheme } from '../../types/theme'

/**
 * xterm.js no lee clases CSS: su paleta ANSI es un objeto JavaScript.
 * Estos mapas son la unica superficie del tema que no pasa por tokens CSS,
 * y por eso viven aqui y no dispersos en el componente.
 *
 * Los valores oscuros replican la paleta que tenia el terminal hardcodeada;
 * los claros usan tonos mas oscuros para mantener el contraste sobre fondo claro.
 */
export const TERMINAL_THEMES: Record<ResolvedTheme, ITheme> = {
  dark: {
    background: '#09090b',
    foreground: '#f4f4f5',
    cursor: '#38bdf8',
    cursorAccent: '#09090b',
    selectionBackground: 'rgba(59, 130, 246, 0.35)',
    black: '#18181b',
    red: '#f43f5e',
    green: '#10b981',
    yellow: '#f59e0b',
    blue: '#3b82f6',
    magenta: '#d946ef',
    cyan: '#06b6d4',
    white: '#f4f4f5',
    brightBlack: '#71717a',
    brightRed: '#fb7185',
    brightGreen: '#34d399',
    brightYellow: '#fbbf24',
    brightBlue: '#60a5fa',
    brightMagenta: '#e879f9',
    brightCyan: '#22d3ee',
    brightWhite: '#ffffff',
  },
  light: {
    background: '#f4f4f5',
    foreground: '#27272a',
    cursor: '#0284c7',
    cursorAccent: '#f4f4f5',
    selectionBackground: 'rgba(37, 99, 235, 0.22)',
    black: '#18181b',
    red: '#be123c',
    green: '#047857',
    yellow: '#b45309',
    blue: '#1d4ed8',
    magenta: '#a21caf',
    cyan: '#0e7490',
    white: '#f4f4f5',
    brightBlack: '#71717a',
    brightRed: '#e11d48',
    brightGreen: '#059669',
    brightYellow: '#d97706',
    brightBlue: '#2563eb',
    brightMagenta: '#c026d3',
    brightCyan: '#0891b2',
    brightWhite: '#18181b',
  },
}

export const getTerminalTheme = (theme: ResolvedTheme): ITheme => TERMINAL_THEMES[theme]
