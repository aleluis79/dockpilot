import React from 'react'
import { Box, ExternalLink, RefreshCw } from 'lucide-react'
import type { ContainerSummary } from '../../types/docker'
import { StatusBadge } from '../ui/StatusBadge'
import { ActionButtons } from './ActionButtons'

interface ContainersTableProps {
  containers: ContainerSummary[]
  loading: boolean
  actionInProgress?: string | null
  onAction: (
    id: string,
    action: 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'remove',
    force?: boolean
  ) => void
  onSelect: (container: ContainerSummary) => void
  onViewLogs?: (container: ContainerSummary) => void
  onViewStats?: (container: ContainerSummary) => void
  onOpenTerminal?: (container: ContainerSummary) => void
  onRequestDelete?: (container: ContainerSummary) => void
}

export const ContainersTable: React.FC<ContainersTableProps> = ({
  containers,
  loading,
  actionInProgress,
  onAction,
  onSelect,
  onViewLogs,
  onViewStats,
  onOpenTerminal,
  onRequestDelete,
}) => {
  if (loading && containers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-zinc-500">
        <RefreshCw className="w-8 h-8 animate-spin mb-3 text-blue-500" />
        <p className="text-sm">Cargando contenedores locales...</p>
      </div>
    )
  }

  if (containers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-12 bg-zinc-900/50 rounded-xl border border-zinc-800 text-zinc-500">
        <Box className="w-10 h-10 mb-2 stroke-1 text-zinc-600" />
        <p className="text-sm font-medium text-zinc-400">No se encontraron contenedores</p>
        <p className="text-xs text-zinc-600 mt-1">Prueba cambiando los filtros o la búsqueda</p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900/40 backdrop-blur">
      <table className="w-full text-left text-sm text-zinc-300">
        <thead className="bg-zinc-900/80 text-xs uppercase tracking-wider text-zinc-500 border-b border-zinc-800">
          <tr>
            <th className="py-3.5 px-4 font-semibold">Contenedor</th>
            <th className="py-3.5 px-4 font-semibold">Imagen</th>
            <th className="py-3.5 px-4 font-semibold">Estado</th>
            <th className="py-3.5 px-4 font-semibold">Puertos</th>
            <th className="py-3.5 px-4 font-semibold text-right">Acciones</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800/60 font-sans">
          {containers.map((c) => (
            <tr
              key={c.id}
              onClick={() => onSelect(c)}
              className="hover:bg-zinc-800/40 cursor-pointer transition-colors group"
            >
              <td className="py-3.5 px-4">
                <div className="flex flex-col">
                  <span className="font-medium text-zinc-100 group-hover:text-blue-400 transition-colors">
                    {c.name}
                  </span>
                  <span className="font-mono text-xs text-zinc-500">{c.id.slice(0, 12)}</span>
                </div>
              </td>
              <td className="py-3.5 px-4">
                <span className="font-mono text-xs text-zinc-400 bg-zinc-800/60 px-2 py-0.5 rounded border border-zinc-700/40">
                  {c.image}
                </span>
              </td>
              <td className="py-3.5 px-4">
                <StatusBadge status={c.status} />
              </td>
              <td className="py-3.5 px-4" onClick={(e) => e.stopPropagation()}>
                <div className="flex flex-wrap gap-1.5">
                  {c.ports.length > 0 ? (
                    c.ports.map((p, idx) => (
                      <span
                        key={idx}
                        className="inline-flex items-center gap-1 font-mono text-xs px-2 py-0.5 rounded bg-zinc-800/80 text-zinc-300 border border-zinc-700/50"
                      >
                        {p.public_port ? (
                          <a
                            href={`http://localhost:${p.public_port}`}
                            target="_blank"
                            rel="noreferrer"
                            className="hover:text-blue-400 flex items-center gap-1 underline underline-offset-2 decoration-zinc-600"
                          >
                            {p.public_port}:{p.private_port}/{p.type}
                            <ExternalLink className="w-2.5 h-2.5" />
                          </a>
                        ) : (
                          `${p.private_port}/${p.type}`
                        )}
                      </span>
                    ))
                  ) : (
                    <span className="text-zinc-600 text-xs italic">-</span>
                  )}
                </div>
              </td>
              <td className="py-3.5 px-4 text-right">
                <div className="flex justify-end">
                  <ActionButtons
                    container={c}
                    actionInProgress={actionInProgress}
                    onAction={onAction}
                    onViewLogs={onViewLogs}
                    onViewStats={onViewStats}
                    onOpenTerminal={onOpenTerminal}
                    onRequestDelete={onRequestDelete}
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
