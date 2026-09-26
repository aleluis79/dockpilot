import React, { useEffect, useState } from 'react'
import { Search, Download, X, CheckCircle2, AlertCircle, Loader2, Star, HardDrive } from 'lucide-react'
import { MODAL_OVERLAY } from '../ui/modalOverlay'
import { useImagePull } from '../../hooks/useImagePull'
import { dockerApi, isValidImageRef } from '../../services/dockerApi'
import { formatBytes } from '../../utils/format'
import type { ImageLayerState, ImageSearchResult, LocalImageSummary } from '../../types/image'

interface PullImageModalProps {
  isOpen: boolean
  onClose: () => void
  onPulled: (tags: string[]) => void
  /** Imágenes ya presentes en el host, para señalarlas en las alternativas. */
  localImages?: LocalImageSummary[]
}

type Phase = 'search' | 'downloading'

const STATE_STYLES: Record<ImageLayerState, { bar: string; label: string }> = {
  pending: { bar: 'bg-elevated', label: 'text-fg-subtle' },
  downloading: { bar: 'bg-blue-500', label: 'text-blue-600 dark:text-blue-400' },
  extracting: { bar: 'bg-amber-500', label: 'text-amber-700 dark:text-amber-400' },
  done: { bar: 'bg-emerald-500', label: 'text-emerald-700 dark:text-emerald-400' },
}

const STATE_LABELS: Record<ImageLayerState, string> = {
  pending: 'En espera',
  downloading: 'Descargando',
  extracting: 'Extrayendo',
  done: 'Completa',
}

/** Añade `:latest` si la referencia no lleva tag ni digest, igual que el backend. */
const withDefaultTag = (ref: string): string => {
  if (ref.includes('@sha256:')) return ref
  return ref.includes(':') ? ref : `${ref}:latest`
}

