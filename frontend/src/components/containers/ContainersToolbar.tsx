// SPDX-License-Identifier: AGPL-3.0-or-later
import React, { useCallback, useState } from 'react'
import { AlertCircle, Broom } from 'lucide-react'

import { dockerApi } from '../../services/dockerApi'
import { useContainerPrunePreview } from '../../hooks/usePrune'
import { formatBytes } from '../../utils/format'
import { PruneDialog } from '../ui/PruneDialog'

interface ContainersToolbarProps {
  /** Avisa al padre para que recargue la lista: una limpieza cambia el censo. */
  onDeleted: () => void;
}

/**
 * La limpieza de contenedores parados (SPEC-21).
 *
 * Vive aquí y no en una vista propia porque **la tabla de contenedores no tiene
 * vista**: se renderiza desde `App.tsx`, que ya tiene la barra de filtros. Sacar
 * los contenedores a un componente `ContainersView` es el refactor que
 * arreglaría de paso lo que `agent.md` cuenta de `useContainers` viviendo en
 * `App`, y se lleva por delante siete estados de modales. No hace falta para
 * poner un botón.
 *
 * Lo destructivo de esta acción es concreto y conviene decirlo en el diálogo:
 * un contenedor parado puede tener dentro lo único que hacía que mereciera la
 * pena pararlo, y el prune se lleva su **capa de escritura**.
 */
export const ContainersToolbar: React.FC<ContainersToolbarProps> = ({ onDeleted }) => {
  const [open, setOpen] = useState<boolean>(false)
  const [busy, setBusy] = useState<boolean>(false)
  const [result, setResult] = useState<string | null>(null)
  const {
    preview,
    error,
    reload,
  } = useContainerPrunePreview()

  const run = useCallback(async () => {
    try {
      setBusy(true)
      const r = await dockerApi.pruneContainers()
      setOpen(false)
      setResult(
        r.deleted.length > 0
          ? `${r.message} · ${formatBytes(r.bytes_reclaimed)} recuperados`
          : r.message
      )
      reload()
      onDeleted()
    } catch (e: unknown) {
      setResult(null)
      setOpen(false)
      setResult(e instanceof Error ? e.message : 'No se pudo limpiar los contenedores')
    } finally {
      setBusy(false)
    }
  }, [onDeleted, reload])

  return (
    <>
      <div className="flex items-center gap-2">
        {error ? (
          <div
            data-testid="containers-prune-error"
            title={error}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-xs text-amber-700 dark:text-amber-400"
          >
            <AlertCircle className="w-3.5 h-3.5" />
            <span>limpieza sin preaviso</span>
          </div>
        ) : (
          preview &&
          preview.stopped_count > 0 && (
            <div
              data-testid="containers-prune-pendiente"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-xs text-amber-700 dark:text-amber-400"
            >
              <Broom className="w-3.5 h-3.5" />
              <span className="font-mono">{formatBytes(preview.stopped_bytes)}</span>
              <span>
                en {preview.stopped_count}{' '}
                {preview.stopped_count === 1 ? 'contenedor parado' : 'contenedores parados'}
              </span>
            </div>
          )
        )}

        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={error !== null || !preview || preview.stopped_count === 0}
          title={
            error
              ? 'El daemon no informó del tamaño de los contenedores, así que no se sabe qué se puede limpiar'
              : 'Eliminar los contenedores que están parados, con su capa de escritura'
          }
          className="px-3 py-1.5 bg-elevated hover:bg-fg/10 border border-default text-fg-muted hover:text-fg rounded-xl text-xs font-medium transition-all flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          <Broom className="w-4 h-4" />
          <span className="hidden sm:inline">Limpiar parados</span>
          <span className="sm:hidden">Limpiar</span>
        </button>
      </div>

      {result && (
        <p className="text-xs text-fg-muted mt-1" role="status">
          {result}
        </p>
      )}

      {open && preview && (
        <PruneDialog
          titulo="Limpiar contenedores parados"
          resumen={`Se eliminarán ${preview.stopped_count} contenedor${
            preview.stopped_count === 1 ? '' : 'es'
          } parado${preview.stopped_count === 1 ? '' : 's'}, hasta ${formatBytes(
            preview.stopped_bytes
          )}.`}
          nombres={preview.stopped_names}
          aviso="Se llevan la capa de escritura: lo que se haya escrito dentro del contenedor y no esté en un volumen se pierde. Los que estén en marcha no se tocan."
          etiquetaConfirmar="Eliminar"
          destructivo
          onConfirm={() => void run()}
          onClose={() => setOpen(false)}
          ocupado={busy}
        />
      )}
    </>
  )
}