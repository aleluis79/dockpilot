// SPDX-License-Identifier: AGPL-3.0-or-later
import React from 'react'
import { Anchor, RefreshCw, Plus, HelpCircle } from 'lucide-react'
import { ThemeToggle } from './ThemeToggle'

interface NavbarProps {
  onRefresh: () => void
  loading: boolean
  onOpenCreateModal?: () => void
  onOpenHelp?: () => void
  /**
   * Error de la última petición al backend, si lo hubo. El indicador de estado
   * lo usa para dejar de decir «Conectado» cuando el daemon no responde.
   */
  error?: string | null
}

export const Navbar: React.FC<NavbarProps> = ({
  onRefresh,
  loading,
  onOpenCreateModal,
  onOpenHelp,
  error,
}) => {
  // Sin esto el indicador era decorativo: ponía «Conectado» siempre, y con el
  // backend parado cada vista enseñaba su propio error mientras la barra
  // afirmaba lo contrario.
  const conectado = !error

  return (
    <header className="border-b border-default bg-inset/80 backdrop-blur sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center text-white shadow-lg shadow-blue-500/20">
            <Anchor className="w-5 h-5 stroke-[2.5]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-fg tracking-tight text-lg">DockPilot</span>
              <span className="text-[10px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 font-semibold">
                v0.1.0
              </span>
            </div>
            <p className="text-[11px] text-fg-muted leading-none">Gestor local de Docker</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {onOpenCreateModal && (
            <button
              onClick={onOpenCreateModal}
              className="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-medium transition-all shadow-lg shadow-blue-500/20 flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Nuevo Contenedor</span>
            </button>
          )}

          <div
            className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-elevated border border-default text-xs text-fg-muted"
            title={error ?? 'El backend responde y el daemon está accesible'}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                conectado ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'
              }`}
            />
            <span className="font-mono">/var/run/docker.sock</span>
            <span
              className={
                conectado
                  ? 'text-emerald-700 dark:text-emerald-400 font-medium'
                  : 'text-rose-700 dark:text-rose-400 font-medium'
              }
            >
              {conectado ? 'Conectado' : 'Sin conexión'}
            </span>
          </div>

          <ThemeToggle />

          {/* Mismas clases que el boton de refrescar: los dos son iconos
              neutros de la barra, no acciones principales. */}
          {onOpenHelp && (
            <button
              type="button"
              onClick={onOpenHelp}
              className="p-2 text-fg-muted hover:text-fg bg-surface hover:bg-fg/10 border border-default rounded-xl transition-all cursor-pointer"
              title="Ayuda"
              aria-label="Abrir la ayuda"
            >
              <HelpCircle className="w-4 h-4" />
            </button>
          )}

          <button
            onClick={onRefresh}
            disabled={loading}
            className="p-2 text-fg-muted hover:text-fg bg-surface hover:bg-fg/10 border border-default rounded-xl transition-all disabled:opacity-50 cursor-pointer"
            title="Refrescar lista"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-blue-600 dark:text-blue-400' : ''}`} />
          </button>
        </div>
      </div>
    </header>
  )
}
