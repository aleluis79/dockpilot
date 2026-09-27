// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from 'react'
import { ArrowUp, FileText, Folder, FolderOpen, FolderSearch, Info, X } from 'lucide-react'
import { MODAL_OVERLAY } from '../ui/modalOverlay'
import { dockerApi } from '../../services/dockerApi'
import type { BrowseEntry, BrowseResult } from '../../types/compose'

interface ComposeFilePickerProps {
  open: boolean
  onClose: () => void
  /** Se llama con la ruta absoluta del fichero elegido. */
  onSelect: (path: string) => void
}

/** Formatea un tamaño sin inventar decimales: 900 B, 1.2 kB, 4.0 MB. */
function tamano(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function Avisos({ listing }: { listing: BrowseResult | null }) {
  // Los dos avisos son fallos distintos y se separan: un truncado es un tope del
  // panel y unas entradas omitidas son el confinamiento haciendo su trabajo. Sin
  // el aviso, un listado incompleto parecería completo.
  if (!listing || (!listing.truncado && listing.ocultos === 0)) return null
  return (
    <div className="flex flex-col gap-1 text-[11px] text-amber-400/90">
      {listing.truncado && (
        <p>
          Mostrando {listing.entries.length} de {listing.total} entradas: el resto no cabe en
          pantalla. Entra en un subdirectorio para ver más.
        </p>
      )}
      {listing.ocultos > 0 && (
        <p>
          {listing.ocultos === 1 ? '1 entrada omitida' : `${listing.ocultos} entradas omitidas`}{' '}
          porque apuntan fuera del directorio permitido.
        </p>
      )}
    </div>
  )
}

/**
 * Explorador de archivos compose (SPEC-14).
 *
 * Existe porque la ruta había que copiarla a mano, y en la práctica eso acababa
 * en previsualizar el proyecto equivocado: en el host de referencia hay 4
 * archivos compose y el inventario solo conoce 1, porque los otros tres no están
 * en marcha y no dejan etiquetas `com.docker.compose.*`.
 *
 * No es un `<input type="file">` porque el navegador no entrega la ruta del host
 * y `docker compose` corre en el backend. Es un endpoint propio, confinado a la
 * raíz que declara el backend: se pide sin ruta y es él quien dice cuál es, en
 * lugar de deducirla aquí y duplicar la regla en dos sitios.
 *
 * Elegir un fichero **no** previsualiza nada: rellena la ruta y cierra. Abrir un
 * archivo y ejecutarlo no es lo mismo.
 */
export function ComposeFilePicker({ open, onClose, onSelect }: ComposeFilePickerProps) {
  const [listing, setListing] = useState<BrowseResult | null>(null)
  const [cargando, setCargando] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  /** Sin `ruta` se pide la raíz. El backend devuelve su `root` real en la respuesta. */
  const cargar = async (ruta?: string) => {
    setCargando(true)
    setError(null)
    try {
      // La primera carga va sin argumento para que sea el backend quien diga
      // donde esta la raiz; el resto, con la ruta explicita que se esta viendo.
      const resultado = ruta === undefined
        ? await dockerApi.browseComposeFiles()
        : await dockerApi.browseComposeFiles(ruta)
      setListing(resultado)
    } catch (err: unknown) {
      // El listado anterior se conserva: si el padre falla, al menos sigue
      // viéndose de dónde se venía, en vez de dejar un diálogo vacío.
      setError(err instanceof Error ? err.message : 'No se pudo leer el directorio')
    } finally {
      setCargando(false)
    }
  }

  useEffect(() => {
    if (open) void cargar()
  }, [open])

  if (!open) return null

  const abrir = (entrada: BrowseEntry) => {
    if (entrada.kind === 'dir') {
      void cargar(entrada.path)
      return
    }
    onSelect(entrada.path)
    onClose()
  }

  const nombreRaiz = listing?.root.split('/').filter(Boolean).pop() ?? 'la raíz'

  return (
    <div className={MODAL_OVERLAY} onClick={onClose}>
      <div
        className="bg-surface border border-default rounded-lg w-full max-w-xl max-h-[80vh] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Seleccionar archivo compose"
        data-testid="compose-file-picker"
      >
        <div className="flex items-center justify-between p-4 border-b border-default shrink-0">
          <h3 className="text-sm font-semibold text-fg flex items-center gap-2">
            <FolderSearch className="w-4 h-4 text-fg-subtle" />
            Seleccionar archivo compose
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="p-1 rounded text-fg-subtle hover:text-fg hover:bg-elevated-hover transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="p-3 flex flex-col gap-2 min-h-0 flex-1">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => listing?.parent && void cargar(listing.parent)}
              disabled={!listing?.parent}
              title={
                listing?.parent
                  ? `Subir a ${listing.parent}`
                  : `Ya estás en la raíz del explorador: ${nombreRaiz}`
              }
              className="p-1.5 rounded border border-default text-fg-subtle hover:text-fg hover:bg-elevated-hover disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent transition-colors shrink-0"
            >
              <ArrowUp className="w-3.5 h-3.5" />
              <span className="sr-only">Subir</span>
            </button>
            <p
              className="text-[11px] font-mono text-fg-subtle truncate flex-1"
              title={listing?.path}
              data-testid="compose-browser-path"
            >
              {listing?.path ?? '…'}
            </p>
          </div>

          {error && (
            <p role="alert" className="text-xs text-red-400 flex items-start gap-1.5">
              <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
              {error}
            </p>
          )}

          <Avisos listing={listing} />

          <div className="border border-default rounded-lg overflow-y-auto min-h-[16rem] flex-1 divide-y divide-default">
            {cargando && !listing && (
              <p className="p-4 text-xs text-fg-subtle">Leyendo el directorio…</p>
            )}

            {!cargando && listing && listing.entries.length === 0 && (
              <p className="p-4 text-xs text-fg-subtle flex items-center gap-2">
                <FolderOpen className="w-4 h-4" />
                Este directorio está vacío.
              </p>
            )}

            {listing?.entries.map((entrada) => (
              <button
                key={entrada.path}
                type="button"
                onClick={() => abrir(entrada)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-elevated-hover transition-colors"
              >
                {entrada.kind === 'dir' ? (
                  <Folder className="w-4 h-4 text-fg-subtle shrink-0" />
                ) : (
                  <FileText
                    className={`w-4 h-4 shrink-0 ${
                      entrada.es_compose ? 'text-blue-400' : 'text-fg-subtle'
                    }`}
                  />
                )}
                <span
                  className={`text-xs font-mono truncate flex-1 ${
                    entrada.kind === 'file' && !entrada.es_compose ? 'text-fg-muted' : 'text-fg'
                  }`}
                >
                  {entrada.name}
                </span>
                {entrada.kind === 'file' ? (
                  <span className="text-[10px] text-fg-subtle shrink-0">
                    {tamano(entrada.size)}
                  </span>
                ) : (
                  <FolderOpen className="w-3 h-3 text-fg-subtle shrink-0" />
                )}
              </button>
            ))}
          </div>

          <p className="text-[11px] text-fg-subtle">
            Solo se ven los directorios permitidos por el backend. La ruta se puede escribir a
            mano si el archivo está fuera.
          </p>
        </div>
      </div>
    </div>
  )
}