export const PullImageModal: React.FC<PullImageModalProps> = ({
  isOpen,
  onClose,
  onPulled,
  localImages = [],
}) => {
  const [reference, setReference] = useState<string>('')
  const [phase, setPhase] = useState<Phase>('search')
  const [results, setResults] = useState<ImageSearchResult[]>([])
  const [searching, setSearching] = useState<boolean>(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [hasSearched, setHasSearched] = useState<boolean>(false)

  const trimmed = reference.trim()
  const valid = trimmed.length > 0 && isValidImageRef(trimmed)
  const selectedRef = phase === 'downloading' ? trimmed : null

  const { status, layers, digest, error, current, total, reset } = useImagePull(selectedRef, {
    onComplete: onPulled,
  })

  const isDone = status === 'success'

  /**
   * Una alternativa está en local si algún tag local coincide con su nombre
   * o con su variante `:latest`, que es como Docker Hub la nombra.
   */
  const isLocal = (name: string): boolean => {
    const candidates = [name, withDefaultTag(name)]
    return localImages.some((image) => image.tags.some((tag) => candidates.includes(tag)))
  }

  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  // Volver a abrir el modal reinicia todo su estado
  useEffect(() => {
    if (!isOpen) {
      setReference('')
      setPhase('search')
      setResults([])
      setSearchError(null)
      setHasSearched(false)
      setSearching(false)
      reset()
    }
  }, [isOpen, reset])

  if (!isOpen) return null

  /** Cualquier cambio de intención aborta la descarga en curso. */
  const abandonDownload = () => {
    reset()
    setPhase('search')
    setResults([])
    setHasSearched(false)
    setSearchError(null)
  }

  const handleEdit = (value: string) => {
    setReference(value)
    if (phase === 'downloading') abandonDownload()
  }

  const handleSearch = async () => {
    if (!valid || searching) return
    // Buscar de nuevo cambia de intención: la descarga en curso se descarta.
    if (phase === 'downloading') abandonDownload()
    setSearching(true)
    setSearchError(null)
    try {
      const found = await dockerApi.searchImages(trimmed, 10)
      setResults(found)
      setHasSearched(true)
    } catch (err: unknown) {
      setResults([])
      setHasSearched(false)
      setSearchError(
        err instanceof Error ? err.message : 'Error desconocido al buscar imágenes'
      )
    } finally {
      setSearching(false)
    }
  }

  const startPull = (referenceToPull: string) => {
    setReference(referenceToPull)
    setPhase('downloading')
  }

  const handleClose = () => {
    reset()
    onClose()
  }

  // Sin total informado por el daemon no hay porcentaje que calcular: se
  // muestran bytes para no pintar un NaN.
  const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : null

  // Solo hay algo que cancelar mientras la descarga está en curso. Cuando
  // termina (con éxito o con error) la acción principal pasa a ser cerrar.
  const isPullingNow = phase === 'downloading' && status === 'pulling'

  return (
    <div className={`${MODAL_OVERLAY} p-4`} onClick={handleClose}>
      <div
        className="w-full max-w-lg bg-surface border border-default rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 flex items-center justify-between p-4 border-b border-default">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-xl border border-blue-500/20">
              <Download className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-fg">Descargar imagen</h2>
              <p className="text-[11px] text-fg-muted">
                {phase === 'search'
                  ? 'Busca una imagen y elige cuál descargar'
                  : 'Descargando desde el registro'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            title="Cerrar descarga de imagen"
            className="p-1.5 text-fg-muted hover:text-fg hover:bg-fg/10 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Fase 1: entrada de texto + búsqueda. Escribir no dispara nada. */}
          <div>
            <label
              htmlFor="image-ref"
              className="block text-xs uppercase tracking-wider font-semibold text-fg-muted mb-1.5"
            >
              Referencia de imagen
            </label>
            <div className="flex items-center gap-2">
              <input
                id="image-ref"
                type="text"
                value={reference}
                onChange={(e) => handleEdit(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && valid) handleSearch()
                }}
                placeholder="nginx"
                className="flex-1 min-w-0 px-3.5 py-2 text-xs font-mono bg-inset border border-default rounded-xl text-fg placeholder:text-fg-subtle focus:outline-none focus:border-blue-500/50"
              />
              <button
                type="button"
                onClick={handleSearch}
                disabled={!valid || searching}
                className="shrink-0 px-3 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl transition-colors flex items-center gap-1.5"
              >
                {searching ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Search className="w-3.5 h-3.5" />
                )}
                <span>Buscar</span>
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-fg-subtle">
              Formato esperado: <code className="font-mono">repo</code>,{' '}
              <code className="font-mono">repo:tag</code> o{' '}
              <code className="font-mono">localhost:5000/app:dev</code>
            </p>
            {trimmed.length > 0 && !valid && (
              <p className="mt-1 text-[11px] text-rose-700 dark:text-rose-400">
                Referencia no válida. Sin tag se descargará{' '}
                <code className="font-mono">latest</code>.
              </p>
            )}
          </div>

          {searchError && (
            <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-700 dark:text-rose-400 rounded-xl text-xs flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
              <span>{searchError}</span>
            </div>
          )}

          {/* Fase 2: progreso de la descarga */}
          {phase === 'downloading' && (
            <>
              {error && (
                <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-700 dark:text-rose-400 rounded-xl text-xs flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
                  <span>{error}</span>
                </div>
              )}

              {isDone && (
                <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-700 dark:text-emerald-400 rounded-xl text-xs flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-px" />
                  <span>
                    Imagen descargada correctamente
                    {digest && (
                      <>
                        {' '}
                        (<span className="font-mono">{digest.slice(0, 19)}</span>)
                      </>
                    )}
                    . Ya está disponible para crear contenedores.
                  </span>
                </div>
              )}

              {layers.length > 0 ? (
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between text-[11px] text-fg-muted">
                    <span className="flex items-center gap-1.5">
                      {status === 'pulling' && <Loader2 className="w-3 h-3 animate-spin" />}
                      {isDone ? 'Completado' : 'Descargando capas'}
                    </span>
                    <span className="font-mono">
                      {percent !== null ? (
                        <>
                          {formatBytes(current)} / {formatBytes(total)} ({percent}%)
                        </>
                      ) : (
                        formatBytes(current)
                      )}
                    </span>
                  </div>

                  {layers.map((layer) => {
                    const layerPercent =
                      layer.total > 0
                        ? Math.min(100, Math.round((layer.current / layer.total) * 100))
                        : layer.state === 'done'
                          ? 100
                          : 0
                    const style = STATE_STYLES[layer.state]

                    return (
                      <div key={layer.id} className="space-y-1">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="font-mono text-fg-muted truncate max-w-[60%]">
                            {layer.id}
                          </span>
                          <span className={style.label}>
                            {STATE_LABELS[layer.state]}
                            {layer.total > 0 && (
                              <span className="text-fg-subtle ml-1.5 font-mono">
                                {formatBytes(layer.current)} / {formatBytes(layer.total)}
                              </span>
                            )}
                          </span>
                        </div>
                        <div
                          role="progressbar"
                          aria-label={`Progreso de la capa ${layer.id}`}
                          aria-valuenow={layerPercent}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          className="h-1.5 w-full bg-elevated rounded-full overflow-hidden"
                        >
                          <div
                            className={`h-full rounded-full transition-all duration-300 ${style.bar}`}
                            style={{ width: `${layerPercent}%` }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                !error &&
                !isDone && (
                  <p className="text-xs text-fg-subtle text-center py-3">
                    Conectando con el registro...
                  </p>
                )
              )}
            </>
          )}

          {/* Alternativas encontradas */}
          {phase === 'search' && hasSearched && results.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] uppercase tracking-wider font-semibold text-fg-subtle">
                {results.length === 1 ? '1 alternativa' : `${results.length} alternativas`}
              </p>
              {results.map((result) => {
                const alreadyLocal = isLocal(result.name)
                return (
                  <button
                    key={result.name}
                    type="button"
                    onClick={() => startPull(withDefaultTag(result.name))}
                    title={`Descargar ${result.name}`}
                    className="w-full text-left p-2.5 bg-inset border border-default rounded-xl hover:border-blue-500/50 hover:bg-fg/5 transition-colors cursor-pointer group"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs text-fg group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors truncate">
                        {result.name}
                      </span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        {alreadyLocal && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20">
                            <HardDrive className="w-2.5 h-2.5" />
                            En local
                          </span>
                        )}
                        {result.is_official && (
                          <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-blue-500/10 text-blue-700 dark:text-blue-400 border border-blue-500/20">
                            Oficial
                          </span>
                        )}
                      </span>
                    </div>
                    {result.description && (
                      <p className="mt-1 text-[11px] text-fg-muted line-clamp-2">
                        {result.description}
                      </p>
                    )}
                    {result.star_count > 0 && (
                      <p className="mt-1 flex items-center gap-1 text-[10px] text-fg-subtle">
                        <Star className="w-3 h-3" />
                        {result.star_count.toLocaleString('es-ES')}
                      </p>
                    )}
                  </button>
                )
              })}
            </div>
          )}

          {phase === 'search' && hasSearched && results.length === 0 && (
            <p className="text-xs text-fg-subtle text-center py-3">
              No se han encontrado imágenes para "{trimmed}".
            </p>
          )}

          {/* Confirmar la referencia escrita, para tags o digests concretos */}
          {phase === 'search' && valid && (
            <button
              type="button"
              onClick={() => startPull(withDefaultTag(trimmed))}
              title="Descargar la referencia escrita"
              className="w-full px-3.5 py-2 text-xs font-medium text-fg bg-elevated hover:bg-fg/10 rounded-xl transition-colors cursor-pointer flex items-center justify-center gap-2"
            >
              <Download className="w-3.5 h-3.5" />
              <span>
                Descargar <span className="font-mono">{withDefaultTag(trimmed)}</span>
              </span>
            </button>
          )}

          {!valid && phase === 'search' && !hasSearched && (
            <p className="text-xs text-fg-subtle text-center py-2">
              Escribe una referencia y pulsa Buscar.
            </p>
          )}
        </div>

        <div className="shrink-0 p-4 border-t border-default flex items-center justify-between gap-3">
          <span className="text-[11px] text-fg-subtle">
            {isPullingNow
              ? 'Cerrar cancela la descarga'
              : isDone
                ? 'La imagen ya está en el host'
                : 'Sin tag se descargará la variante latest'}
          </span>
          <button
            type="button"
            onClick={handleClose}
            data-testid="pull-modal-primary-action"
            className="px-3.5 py-1.5 text-xs font-medium text-fg bg-elevated hover:bg-fg/10 rounded-lg transition-colors cursor-pointer shrink-0"
          >
            {isPullingNow ? 'Cancelar' : 'Cerrar'}
          </button>
        </div>
      </div>
    </div>
  )
}
