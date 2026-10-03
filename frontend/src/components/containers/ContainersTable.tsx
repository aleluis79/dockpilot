// SPDX-License-Identifier: AGPL-3.0-or-later
import React from 'react'
import { Box, ExternalLink, Eye, RefreshCw } from 'lucide-react'
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
      {/* `table-fixed` y no `table-auto`, y por el motivo que se lee en la
          celda del nombre: en auto, la columna se dimensiona al contenido, así
          que un solo nombre de 64 caracteres empuja la tabla entera más allá del
          contenedor, salta el `overflow-x-auto` del envoltorio y los botones de
          acción se quedan fuera de pantalla. Con `fixed` las columnas se
          reparten el ancho disponible y la tabla nunca lo excede. Los anchos
          suman menos del 100% a propósito, para que la última columna —las
          acciones— se quede con el sobrante en vez de repartírselo a la primera. */}
      <table className="w-full table-fixed text-left text-sm text-fg">
        <thead className="bg-surface/80 text-xs uppercase tracking-wider text-fg-muted border-b border-default">
          <tr>
            <th className="w-[20%] py-3.5 px-4 font-semibold">Contenedor</th>
            <th className="w-[12%] py-3.5 px-4 font-semibold">Proyecto</th>
            <th className="w-[22%] py-3.5 px-4 font-semibold">Imagen</th>
            <th className="w-[12%] py-3.5 px-4 font-semibold">Estado</th>
            <th className="w-[14%] py-3.5 px-4 font-semibold">Puertos</th>
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
                <div className="flex flex-col min-w-0">
                  {/* Un nombre de contenedor puede ser un sha de 64 caracteres.
                      Sin acotar la celda, esa columna empuja la tabla entera más
                      allá del contenedor, el `overflow-x-auto` de arriba se
                      activa y los BOTONES DE ACCIÓN se van fuera de pantalla sin
                      scroll horizontal que lo indique. Por eso el truncado, y no
                      un scroll: la acción es lo que hay que poder pulsar (SPEC-00). */}
                  <span
                    className="font-medium text-fg group-hover:text-blue-400 transition-colors truncate"
                    title={c.name}
                  >
                    {c.name}
                  </span>
                  <span className="font-mono text-xs text-fg-muted">{c.id.slice(0, 12)}</span>
                </div>
                {c.observed && (
                  // La marca va en la fila y no en una columna propia: es un dato
                  // de un solo botón, y una columna entera para
                  // un punto sería más tabla que información. Llega en el
                  // listado sin pedir nada extra al daemon (SPEC-17 §4.9).
                  <span
                    data-testid="container-observed"
                    title="El panel está midiendo las métricas de este contenedor aunque no tengas sus ventanas abiertas"
                    className="mt-1 inline-flex items-center gap-1 self-start text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20"
                  >
                    <Eye className="w-3 h-3" />
                    Observando
                  </span>
                )}
              </td>
              <td className="py-3.5 px-4">
                <ComposeBadge project={c.compose_project} />
              </td>
              <td className="py-3.5 px-4">
                {/* Mismo motivo que el nombre: una referencia de imagen con
                    digest son 71 caracteres. */}
                <span
                  className="block font-mono text-xs text-fg-muted bg-elevated/60 px-2 py-0.5 rounded border border-strong/40 truncate"
                  title={c.image}
                >
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
