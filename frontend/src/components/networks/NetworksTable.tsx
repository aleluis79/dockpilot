import React from 'react'
import { Trash2, Network as NetworkIcon, Loader2 } from 'lucide-react'
import type { NetworkSummary } from '../../types/network'

interface NetworksTableProps {
  networks: NetworkSummary[]
  onSelect: (name: string) => void
  onDelete: (name: string) => void
  actionInProgress: string | null
}

const formatDate = (iso: string): string => {
  if (!iso) return '-'
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return '-'
  return parsed.toLocaleString('es-ES', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  })
}

export const NetworksTable: React.FC<NetworksTableProps> = ({
  networks,
  onSelect,
  onDelete,
  actionInProgress,
}) => {
  if (networks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-fg-subtle">
        <NetworkIcon className="w-10 h-10 mb-3 opacity-50" />
        <p className="text-sm">No hay redes que coincidan con el filtro</p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid="networks-table">
        <thead className="text-xs uppercase text-fg-subtle border-b border-default">
          <tr>
            <th className="text-left font-semibold px-4 py-2.5">Nombre</th>
            <th className="text-left font-semibold px-4 py-2.5">Driver</th>
            <th className="text-left font-semibold px-4 py-2.5">Subred</th>
            <th className="text-left font-semibold px-4 py-2.5">Contenedores</th>
            <th className="text-left font-semibold px-4 py-2.5">Creada</th>
            <th className="text-right font-semibold px-4 py-2.5">Acciones</th>
          </tr>
        </thead>
        <tbody>
          {networks.map((network) => (
            <tr
              key={network.id || network.name}
              className={`border-b border-default hover:bg-elevated-hover transition-colors ${
                network.is_builtin ? 'opacity-60' : ''
              }`}
            >
              <td className="px-4 py-2.5">
                <button
                  type="button"
                  onClick={() => onSelect(network.name)}
                  className="font-mono text-fg hover:underline text-left"
                >
                  {network.name}
                </button>
                {network.is_builtin && (
                  <span className="ml-2 px-1.5 py-0.5 text-[10px] uppercase rounded bg-elevated text-fg-subtle border border-default">
                    predefinida
                  </span>
                )}
                {network.internal && (
                  <span className="ml-2 px-1.5 py-0.5 text-[10px] uppercase rounded bg-elevated text-fg-subtle border border-default">
                    interna
                  </span>
                )}
              </td>
              <td className="px-4 py-2.5 font-mono text-fg-subtle text-xs">
                {network.driver || '-'}
              </td>
              <td className="px-4 py-2.5 font-mono text-fg-subtle text-xs">
                {network.subnets.length > 0 ? (
                  network.subnets.map((s) => s.subnet).join(', ')
                ) : (
                  <span className="italic">sin subred</span>
                )}
              </td>
              <td className="px-4 py-2.5 text-fg-subtle text-xs">
                {network.container_count}
              </td>
              <td className="px-4 py-2.5 text-fg-subtle text-xs">
                {formatDate(network.created)}
              </td>
              <td className="px-4 py-2.5 text-right">
                {network.is_builtin ? (
                  <span
                    className="text-[11px] text-fg-subtle"
                    title="Docker gestiona esta red y la recrea en cada arranque"
                  >
                    no se puede eliminar
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onDelete(network.name)}
                    disabled={actionInProgress === network.name}
                    className="p-1.5 rounded text-fg-subtle hover:text-red-600 hover:bg-elevated-hover transition-colors disabled:opacity-50"
                    aria-label={`Eliminar red ${network.name}`}
                  >
                    {actionInProgress === network.name ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Trash2 className="w-4 h-4" />
                    )}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
