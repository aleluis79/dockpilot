import React from 'react'
import { Anchor, RefreshCw, Plus } from 'lucide-react'

interface NavbarProps {
  onRefresh: () => void
  loading: boolean
  onOpenCreateModal?: () => void
}

export const Navbar: React.FC<NavbarProps> = ({
  onRefresh,
  loading,
  onOpenCreateModal,
}) => {
  return (
    <header className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center text-white shadow-lg shadow-blue-500/20">
            <Anchor className="w-5 h-5 stroke-[2.5]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-zinc-100 tracking-tight text-lg">DockPilot</span>
              <span className="text-[10px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 font-semibold">
                v0.1.0
              </span>
            </div>
            <p className="text-[11px] text-zinc-500 leading-none">Gestor local de Docker</p>
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

          <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-zinc-900 border border-zinc-800 text-xs text-zinc-400">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="font-mono">/var/run/docker.sock</span>
            <span className="text-emerald-400 font-medium">Conectado</span>
          </div>

          <button
            onClick={onRefresh}
            disabled={loading}
            className="p-2 text-zinc-400 hover:text-zinc-100 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 rounded-xl transition-all disabled:opacity-50 cursor-pointer"
            title="Refrescar lista"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-blue-400' : ''}`} />
          </button>
        </div>
      </div>
    </header>
  )
}
