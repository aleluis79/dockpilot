// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Eraser, HardDrive, RefreshCw, Search, Trash2, X } from 'lucide-react'
import { MODAL_OVERLAY } from '../ui/modalOverlay'
import { dockerApi } from '../../services/dockerApi'
import type { UnusedVolumesSummary } from '../../services/dockerApi'
import { formatBytes } from '../../utils/format'
import { VolumesTable } from './VolumesTable'
import { VolumeDetailModal } from './VolumeDetailModal'
import type { VolumeSummary } from '../../types/volume'

interface VolumesViewProps {
  onDeleted: () => void
}

type Filter = 'all' | 'in-use' | 'unused' | 'anonymous'

const FILTERS: ReadonlyArray<{ key: Filter; label: string }> = [
  { key: 'all', label: 'Todos' },
  { key: 'in-use', label: 'En uso' },
  { key: 'unused', label: 'No usados' },
  { key: 'anonymous', label: 'Anónimos' },
]

export const VolumesView = ({ onDeleted }: VolumesViewProps) => {
  const [volumes, setVolumes] = useState<VolumeSummary[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionInfo, setActionInfo] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState<string>('')
  const [detailName, setDetailName] = useState<string | null>(null)
  const [toDelete, setToDelete] = useState<VolumeSummary | null>(null)
  const [unused, setUnused] = useState<UnusedVolumesSummary | null>(null)
  const [isPruneOpen, setIsPruneOpen] = useState<boolean>(false)
  const [pruning, setPruning] = useState<boolean>(false)

  const loadVolumes = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const [list, summary] = await Promise.all([
        dockerApi.getVolumes(),
        dockerApi.getUnusedVolumesSummary(),
      ])
      setVolumes(list)
      setUnused(summary)
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'Error desconocido al cargar los volúmenes'
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let isMounted = true

    const load = async () => {
      try {
        const [list, summary] = await Promise.all([
          dockerApi.getVolumes(),
          dockerApi.getUnusedVolumesSummary(),
        ])
        if (isMounted) {
          setVolumes(list)
          setUnused(summary)
          setError(null)
        }
      } catch (err: unknown) {
        if (isMounted) {
          setError(
            err instanceof Error ? err.message : 'Error desconocido al cargar los volúmenes'
          )
        }
      } finally {
        if (isMounted) setLoading(false)
      }
    }

    load()

    return () => {
      isMounted = false
    }
  }, [])

  const term = query.trim().toLowerCase()

  const filteredVolumes = useMemo(() => {
    return volumes.filter((volume) => {
      const matchesTerm = !term || volume.name.toLowerCase().includes(term)
      if (!matchesTerm) return false
      if (filter === 'in-use') return volume.ref_count > 0
      if (filter === 'unused') return volume.ref_count === 0
      if (filter === 'anonymous') return volume.is_anonymous
      return true
    })
  }, [volumes, filter, term])

  const totalSize = volumes.reduce((acc, volume) => acc + volume.size, 0)
  const anonymousCount = volumes.filter((volume) => volume.is_anonymous).length

  const handleDelete = async (name: string, force: boolean) => {
    try {
      setActionError(null)
      setActionInfo(null)
      await dockerApi.deleteVolume(name, force)
      await loadVolumes()
      onDeleted()
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'No se pudo eliminar el volumen')
    }
  }

  const handlePrune = async () => {
    try {
      setPruning(true)
      setActionError(null)
      const result = await dockerApi.pruneVolumes()
      setActionInfo(
        result.deleted.length > 0
          ? `${result.message} · ${formatBytes(result.bytes_reclaimed)} recuperados`
          : result.message
      )
      setIsPruneOpen(false)
      await loadVolumes()
      onDeleted()
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'No se pudo limpiar los volúmenes')
    } finally {
      setPruning(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 flex-wrap">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-elevated border border-default text-xs text-fg-muted">
            <HardDrive className="w-3.5 h-3.5" />
            <span className="font-mono">{volumes.length}</span>
            <span>{volumes.length === 1 ? 'volumen' : 'volúmenes'}</span>
          </div>
          {totalSize > 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-elevated border border-default text-xs text-fg-muted">
              <span className="font-mono">{formatBytes(totalSize)}</span>
              <span>ocupados</span>
            </div>
          )}
          {anonymousCount > 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-elevated border border-default text-xs text-fg-muted">
              <span className="font-mono">{anonymousCount}</span>
              <span>anónimos</span>
            </div>
          )}
          {unused && unused.count > 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-xs text-amber-700 dark:text-amber-400">
              <span className="font-mono">{formatBytes(unused.bytes)} recuperables</span>
              <span className="font-mono">
                {unused.count} {unused.count === 1 ? 'volumen sin uso' : 'volúmenes sin uso'}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="relative w-full sm:w-56">
            <label htmlFor="volumes-search" className="sr-only">
              Buscar volúmenes
            </label>
            <Search className="w-4 h-4 text-fg-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              id="volumes-search"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar por nombre..."
              className="w-full pl-9 pr-3 py-1.5 text-xs bg-surface border border-default rounded-xl text-fg placeholder-fg-muted focus:outline-none focus:border-blue-500/50 transition-all"
            />
          </div>
          <button
            type="button"
            onClick={() => setIsPruneOpen(true)}
            disabled={!unused || unused.count === 0}
            title="Limpiar volúmenes no usados"
            className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer shrink-0"
          >
            <Eraser className="w-4 h-4" />
            <span>Limpiar no usados</span>
          </button>
          <button
            type="button"
            onClick={loadVolumes}
            disabled={loading}
            title="Actualizar inventario de volúmenes"
            className="p-2 text-fg-muted hover:text-fg bg-elevated hover:bg-fg/10 border border-default rounded-xl transition-all disabled:opacity-50 cursor-pointer shrink-0"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-blue-500' : ''}`} />
          </button>
        </div>
      </div>

      {/* Filtros de estado: solo aplican a volúmenes */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        {FILTERS.map((option) => {
          const active = filter === option.key
          const count =
            option.key === 'in-use'
              ? volumes.filter((v) => v.ref_count > 0).length
              : option.key === 'unused'
                ? volumes.filter((v) => v.ref_count === 0).length
                : option.key === 'anonymous'
                  ? anonymousCount
                  : volumes.length
          return (
            <button
              key={option.key}
              onClick={() => setFilter(option.key)}
              aria-pressed={active}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-all flex items-center gap-2 shrink-0 cursor-pointer ${
                active
                  ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20'
                  : 'bg-surface text-fg-muted hover:text-fg hover:bg-fg/10 border border-default/80'
              }`}
            >
              <span>{option.label}</span>
              <span
                className={`px-1.5 py-0.2 rounded-full text-[10px] ${
                  active ? 'bg-blue-700 text-blue-100' : 'bg-elevated text-fg-muted'
                }`}
              >
                {count}
              </span>
            </button>
          )
        })}
      </div>

      {actionError && (
        <div className="flex items-center justify-between p-3 bg-rose-500/10 border border-rose-500/20 text-rose-700 dark:text-rose-400 rounded-xl text-xs">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{actionError}</span>
          </div>
          <button
            onClick={() => setActionError(null)}
            className="shrink-0 px-2 py-0.5 rounded bg-rose-500/20 text-xs font-semibold cursor-pointer"
          >
            Descartar
          </button>
        </div>
      )}

      {actionInfo && (
        <div className="flex items-center justify-between p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-700 dark:text-emerald-400 rounded-xl text-xs">
          <span>{actionInfo}</span>
          <button
            onClick={() => setActionInfo(null)}
            className="shrink-0 px-2 py-0.5 rounded bg-emerald-500/20 text-xs font-semibold cursor-pointer"
          >
            Descartar
          </button>
        </div>
      )}

      <VolumesTable
        volumes={filteredVolumes}
        loading={loading}
        error={error}
        onRefresh={loadVolumes}
        onInspect={(volume) => setDetailName(volume.name)}
        onRequestDelete={(volume) => setToDelete(volume)}
      />

      <VolumeDetailModal name={detailName} onClose={() => setDetailName(null)} />

      {toDelete && (
        <DeleteVolumeDialog
          volume={toDelete}
          onClose={() => setToDelete(null)}
          onConfirm={handleDelete}
        />
      )}

      {isPruneOpen && unused && (
        <div className={`${MODAL_OVERLAY} p-4`} onClick={() => setIsPruneOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Limpiar volúmenes no usados"
            className="w-full max-w-md bg-surface border border-default rounded-2xl shadow-2xl overflow-hidden p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <div className="p-3 bg-amber-500/10 text-amber-700 dark:text-amber-400 rounded-xl border border-amber-500/20">
                <Eraser className="w-6 h-6" />
              </div>
              <button
                type="button"
                onClick={() => setIsPruneOpen(false)}
                title="Cerrar"
                className="p-1.5 text-fg-muted hover:text-fg hover:bg-fg/10 rounded-lg transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <h3 className="text-lg font-semibold text-fg mb-2">
              Limpiar volúmenes no usados
            </h3>
            <p className="text-sm text-fg-muted mb-4">
              Se eliminarán{' '}
              <span className="font-semibold text-fg">
                {unused.count} {unused.count === 1 ? 'volumen' : 'volúmenes'}
              </span>{' '}
              que ningún contenedor está usando, liberando{' '}
              <span className="font-semibold text-fg">{formatBytes(unused.bytes)}</span>.
            </p>

            <div className="p-3 mb-4 bg-rose-500/10 border border-rose-500/20 rounded-xl text-xs text-rose-700 dark:text-rose-400">
              Los datos de estos volúmenes se borran de forma irreversible. Los volúmenes en uso
              nunca se tocan.
            </div>

            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setIsPruneOpen(false)}
                title="Cancelar limpieza de volúmenes"
                className="px-4 py-2 text-sm font-medium text-fg bg-elevated hover:bg-fg/10 rounded-xl transition-colors cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handlePrune}
                disabled={pruning}
                title="Confirmar limpieza de volúmenes"
                className="px-4 py-2 text-sm font-medium text-white bg-amber-600 hover:bg-amber-500 disabled:opacity-50 rounded-xl transition-colors flex items-center gap-2 cursor-pointer"
              >
                <Trash2 className="w-4 h-4" />
                Limpiar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

interface DeleteVolumeDialogProps {
  volume: VolumeSummary
  onClose: () => void
  onConfirm: (name: string, force: boolean) => void
}

const DeleteVolumeDialog = ({ volume, onClose, onConfirm }: DeleteVolumeDialogProps) => {
  const [force, setForce] = useState<boolean>(false)
  const label = volume.is_anonymous ? `${volume.name.slice(0, 12)}… (anónimo)` : volume.name

  return (
    <div className={`${MODAL_OVERLAY} p-4`} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Eliminar volumen"
        className="w-full max-w-md bg-surface border border-default rounded-2xl shadow-2xl overflow-hidden p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="p-3 bg-rose-500/10 text-rose-700 dark:text-rose-400 rounded-xl border border-rose-500/20">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-fg-muted hover:text-fg hover:bg-fg/10 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <h3 className="text-lg font-semibold text-fg mb-2">¿Eliminar volumen?</h3>
        <p className="text-sm text-fg-muted mb-4">
          Estás a punto de eliminar el volumen{' '}
          <span className="font-mono text-fg break-all">{label}</span> (
          {formatBytes(volume.size)}).
        </p>

        <div className="p-3 mb-4 bg-rose-500/10 border border-rose-500/20 rounded-xl text-xs text-rose-700 dark:text-rose-400">
          {volume.is_anonymous ? (
            <>
              Es un volumen <strong>anónimo</strong>: Docker lo creó sin nombre y no puedes
              identificar su contenido. Sus datos <strong>no se puede recuperar</strong> una vez
              eliminado.
            </>
          ) : (
            <>
              Los datos que contiene <strong>no se pueden recuperar</strong> después de eliminarlo.
            </>
          )}
        </div>

        {volume.ref_count > 0 && (
          <div className="p-3 mb-4 bg-amber-500/10 border border-amber-500/20 rounded-xl text-xs text-amber-700 dark:text-amber-300">
            {volume.ref_count}{' '}
            {volume.ref_count === 1 ? 'contenedor lo está usando' : 'contenedores lo están usando'}.
            Para eliminarlo debes marcar la eliminación forzada.
          </div>
        )}

        <label className="flex items-center gap-2 mb-6 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
            className="w-4 h-4 rounded border-strong bg-elevated text-rose-700 dark:text-rose-500 focus:ring-rose-500/30"
          />
          <span className="text-xs text-fg">
            Forzar eliminación (
            <code className="font-mono text-rose-700 dark:text-rose-400">force=true</code>)
          </span>
        </label>

        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-fg bg-elevated hover:bg-fg/10 rounded-xl transition-colors cursor-pointer"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => {
              onConfirm(volume.name, force)
              onClose()
            }}
            className="px-4 py-2 text-sm font-medium text-white bg-rose-600 hover:bg-rose-500 rounded-xl transition-colors flex items-center gap-2 cursor-pointer"
          >
            <Trash2 className="w-4 h-4" />
            Eliminar
          </button>
        </div>
      </div>
    </div>
  )
}
