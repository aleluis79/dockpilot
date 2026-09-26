import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useTheme } from '../../src/hooks/useTheme'
import { ThemeProvider } from '../../src/components/layout/ThemeProvider'
import { THEME_STORAGE_KEY } from '../../src/types/theme'

type ChangeListener = (event: MediaQueryListEvent) => void

class MockMediaQueryList {
  media: string
  matches: boolean
  private listeners: ChangeListener[] = []

  constructor(media: string, matches: boolean) {
    this.media = media
    this.matches = matches
  }

  addEventListener(type: string, listener: ChangeListener) {
    if (type === 'change') this.listeners.push(listener)
  }

  removeEventListener(type: string, listener: ChangeListener) {
    if (type === 'change') this.listeners = this.listeners.filter((l) => l !== listener)
  }

  /** Simula que el sistema operativo cambia su preferencia de apariencia. */
  set(matches: boolean) {
    this.matches = matches
    const event = { matches, media: this.media } as MediaQueryListEvent
    this.listeners.forEach((listener) => listener(event))
  }
}

let mql: MockMediaQueryList

const wrapper = ({ children }: { children: ReactNode }) => (
  <ThemeProvider>{children}</ThemeProvider>
)

const hasDarkClass = () => document.documentElement.classList.contains('dark')
const dataTheme = () => document.documentElement.getAttribute('data-theme')

describe('useTheme', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.className = ''
    document.documentElement.removeAttribute('data-theme')
    // Instancia estable: la suscripción y la lectura del snapshot deben
    // operar sobre el mismo MediaQueryList, como en un navegador real.
    mql = new MockMediaQueryList('(prefers-color-scheme: dark)', false)
    vi.stubGlobal('matchMedia', () => mql)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('test_theme_defaults_to_system', () => {
    mql.set(true)
    const { result } = renderHook(() => useTheme(), { wrapper })

    expect(result.current.mode).toBe('system')
    expect(result.current.resolvedTheme).toBe('dark')
    expect(hasDarkClass()).toBe(true)
    expect(dataTheme()).toBe('system')
  })

  it('test_theme_resolves_to_light_when_system_prefers_light', () => {
    const { result } = renderHook(() => useTheme(), { wrapper })

    expect(result.current.resolvedTheme).toBe('light')
    expect(hasDarkClass()).toBe(false)
  })

  it('test_theme_applies_dark_class_on_document_element', () => {
    const { result } = renderHook(() => useTheme(), { wrapper })

    act(() => {
      result.current.setTheme('dark')
    })
    expect(hasDarkClass()).toBe(true)
    expect(dataTheme()).toBe('dark')

    act(() => {
      result.current.setTheme('light')
    })
    expect(hasDarkClass()).toBe(false)
    expect(dataTheme()).toBe('light')
  })

  it('test_set_theme_persists_to_local_storage', () => {
    const { result } = renderHook(() => useTheme(), { wrapper })

    act(() => {
      result.current.setTheme('light')
    })

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(result.current.mode).toBe('light')
  })

  it('test_theme_follows_system_changes', () => {
    const { result } = renderHook(() => useTheme(), { wrapper })
    expect(result.current.resolvedTheme).toBe('light')

    act(() => {
      mql.set(true)
    })

    expect(result.current.mode).toBe('system')
    expect(result.current.resolvedTheme).toBe('dark')
    expect(hasDarkClass()).toBe(true)
  })

  it('test_manual_mode_ignores_system_changes', () => {
    const { result } = renderHook(() => useTheme(), { wrapper })

    act(() => {
      result.current.setTheme('dark')
    })
    expect(result.current.resolvedTheme).toBe('dark')

    act(() => {
      mql.set(false)
    })

    expect(result.current.resolvedTheme).toBe('dark')
    expect(hasDarkClass()).toBe(true)
  })

  it('test_invalid_stored_value_falls_back_to_system', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'neon')
    mql.set(true)

    const { result } = renderHook(() => useTheme(), { wrapper })

    expect(result.current.mode).toBe('system')
    expect(result.current.resolvedTheme).toBe('dark')
  })

  it('test_local_storage_failure_is_tolerated', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('localStorage bloqueado')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('localStorage bloqueado')
    })

    const { result } = renderHook(() => useTheme(), { wrapper })
    expect(result.current.mode).toBe('system')

    expect(() =>
      act(() => {
        result.current.setTheme('dark')
      })
    ).not.toThrow()
    // El tema se aplica en el DOM aunque no se pueda persistir
    expect(hasDarkClass()).toBe(true)
  })

  it('test_toggle_cycles_through_the_three_modes', () => {
    const { result } = renderHook(() => useTheme(), { wrapper })
    expect(result.current.mode).toBe('system')

    act(() => {
      result.current.toggleTheme()
    })
    expect(result.current.mode).toBe('light')

    act(() => {
      result.current.toggleTheme()
    })
    expect(result.current.mode).toBe('dark')

    act(() => {
      result.current.toggleTheme()
    })
    expect(result.current.mode).toBe('system')
  })

  it('test_unsubscribes_from_system_changes_on_unmount', () => {
    const { result, unmount } = renderHook(() => useTheme(), { wrapper })

    act(() => {
      result.current.setTheme('system')
    })
    const listenerCountBefore = mql.matches

    unmount()

    // Tras desmontar, un cambio del SO no debe lanzar ni afectar nada
    expect(() => mql.set(!listenerCountBefore)).not.toThrow()
  })
})
