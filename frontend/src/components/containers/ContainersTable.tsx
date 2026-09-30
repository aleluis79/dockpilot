// SPDX-License-Identifier: AGPL-3.0-or-later
import React from 'react'
import { Box, ExternalLink, RefreshCw } from 'lucide-react'
import type { ContainerSummary } from '../../types/docker'
import { StatusBadge } from '../ui/StatusBadge'
import { ComposeBadge } from '../compose/ComposeBadge'
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
      <div className="flex flex-col items-center justify-center p-12 text-fg-muted">
        <RefreshCw className="w-8 h-8 animate-spin mb-3 text-blue-600 dark:text-blue-500" />
        <p className="text-sm">Cargando contenedores locales...</p>
      </div>
    )
  }

  if (containers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-12 bg-surface/50 rounded-xl border border-default text-fg-muted">
        <Box className="w-10 h-10 mb-2 stroke-1 text-fg-subtle" />
        <p className="text-sm font-medium text-fg-muted">No se encontraron contenedores</p>
        <p className="text-xs text-fg-subtle mt-1">Prueba cambiando los filtros o la búsqueda</p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-default bg-surface/40 backdrop-blur">
      <table className="w-full text-left text-sm text-fg">
        <thead className="bg-surface/80 text-xs uppercase tracking-wider text-fg-muted border-b border-default">
          <tr>
            <th className="py-3.5 px-4 font-semibold">Contenedor</th>
            <th className="py-3.5 px-4 font-semibold">Proyecto</th>
            <th className="py-3.5 px-4 font-semibold">Imagen</th>
            <th className="py-3.5 px-4 font-semibold">Estado</th>
            <th className="py-3.5 px-4 font-semibold">Puertos</th>
            <th className="py-3.5 px-4 font-semibold text-right">Acciones</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-default/60 font-sans">
          {containers.map((c) => (
            <tr
              key={c.id}
              onClick={() => onSelect(c)}
              className="hover:bg-fg/10 cursor-pointer transition-colors group"
            >
              <td className="py-3.5 px-4">
                <div className="flex flex-col">
                  <span className="font-medium text-fg group-hover:text-blue-400 transition-colors">
                    {c.name}
                  </span>
                  <span className="font-mono text-xs text-fg-muted">{c.id.slice(0, 12)}</span>
                </div>
              </td>
              <td className="py-3.5 px-4">
                <ComposeBadge project={c.compose_project} />
              </td>
              <td className="py-3.5 px-4">
                <span className="font-mono text-xs text-fg-muted bg-elevated/60 px-2 py-0.5 rounded border border-strong/40">
                  {c.image}
                </span>
              </td>
              <td className="py-3.5 px-4">
                <StatusBadge status={c.status} health={c.health} />
              </td>
              <td className="py-3.5 px-4" onClick={(e) => e.stopPropagation()}>
                <div className="flex flex-wrap gap-1.5">
                  {c.ports.length > 0 ? (
                    c.ports.map((p, idx) => (
                      <span
                        key={idx}
                        className="inline-flex items-center gap-1 font-mono text-xs px-2 py-0.5 rounded bg-elevated/80 text-fg border border-strong/50"
                      >
                        {p.public_port ? (
                          <a
                            href={`http://localhost:${p.public_port}`}
                            target="_blank"
                            rel="noreferrer"
                            className="hover:text-blue-700 dark:hover:text-blue-400 flex items-center gap-1 underline underline-offset-2 decoration-fg-subtle"
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
                    <span className="text-fg-subtle text-xs italic">-</span>
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
