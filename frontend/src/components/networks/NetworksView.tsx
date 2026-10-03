// SPDX-License-Identifier: AGPL-3.0-or-later
import React, { useState } from 'react'
import {
  Search,
  Plus,
  Trash2,
  AlertCircle,
  Loader2,
  Network as NetworkIcon,
  Broom,
  Eraser,
} from 'lucide-react'
import { esRedDelPanel } from '../../utils/proteccion'
import { useNetworks } from '../../hooks/useNetworks'
import { NetworksTable } from './NetworksTable'
import { NetworkDetailModal } from './NetworkDetailModal'
import { CreateNetworkModal } from './CreateNetworkModal'
import { MODAL_OVERLAY } from '../ui/modalOverlay'
import type { NetworkFilter } from '../../hooks/useNetworks'

const FILTERS: { label: string; value: NetworkFilter }[] = [
  { label: 'Todas', value: 'all' },
  { label: 'En uso', value: 'in-use' },
  { label: 'No usadas', value: 'unused' },
  { label: 'Predefinidas', value: 'builtin' },
]

export const NetworksView: React.FC = () => {
  const {
    visibleNetworks,
    counts,
    loading,
    error,
    filter,
    setFilter,
    searchQuery,
    setSearchQuery,
    actionInProgress,
    deleteNetwork,
    pruneNetworks,
    createNetwork,
  } = useNetworks()

  const [selectedNetwork, setSelectedNetwork] = useState<string | null>(null)
  const [networkToDelete, setNetworkToDelete] = useState<string | null>(null)
  const [pruneOpen, setPruneOpen] = useState<boolean>(false)
  const [createOpen, setCreateOpen] = useState<boolean>(false)
  const [notice, setNotice] = useState<string | null>(null)

  const handleDelete = async () => {
    if (!networkToDelete) return
    const name = networkToDelete
    // Borrar la red del panel lo deja sin red, que es el mismo punto ciego que
    // borrar su contenedor: el servicio sigue levantado pero ya no habla con
    // nadie. Se comprueba aquí y no solo en la tabla porque el diálogo de
    // confirmación es el otro camino (SPEC-00).
    if (esRedDelPanel(name)) {
      setNetworkToDelete(null)
      setNotice(`'${name}' es la red del propio panel y no se puede eliminar desde aquí`)
      return
    }
    const ok = await deleteNetwork(name)
    setNetworkToDelete(null)
    if (ok) setNotice(`Red '${name}' eliminada`)
  }

  const handlePrune = async () => {
    const result = await pruneNetworks()
    setPruneOpen(false)
    if (result) setNotice(result.message)
  }

  const handleCreated = () => {
    setCreateOpen(false)
    setNotice('Red creada')
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-fg flex items-center gap-2">
            <NetworkIcon className="w-5 h-5" />
            Redes
          </h2>
          <p className="text-xs text-fg-subtle mt-0.5">
            {counts.total} redes · {counts.inUse} en uso · {counts.builtin} predefinidas
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Mismas clases que el boton de limpieza de volumenes: el patron
              de aviso de limpieza es el mismo en toda la aplicacion.
              `tests/components/pruneButton.test.tsx` lo fija. */}
          <button
            type="button"
            onClick={() => setPruneOpen(true)}
            disabled={counts.unused === 0 || actionInProgress === '__prune__'}
            title="Limpiar redes no usadas"
            className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer shrink-0"
          >
            {actionInProgress === '__prune__' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Eraser className="w-4 h-4" />
            )}
            <span>Limpiar no usadas</span>
          </button>
          {/* Mismas clases que "Nuevo Contenedor" y "Descargar imagen": el
              patron de accion principal ya estaba fijado en la aplicacion.
              `tests/components/actionButtonStyles.test.tsx` lo vigila. */}
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-medium transition-all shadow-lg shadow-blue-500/20 flex items-center gap-1.5 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>Nueva Red</span>
          </button>
        </div>
      </div>

      {notice && (
        <div className="flex items-center justify-between gap-3 p-2.5 bg-elevated border border-default rounded-lg text-xs text-fg">
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="text-fg-subtle hover:text-fg"
          >
            Descartar
          </button>
        </div>
      )}

      {error && (
        <div role="alert" className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-700 dark:text-red-300">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => {
          const count =
            f.value === 'all'
              ? counts.total
              : f.value === 'in-use'
                ? counts.inUse
                : f.value === 'unused'
                  ? counts.unused
                  : counts.builtin
          return (
            <button
              key={f.value}
              type="button"
              onClick={() => setFilter(f.value)}
              aria-pressed={filter === f.value}
              className={`px-2.5 py-1 text-xs rounded transition-colors ${
                filter === f.value
                  ? 'bg-blue-600 text-white'
                  : 'bg-elevated text-fg-subtle hover:text-fg'
              }`}
            >
              {f.label} ({count})
            </button>
          )
        })}

        {/* Mismas clases que los buscadores de volumenes e imagenes, incluida
            la etiqueta oculta para lectores de pantalla.
            `tests/components/actionButtonStyles.test.tsx` lo vigila. */}
        <div className="relative w-full sm:w-56 ml-auto">
          <label htmlFor="networks-search" className="sr-only">
            Buscar redes
          </label>
          <Search className="w-4 h-4 text-fg-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            id="networks-search"
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Buscar por nombre..."
            className="w-full pl-9 pr-3 py-1.5 text-xs bg-surface border border-default rounded-xl text-fg placeholder-fg-muted focus:outline-none focus:border-blue-500/50 transition-all"
          />
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-fg-subtle text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Cargando redes...
        </div>
      ) : (
        <NetworksTable
          networks={visibleNetworks}
          onSelect={setSelectedNetwork}
          onDelete={setNetworkToDelete}
          actionInProgress={actionInProgress}
        />
      )}

      <NetworkDetailModal
        name={selectedNetwork}
        onClose={() => setSelectedNetwork(null)}
      />

      {createOpen && (
        <CreateNetworkModal
          onClose={() => setCreateOpen(false)}
          onCreate={createNetwork}
          onCreated={handleCreated}
        />
      )}

      {networkToDelete && (
        <div className={MODAL_OVERLAY} onClick={() => setNetworkToDelete(null)}>
          <div
            className="bg-surface border border-default rounded-lg w-full max-w-md p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Confirmar eliminación de red"
          >
            <div className="flex items-start gap-3">
              <Trash2 className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-fg">
                  Eliminar la red {networkToDelete}
                </h3>
                <p className="text-xs text-fg-subtle mt-1">
                  La red y su configuración IPAM se eliminan. No se puede deshacer.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button
                type="button"
                onClick={() => setNetworkToDelete(null)}
                className="px-3 py-1.5 text-sm rounded text-fg-subtle hover:text-fg hover:bg-elevated-hover transition-colors"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleDelete}
                className="px-3 py-1.5 text-sm rounded bg-red-600 text-white hover:opacity-90 transition-opacity"
              >
                Eliminar
              </button>
            </div>
          </div>
        </div>
      )}

      {pruneOpen && (
        <div className={MODAL_OVERLAY} onClick={() => setPruneOpen(false)}>
          <div
            className="bg-surface border border-default rounded-lg w-full max-w-md p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Limpiar redes sin uso"
          >
            <div className="flex items-start gap-3">
              <Broom className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <h3 className="text-sm font-semibold text-fg">
                  Limpiar redes sin uso
                </h3>
                <p className="text-xs text-fg-subtle mt-1">
                  Se eliminarán {counts.unused}{' '}
                  {counts.unused === 1 ? 'red sin contenedores' : 'redes sin contenedores'}{' '}
                  conectados. Las predefinidas de Docker no se tocan.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button
                type="button"
                onClick={() => setPruneOpen(false)}
                className="px-3 py-1.5 text-sm rounded text-fg-subtle hover:text-fg hover:bg-elevated-hover transition-colors"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handlePrune}
                className="px-3 py-1.5 text-sm rounded bg-amber-600 text-white hover:opacity-90 transition-opacity"
              >
                Limpiar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
