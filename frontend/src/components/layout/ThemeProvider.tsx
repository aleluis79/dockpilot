import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { THEME_CYCLE_ORDER } from '../../types/theme'
import type { ResolvedTheme, ThemeMode } from '../../types/theme'
import {
  ThemeContext,
  applyThemeToDom,
  getServerSnapshot,
  getSystemSnapshot,
  persistMode,
  readStoredMode,
  subscribeToSystemTheme,
} from '../../hooks/useTheme'
import type { ThemeContextValue } from '../../hooks/useTheme'

/**
 * Proveedor de contexto del tema.
 *
 * Vive en su propio archivo (y no junto al hook) para que el Fast Refresh de
 * React funcione: un archivo que exporta un componente debe exportar solo
 * componentes, o la edicion del hook invalida el(provider).
 *
 * Se separa del hook a proposito para cumplir la regla
 * `react/only-export-components` de Oxlint.
 */
export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const [mode, setMode] = useState<ThemeMode>(readStoredMode)

  // Mientras el modo sea "system" se sigue la preferencia del SO. Al elegir un
  // modo manual la suscripción se descarta y el SO deja de afectar a la interfaz.
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeToSystemTheme(onStoreChange, mode === 'system'),
    [mode]
  )
  const systemDark = useSyncExternalStore(subscribe, getSystemSnapshot, getServerSnapshot)

  const resolvedTheme: ResolvedTheme =
    mode === 'system' ? (systemDark ? 'dark' : 'light') : mode

  useEffect(() => {
    applyThemeToDom(mode, resolvedTheme)
  }, [mode, resolvedTheme])

  const setTheme = useCallback((next: ThemeMode) => {
    setMode(next)
    persistMode(next)
  }, [])

  const toggleTheme = useCallback(() => {
    setMode((prev) => {
      const index = THEME_CYCLE_ORDER.indexOf(prev)
      const next = THEME_CYCLE_ORDER[(index + 1) % THEME_CYCLE_ORDER.length]
      persistMode(next)
      return next
    })
  }, [])

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolvedTheme, setTheme, toggleTheme }),
    [mode, resolvedTheme, setTheme, toggleTheme]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
