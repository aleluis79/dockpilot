import React from 'react'
import { Moon, Sun, Monitor } from 'lucide-react'
import { useTheme } from '../../hooks/useTheme'
import { THEME_CYCLE_ORDER, THEME_OPTIONS } from '../../types/theme'
import type { ThemeIcon, ThemeMode } from '../../types/theme'

const ICONS: Record<ThemeIcon, React.FC<{ className?: string }>> = {
  moon: Moon,
  sun: Sun,
  monitor: Monitor,
}

const labelOf = (mode: ThemeMode): string =>
  THEME_OPTIONS.find((option) => option.mode === mode)?.label ?? mode

const nextMode = (mode: ThemeMode): ThemeMode => {
  const index = THEME_CYCLE_ORDER.indexOf(mode)
  return THEME_CYCLE_ORDER[(index + 1) % THEME_CYCLE_ORDER.length]
}

/**
 * Selector de tema como boton unico con icono rotante.
 *
 * Los tres iconos coexisten apilados en un contenedor de tamano fijo: el activo
 * a opacidad 1 y sin rotacion, los inactivos a opacidad 0 y girados -90deg. La
 * transicion CSS produce el giro con fundido sin recrear el nodo, lo que evita
 * el parpadeo que daria remontar el icono en cada cambio.
 */
export const ThemeToggle: React.FC = () => {
  const { mode, toggleTheme } = useTheme()
  const next = nextMode(mode)

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={`Tema: ${labelOf(mode)}. Cambiar a ${labelOf(next)}`}
      aria-live="polite"
      title={`Tema: ${labelOf(mode)} — cambiar a ${labelOf(next)}`}
      className="relative p-2 text-fg-muted hover:text-fg bg-elevated hover:bg-fg/10 border border-default rounded-xl transition-colors cursor-pointer"
    >
      <span className="relative block h-4 w-4" aria-hidden="true">
        {THEME_OPTIONS.map((option) => {
          const Icon = ICONS[option.icon]
          const isActive = option.mode === mode

          return (
            <Icon
              key={option.mode}
              data-active-icon={option.mode}
              /* `h-full w-full` es imprescindible: los SVG de lucide declaran
                 width/height=24 como atributo de presentacion y, con solo
                 `absolute inset-0`, ese ancho explicito prevaileceria sobre
                 `right: 0`, anclando el icono en la esquina superior izquierda
                 y desbordando la caja de 16px. */
              className={`absolute inset-0 h-full w-full transition-all duration-300 ease-out motion-reduce:transition-none ${
                isActive ? 'opacity-100 rotate-0 scale-100' : 'opacity-0 -rotate-90 scale-75'
              }`}
            />
          )
        })}
      </span>
    </button>
  )
}
