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
  /**
   * El resultado de la limpieza sube al padre para pintarlo como un cartel de
   * página, igual que los de Imágenes y Volúmenes (SPEC-21).
   *
   * **No se pinta aquí a propósito.** Esta barra vive dentro de la fila del
   * buscador, así que un cartel dentro suyo empieza donde acaba el buscador —a
   * un tercio del ancho, o a media pantalla si la ventana es estrecha— en vez de
   * en el margen izquierdo. Encajado en un hueco estrecho, un mensaje que debería
   * leerse de un vistazo acaba leyéndose a medias.
   *
   * Por eso el aviso no lleva el estado: se manda siempre, con `ok` a true o a
   * false, y el cartel se pinta donde toca. Un fallo en verde se leería como una
   * limpieza hecha.
   */
  onResultado?: (mensaje: string, ok: boolean) => void;
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
export const ContainersToolbar: React.FC<ContainersToolbarProps> = ({
  onDeleted,
  onResultado,
}) => {
  const [open, setOpen] = useState<boolean>(false)
  const [busy, setBusy] = useState<boolean>(false)
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
      onResultado?.(
        r.deleted.length > 0
          ? `${r.message} · ${formatBytes(r.bytes_reclaimed)} recuperados`
          : r.message,
        true
      )
      reload()
      onDeleted()
    } catch (e: unknown) {
      setOpen(false)
      onResultado?.(
        e instanceof Error ? e.message : 'No se pudo limpiar los contenedores',
        false
      )
    } finally {
      setBusy(false)
    }
  }, [onDeleted, onResultado, reload])

  return (
    // Una sola caja, y no un fragmento. `App` monta esta barra dentro de un
    // `flex-row`, y los hijos de un fragmento pasan a ser items de ese padre: un
    // mensaje dentro de la barra quedaba AL LADO del buscador y del botón, se
    // ensanchaba hasta su texto entero y empujaba el ancho de la página. El
    // mensaje ya no va aquí —lo pinta `App` a todo el ancho—, pero la caja se
    // queda: es lo que impide que un hijo futuro vuelva a ser un item suelto de
    // esa fila.
    //
    // Ni `flex-1` ni `sm:w-72`, y los dos estorban. `flex-1` arrastra
    // `flex-basis: 0`, así que dentro de un padre de ancho automático —que es lo
    // que hace `sm:w-auto` en la fila del buscador— se queda sin espacio que
    // repartir y colapsa. `sm:w-72` obligaba a la píldora y al botón a
    // repartirse 18rem y partía el texto de la píldora en varias líneas.
    <div className="flex flex-col gap-2 min-w-0">
      {/* `flex-wrap` para que en un ancho estrecho el botón baje a su línea en vez
          de apretar la píldora, que no se parte nunca. */}
      <div className="flex flex-wrap items-center gap-2">
        {error ? (
          <div
            data-testid="containers-prune-error"
            title={error}
            className="shrink-0 whitespace-nowrap flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-xs text-amber-700 dark:text-amber-400"
          >
            <AlertCircle className="w-3.5 h-3.5" />
            <span>limpieza sin preaviso</span>
          </div>
        ) : (
          preview &&
          preview.stopped_count > 0 && (
            <div
              data-testid="containers-prune-pendiente"
              className="shrink-0 whitespace-nowrap flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-xs text-amber-700 dark:text-amber-400"
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
          className="shrink-0 whitespace-nowrap px-3 py-1.5 bg-elevated hover:bg-fg/10 border border-default text-fg-muted hover:text-fg rounded-xl text-xs font-medium transition-all flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          <Broom className="w-4 h-4" />
          <span className="hidden sm:inline">Limpiar parados</span>
          <span className="sm:hidden">Limpiar</span>
        </button>
      </div>

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
    </div>
  )
}