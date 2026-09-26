import { useCallback, useEffect, useMemo, useState } from 'react'
import { Box, Download, RefreshCw, AlertCircle, Layers, Search } from 'lucide-react'
import { dockerApi } from '../../services/dockerApi'
import { DeleteConfirmModal } from '../containers/DeleteConfirmModal'
import { ImagesTable } from './ImagesTable'
import { PullImageModal } from './PullImageModal'
import { ImageDetailModal } from './ImageDetailModal'
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
  const [isPullOpen, setIsPullOpen] = useState<boolean>(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [toDelete, setToDelete] = useState<LocalImageSummary | null>(null)
  const [query, setQuery] = useState<string>('')

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
