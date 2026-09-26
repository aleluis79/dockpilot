import { createContext, useContext } from 'react'
import { THEME_STORAGE_KEY } from '../types/theme'
import type { ResolvedTheme, ThemeMode } from '../types/theme'

const DARK_QUERY = '(prefers-color-scheme: dark)'

export interface ThemeContextValue {
  mode: ThemeMode
  resolvedTheme: ResolvedTheme
  setTheme: (mode: ThemeMode) => void
  toggleTheme: () => void
}

export const ThemeContext = createContext<ThemeContextValue | null>(null)

/** Lee el modo persistido, degradando a "system" si no existe o es inválido. */
export const readStoredMode = (): ThemeMode => {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch {
    // localStorage puede estar bloqueado (modo privado): se usa el valor por defecto
  }
  return 'system'
}

export const persistMode = (mode: ThemeMode): void => {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode)
  } catch {
    // Sin persistencia el tema sigue funcionando en memoria
  }
}

export const getSystemSnapshot = (): boolean => {
  try {
    return window.matchMedia(DARK_QUERY).matches
  } catch {
    return false
  }
}

/** Valor por defecto en servidor / antes de hidratar: se asume tema claro. */
export const getServerSnapshot = (): boolean => false

export const subscribeToSystemTheme = (
  onStoreChange: () => void,
  active: boolean
): (() => void) => {
  if (!active) return () => {}
  let mql: MediaQueryList
  try {
    mql = window.matchMedia(DARK_QUERY)
  } catch {
    return () => {}
  }
  mql.addEventListener('change', onStoreChange)
  return () => mql.removeEventListener('change', onStoreChange)
}

/**
 * Aplica el tema efectivo al DOM.
 *
 * El tema claro es la AUSENCIA de la clase `dark`: no existe una clase `light`,
 * para no tener dos clases que mantener sincronizadas.
 */
export const applyThemeToDom = (mode: ThemeMode, resolved: ResolvedTheme): void => {
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark')
  root.setAttribute('data-theme', mode)
}

export const useTheme = (): ThemeContextValue => {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme debe utilizarse dentro de un <ThemeProvider>')
  }
  return context
}
