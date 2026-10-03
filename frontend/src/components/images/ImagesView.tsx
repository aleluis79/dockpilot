// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Box, Download, RefreshCw, AlertCircle, Layers, Search, Broom, Trash2 } from 'lucide-react'
import { dockerApi } from '../../services/dockerApi'
import { DeleteConfirmModal } from '../containers/DeleteConfirmModal'
import { ImagesTable } from './ImagesTable'
import { PullImageModal } from './PullImageModal'
import { ImageDetailModal } from './ImageDetailModal'
import { PruneDialog } from '../ui/PruneDialog'
import { useImagePrunePreview } from '../../hooks/usePrune'
import { esImagenDelPanel } from '../../utils/proteccion'
import { formatBytes } from '../../utils/format'
import type { LocalImageSummary } from '../../types/image'

interface ImagesViewProps {
  onRunImage: (image: LocalImageSummary) => void
  onDeleted: () => void
}

export const ImagesView: React.FC<ImagesViewProps> = ({ onRunImage, onDeleted }) => {
  const [images, setImages] = useState<LocalImageSummary[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionInfo, setActionInfo] = useState<string | null>(null)
  const [kept, setKept] = useState<string[]>([])
  const [isPullOpen, setIsPullOpen] = useState<boolean>(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [toDelete, setToDelete] = useState<LocalImageSummary | null>(null)
  const [query, setQuery] = useState<string>('')
  // SPEC-21: los dos niveles de limpieza, cada uno con su diálogo. El preaviso
  // es del backend y no el `df` del panel: son cosas distintas y confundirlas
  // pondría 4,3 GB junto a un botón que da 769 MB.
  const [pruneDialog, setPruneDialog] = useState<'sin-etiqueta' | 'con-etiqueta' | null>(null)
  const [pruning, setPruning] = useState<boolean>(false)
  const {
    preview: prune,
    error: pruneError,
    reload: reloadPrune,
  } = useImagePrunePreview()

  const loadImages = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      setImages(await dockerApi.getLocalImages())
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'Error desconocido al cargar las imágenes locales'
      )
    } finally {
      setLoading(false)
    }
  }, [])

  const runPrune = useCallback(
    async (allUntagged: boolean) => {
      try {
        setPruning(true)
        setActionError(null)
        setActionInfo(null)
        const result = await dockerApi.pruneImages(allUntagged)
        // Los bytes del nivel agresivo son una estimación (un borrado uno a uno no
        // lleva el dato de "espacio recuperado" del prune), así que ahí no se
        // dice "recuperados": se dice "estimados".
        const verbos = allUntagged ? 'estimados' : 'recuperados'
        setActionInfo(
          result.deleted.length > 0
            ? `${result.message} · ${formatBytes(result.bytes_reclaimed)} ${verbos}`
            : result.message
        )
        // Lo que el daemon no dejó borrar se enseña aparte, y no dentro del
        // mensaje: son datos con nombre y motivo, no un resumen.
        setKept(result.kept ?? [])
        setPruneDialog(null)
        await loadImages()
        // El preaviso es del backend y esta limpieza acaba de cambiar lo que
        // dice, así que se vuelve a pedir: dejarlo sería mostrar un botón que
        // apunta a algo que ya no existe.
        reloadPrune()
        onDeleted()
      } catch (err: unknown) {
        setActionError(err instanceof Error ? err.message : 'No se pudo limpiar las imágenes')
      } finally {
        setPruning(false)
      }
    },
    // Las tres son estables: `loadImages` y `reloadPrune` son `useCallback` con
    // `[]`, y `onDeleted` viene del padre. Por eso este `useCallback` no se
    // recrea y el diálogo no se rearma en cada render.
    [loadImages, reloadPrune, onDeleted]
  )

  // La carga inicial no fuerza `setLoading(true)`: ya parte de `true` y así se
  // evita un setState síncrono en el efecto.
  useEffect(() => {
    let isMounted = true

    const load = async () => {
      try {
        const data = await dockerApi.getLocalImages()
        if (isMounted) {
          setImages(data)
          setError(null)
        }
      } catch (err: unknown) {
        if (isMounted) {
          setError(
            err instanceof Error ? err.message : 'Error desconocido al cargar las imágenes locales'
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

  const handleDelete = async (id: string, force: boolean) => {
    try {
      setActionError(null)
      // `handleDelete` solo recibe el id, y una imagen no tiene proyecto compose:
      // su identidad son los tags. Se buscan en la lista ya cargada, que es de
      // donde sale todo lo que se pinta. Borrar la imagen del panel no lo apaga
      // —eso es el contenedor—, pero deja su siguiente `up` sin poder
      // arrancar, y eso es peor porque no se ve venir (SPEC-00).
      const imagen = images.find((i) => i.id === id)
      const esDelPanel = imagen?.tags.some((t) => esImagenDelPanel(t)) ?? false
      if (esDelPanel) {
        setActionError(
          `«${imagen?.tags.join(', ')}» es la imagen del propio panel. No se puede eliminar desde aquí: el siguiente arranque se quedaría sin ella.`
        )
        return
      }
      const result = await dockerApi.deleteImage(id, force)
      if (result.untagged.length > 0) {
        setActionError(
          `Imagen eliminada. Tags que quedaron sin referenciar: ${result.untagged.join(', ')}`
        )
      }
      await loadImages()
      onDeleted()
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'No se pudo eliminar la imagen')
    }
  }

  const totalSize = images.reduce((acc, image) => acc + image.size, 0)

  // El filtrado es en cliente sobre el inventario ya cargado: no hace falta
  // pedirlo al daemon para que el tecleo responda al instante.
  const term = query.trim().toLowerCase()
  const filteredImages = useMemo(() => {
    if (!term) return images
    return images.filter(
      (image) =>
        image.tags.some((tag) => tag.toLowerCase().includes(term)) ||
        image.id.toLowerCase().includes(term)
    )
  }, [images, term])

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-elevated border border-default text-xs text-fg-muted">
            <Layers className="w-3.5 h-3.5" />
            {term ? (
              <>
                <span className="font-mono">
                  {`${filteredImages.length} de ${images.length}`}
                </span>
                <span>{images.length === 1 ? 'imagen' : 'imágenes'}</span>
              </>
            ) : (
              <>
                <span className="font-mono">{images.length}</span>
                <span>{images.length === 1 ? 'imagen' : 'imágenes'}</span>
              </>
            )}
          </div>
          {totalSize > 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-elevated border border-default text-xs text-fg-muted">
              <Box className="w-3.5 h-3.5" />
              <span className="font-mono">{(totalSize / 1024 ** 3).toFixed(2)} GB</span>
              <span>en disco</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="relative w-full sm:w-64">
            <label htmlFor="images-search" className="sr-only">
              Buscar imágenes
            </label>
            <Search
              className="w-4 h-4 text-fg-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            />
            <input
              id="images-search"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar por tag o ID..."
              className="w-full pl-9 pr-3 py-1.5 text-xs bg-surface border border-default rounded-xl text-fg placeholder-fg-muted focus:outline-none focus:border-blue-500/50 transition-all"
            />
          </div>
          {/* SPEC-21: limpieza. El número es el del PREAVISO, no el del `df`
              del panel: el botón da 769 MB y el `df` dice 4,3 GB, porque el
              `df` cuenta también las imágenes que tienen etiqueta y esta
              acción no las toca. */}
          {pruneError ? (
            <div
              data-testid="images-prune-error"
              title={pruneError}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-xs text-amber-700 dark:text-amber-400"
            >
              <AlertCircle className="w-3.5 h-3.5" />
              <span>limpieza sin preaviso</span>
            </div>
          ) : (
            prune &&
            prune.dangling_count > 0 && (
              <div
                data-testid="images-prune-pendiente"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-xs text-amber-700 dark:text-amber-400"
              >
                <Broom className="w-3.5 h-3.5" />
                <span className="font-mono">{formatBytes(prune.dangling_bytes)}</span>
                <span>sin etiqueta</span>
              </div>
            )
          )}

          <button
            onClick={() => {
              // Los "no se pudieron eliminar" son del intento anterior: se
              // borran al abrir el diálogo, no al cerrarlo, porque el resultado
              // se fija justo antes de cerrar y limpiarlo ahí lo pisaría.
              setKept([])
              setPruneDialog('sin-etiqueta')
            }}
            disabled={pruneError !== null || !prune || prune.dangling_count === 0}
            title={
              pruneError
                ? 'El daemon no informó de las imágenes, así que no se sabe qué se puede limpiar'
                : 'Eliminar imágenes sin etiqueta que no use ningún contenedor'
            }
            className="px-3 py-1.5 bg-elevated hover:bg-fg/10 border border-default text-fg-muted hover:text-fg rounded-xl text-xs font-medium transition-all flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            <Broom className="w-4 h-4" />
            <span className="hidden lg:inline">Limpiar sin etiqueta</span>
            <span className="lg:hidden">Limpiar</span>
          </button>

          <button
            onClick={() => {
              setKept([])
              setPruneDialog('con-etiqueta')
            }}
            disabled={pruneError !== null || !prune || prune.tagged_count === 0}
            title="Eliminar también las imágenes que tienen etiqueta y no usa ningún contenedor. Habrá que volver a descargarlas."
            className="px-3 py-1.5 bg-elevated hover:bg-fg/10 border border-default text-fg-muted hover:text-fg rounded-xl text-xs font-medium transition-all flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            <Trash2 className="w-4 h-4" />
            <span className="hidden lg:inline">quitar también las que tienen etiqueta</span>
            <span className="lg:hidden">todas</span>
          </button>

          <button
            onClick={() => setIsPullOpen(true)}
            className="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-medium transition-all shadow-lg shadow-blue-500/20 flex items-center gap-1.5 cursor-pointer"
          >
            <Download className="w-4 h-4" />
            <span>Descargar imagen</span>
          </button>
          <button
            onClick={loadImages}
            disabled={loading}
            title="Actualizar inventario de imágenes"
            className="p-2 text-fg-muted hover:text-fg bg-elevated hover:bg-fg/10 border border-default rounded-xl transition-all disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-blue-500' : ''}`} />
          </button>
        </div>
      </div>

      {prune && prune.in_use_dangling > 0 && (
        <div
          data-testid="images-prune-en-uso"
          className="flex items-center gap-2 px-3 py-2 bg-inset border border-default rounded-xl text-xs text-fg-muted"
        >
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>
            Hay <span className="font-mono">{prune.in_use_dangling}</span> imagen
            {prune.in_use_dangling === 1 ? '' : 'es'} sin etiqueta que un contenedor está
            usando. No se pueden eliminar.
          </span>
        </div>
      )}

      {actionInfo && (
        <div className="flex items-center justify-between p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-700 dark:text-emerald-400 rounded-xl text-xs">
          <span>{actionInfo}</span>
          <button
            onClick={() => setActionInfo(null)}
            className="shrink-0 px-2 py-0.5 rounded bg-emerald-500/20 text-xs font-semibold"
          >
            Descartar
          </button>
        </div>
      )}

      {/* Lo que el daemon no dejó borrar. Un bucle puede fallar a medias, y sin
          esto el usuario creería que se han borrado todas. */}
      {kept.length > 0 && (
        <div
          data-testid="images-prune-kept"
          className="p-3 bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-400 rounded-xl text-xs"
        >
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <span>
                {kept.length === 1
                  ? 'Esta imagen no se pudo eliminar y sigue ahí:'
                  : 'Estas imágenes no se pudieron eliminar y siguen ahí:'}
              </span>
              <ul className="mt-1 space-y-0.5">
                {kept.map((k) => (
                  <li key={k} className="font-mono break-all">
                    {k}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {actionError && (
        <div className="flex items-center justify-between p-3 bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-400 rounded-xl text-xs">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{actionError}</span>
          </div>
          <button
            onClick={() => setActionError(null)}
            className="shrink-0 px-2 py-0.5 rounded bg-amber-500/20 text-xs font-semibold"
          >
            Descartar
          </button>
        </div>
      )}

      {pruneDialog === 'sin-etiqueta' && prune && (
        <PruneDialog
          titulo="Limpiar imágenes sin etiqueta"
          resumen={`Se eliminarán ${prune.dangling_count} imagen${
            prune.dangling_count === 1 ? '' : 'es'
          } sin etiqueta y sin uso, hasta ${formatBytes(prune.dangling_bytes)}.`}
          nombres={prune.dangling_ids}
          etiquetaConfirmar="Limpiar"
          onConfirm={() => void runPrune(false)}
          onClose={() => setPruneDialog(null)}
          ocupado={pruning}
        />
      )}

      {pruneDialog === 'con-etiqueta' && prune && (
        <PruneDialog
          titulo="Quitar también las imágenes con etiqueta"
          resumen={`Se eliminarán ${prune.tagged_count} imagen${
            prune.tagged_count === 1 ? '' : 'es'
          } con etiqueta que ningún contenedor usa, hasta ${formatBytes(prune.tagged_bytes)}.`}
          nombres={prune.tagged_refs}
          aviso="Las imágenes con etiqueta habrá que volver a descargarlas la próxima vez que alguien las pida. No hay forma de recuperarlas desde aquí."
          etiquetaConfirmar="Quitar también"
          destructivo
          onConfirm={() => void runPrune(true)}
          onClose={() => setPruneDialog(null)}
          ocupado={pruning}
        />
      )}

      <ImagesTable
        images={filteredImages}
        loading={loading}
        error={error}
        onRefresh={loadImages}
        onRun={onRunImage}
        onInspect={(image) => setDetailId(image.tags[0] ?? image.id)}
        onRequestDelete={(image) => setToDelete(image)}
        emptyMessage={
          term ? `Ninguna imagen coincide con "${query.trim()}"` : 'No hay imágenes locales'
        }
        emptyHint={
          term
            ? 'Prueba con otro tag o borra la búsqueda'
            : 'Descarga una imagen para poder crear contenedores con ella'
        }
      />

      <PullImageModal
        isOpen={isPullOpen}
        onClose={() => setIsPullOpen(false)}
        onPulled={() => {
          loadImages()
          onDeleted()
        }}
        localImages={images}
      />

      <ImageDetailModal imageId={detailId} onClose={() => setDetailId(null)} />

      {toDelete && (
        <DeleteConfirmModal
          container={null}
          target={{ id: toDelete.tags[0] ?? toDelete.id, name: toDelete.tags[0] ?? toDelete.id }}
          title="¿Eliminar imagen?"
          description={
            <>
              Estás a punto de eliminar la imagen{' '}
              <span className="font-semibold text-fg font-mono">
                {toDelete.tags[0] ?? toDelete.id}
              </span>
              . Esta acción no se puede deshacer.
            </>
          }
          warning={
            toDelete.containers > 0 ? (
              <>
                La imagen la usan{' '}
                <span className="font-semibold">{toDelete.containers}</span>{' '}
                {toDelete.containers === 1 ? 'contenedor' : 'contenedores'}. Para eliminarla debes
                marcar la eliminación forzada, lo que puede dejar contenedores sin imagen.
              </>
            ) : null
          }
          forceLabel={
            <>
              Forzar eliminación (
              <code className="font-mono text-rose-700 dark:text-rose-400">force=true</code>)
            </>
          }
          onClose={() => setToDelete(null)}
          onConfirm={handleDelete}
        />
      )}
    </div>
  )
}
