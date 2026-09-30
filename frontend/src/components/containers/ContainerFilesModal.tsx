// SPDX-License-Identifier: AGPL-3.0-or-later
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  FolderTree,
  ArrowUp,
  Download,
  Upload,
  File as FileIcon,
  Folder,
  Link2,
  HardDrive,
  RefreshCw,
  X,
} from 'lucide-react'
import { MODAL_OVERLAY } from '../ui/modalOverlay'
import { dockerApi } from '../../services/dockerApi'
import {
  formatearBytes,
  validarTamano,
  type ContainerEntry,
  type FileKind,
  type ListDirectoryResult,
} from '../../types/filesystem'

/** La superficie del API que usa el modal, para poder sustituirla en tests. */
export interface ContainerFilesApi {
  listFiles(containerId: string, path: string): Promise<ListDirectoryResult>
  downloadFile(
    containerId: string,
    path: string
  ): Promise<{ blob: Blob; filename: string }>
  uploadFiles(containerId: string, path: string, files: File[]): Promise<{ enviados: number }>
}

interface ContainerFilesModalProps {
  isOpen: boolean
  onClose: () => void
  containerId: string
  containerName: string
  /** `running` dispara el aviso de escritura: sobreescribir no es atómico. */
  containerState: string
  /** Para tests. En producción es el `dockerApi`. */
  api?: ContainerFilesApi
}

const ICONO: Record<FileKind, React.ReactNode> = {
  dir: <Folder className="w-4 h-4 text-amber-500" aria-hidden="true" />,
  file: <FileIcon className="w-4 h-4 text-fg-muted" aria-hidden="true" />,
  symlink: <Link2 className="w-4 h-4 text-sky-500" aria-hidden="true" />,
  other: <HardDrive className="w-4 h-4 text-fg-subtle" aria-hidden="true" />,
}

const ETIQUETA: Record<FileKind, string> = {
  dir: 'directorio',
  file: 'fichero',
  symlink: 'enlace simbólico',
  other: 'otro tipo',
}

/**
 * Explorador de ficheros de un contenedor (SPEC-20).
 *
 * Lo que se ve es el filesystem **del contenedor**, montajes incluidos. Los
 * `..` y los enlaces se resuelven dentro de su namespace: no hay traversal, y el
 * límite real es el mismo que el de la terminal (SPEC-05), que el panel ya
 * expone. Escribir o leer a través de un `-v` sale al host, y eso es la
 * frontera de Docker, no un fallo de este diálogo.
 *
 * **Ninguna de las dos direcciones toca el disco del host.** La subida manda el
 * contenido de los ficheros que el navegador ya leyó (`<input type="file">` no
 * expone la ruta) y la descarga la resuelve el navegador con un Blob. El
 * backend nunca abre un fichero, y este diálogo nunca le pasa una ruta del
 * host (SPEC-20 §3.2).
 */
export const ContainerFilesModal: React.FC<ContainerFilesModalProps> = ({
  isOpen,
  onClose,
  containerId,
  containerName,
  containerState,
  api = dockerApi as ContainerFilesApi,
}) => {
  const [ruta, setRuta] = useState<string>('/')
  const [listado, setListado] = useState<ListDirectoryResult | null>(null)
  const [cargando, setCargando] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [pendientes, setPendientes] = useState<File[] | null>(null)
  const [subiendo, setSubiendo] = useState<boolean>(false)
  const inputFicheros = useRef<HTMLInputElement>(null)
  const inputCarpeta = useRef<HTMLInputElement>(null)

  const cargando_ = useCallback(
    async (destino: string) => {
      setCargando(true)
      setError(null)
      // La ruta se actualiza AQUÍ y no en el handler de cada botón. Si no, `ruta`
      // se queda en la inicial y `juntar(ruta, nombre)` construiría
      // `/subnombre` en vez de `/datos/sub`: el error es silencioso y parece un
      // fallo del daemon.
      setRuta(destino)
      try {
        setListado(await api.listFiles(containerId, destino))
      } catch (err: unknown) {
        // El listado anterior se queda en su sitio: un fallo al navegar no
        // borra lo que el usuario tenía delante.
        setError(err instanceof Error ? err.message : 'No se pudo leer ese directorio')
      } finally {
        setCargando(false)
      }
    },
    [api, containerId]
  )

  useEffect(() => {
    if (isOpen) {
      setRuta('/')
      setPendientes(null)
      void cargando_('/')
    }
  }, [isOpen, cargando_])

  const padre = listado?.parent ?? null
  const enMarcha = containerState === 'running'

  const juntar = (base: string, nombre: string) =>
    `${base === '/' ? '' : base}/${nombre}`

  const descargar = async (entrada: ContainerEntry) => {
    const completa = juntar(ruta, entrada.name)
    setError(null)
    try {
      const { blob, filename } = await api.downloadFile(containerId, completa)
      // Lo guarda el navegador. Donde acabe lo elige el usuario, y el backend no
      // escribe nada: por eso esto no rompe el principio del panel.
      const url = URL.createObjectURL(blob)
      const enlace = document.createElement('a')
      enlace.href = url
      enlace.download = filename
      document.body.appendChild(enlace)
      enlace.click()
      document.body.removeChild(enlace)
      URL.revokeObjectURL(url)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'No se pudo descargar el fichero')
    }
  }

  const elegirFicheros = (files: FileList | null) => {
    if (!files || files.length === 0) return
    const elegidos = Array.from(files)

    // El tope se comprueba AQUÍ, con el `size` que el navegador ya conoce, para
    // no gastar un viaje descubriendo que el fichero no cabe.
    const problemas = elegidos
      .map((f) => validarTamano(f.size, 'subida'))
      .filter((m): m is string => m !== null)
    if (problemas.length > 0) {
      setError(problemas[0])
      setPendientes(null)
      return
    }

    setError(null)

    // Escribir encima no es transaccional y un proceso puede seguir usando la
    // versión anterior en memoria (SPEC-20 §3.4). El aviso PIDE CONFIRMACIÓN en
    // vez de sólo informational: si la escritura ocurre en el mismo instante en
    // que se pinta el aviso, no es un aviso sino una disculpa, y el usuario no
    // ha podido leerlo. No bloquea la operación —un clic y sigue— pero para
    // subir hay que haberla leído.
    if (enMarcha) {
      setPendientes(elegidos)
      return
    }
    void subir(elegidos)
  }

  const subir = async (elegidos: File[]) => {
    setSubiendo(true)
    setPendientes(null)
    try {
      await api.uploadFiles(containerId, ruta, elegidos)
      await cargando_(ruta)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'No se pudo subir')
    } finally {
      setSubiendo(false)
    }
  }

  const titulo = useMemo(() => {
    const partes = ruta.split('/').filter(Boolean)
    return partes.length === 0 ? '/' : partes.join(' / ')
  }, [ruta])

  if (!isOpen) return null

  return (
    <div className={MODAL_OVERLAY} onClick={onClose}>
      <div
        className="w-full max-w-3xl bg-surface border border-default rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Ficheros de ${containerName}`}
        data-testid="files-modal"
      >
        <div className="p-5 border-b border-default flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-xl border border-blue-500/20">
              <FolderTree className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-fg">Ficheros</h3>
              <p className="text-xs text-fg-muted font-mono" data-testid="ruta-actual">
                {titulo}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="p-2 text-fg-muted hover:text-fg hover:bg-inset rounded-lg transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-2.5 border-b border-default flex items-center gap-2">
          <button
            onClick={() => padre && void cargando_(padre)}
            disabled={!padre}
            title={padre ? 'Volver al directorio padre' : 'Ya estás en la raíz'}
            className="p-1.5 rounded-lg text-fg-muted hover:text-fg hover:bg-inset disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <ArrowUp className="w-4 h-4" />
            <span className="sr-only">Subir</span>
          </button>
          <button
            onClick={() => void cargando_(ruta)}
            aria-label="Refrescar"
            className="p-1.5 rounded-lg text-fg-muted hover:text-fg hover:bg-inset transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${cargando ? 'animate-spin' : ''}`} />
          </button>
          <div className="flex-1" />
          <button
            onClick={() => inputFicheros.current?.click()}
            disabled={subiendo}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-fg bg-inset border border-default rounded-lg hover:border-blue-500/50 transition-colors disabled:opacity-50"
          >
            <Upload className="w-3.5 h-3.5" />
            {subiendo ? 'Subiendo…' : 'Subir ficheros'}
          </button>
          <button
            onClick={() => inputCarpeta.current?.click()}
            disabled={subiendo}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-fg bg-inset border border-default rounded-lg hover:border-blue-500/50 transition-colors disabled:opacity-50"
          >
            <Folder className="w-3.5 h-3.5" />
            Carpeta
          </button>
          {/* Dos inputs, no uno con dos modos: `webkitdirectory` no se puede
              quitar por JS y forzarlo rompe la selección de ficheros sueltos. */}
          <input
            ref={inputFicheros}
            type="file"
            multiple
            data-testid="input-subida"
            onChange={(e) => {
              elegirFicheros(e.target.files)
              e.target.value = ''
            }}
            className="hidden"
          />
          <input
            ref={inputCarpeta}
            type="file"
            multiple
            // No es un atributo estándar: es lo que hace que el selector traiga
            // una carpeta y los nombres con su ruta relativa, que es como se
            // conserva la estructura al subir.
            {...{ webkitdirectory: '', directory: '' }}
            data-testid="input-carpeta"
            onChange={(e) => {
              elegirFicheros(e.target.files)
              e.target.value = ''
            }}
            className="hidden"
          />
        </div>

        {pendientes && (
          <div
            role="note"
            className="mx-5 my-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-700 dark:text-amber-400 leading-relaxed space-y-2"
          >
            <p className="font-medium">
              El contenedor está en marcha y vas a escribir dentro.
            </p>
            <p>
              La escritura no es atómica: si se corta a mitad queda un fichero
              truncado. Y si un proceso ya tenía ese fichero abierto puede seguir
              usando la versión anterior en memoria hasta que se reinicie.
            </p>
            <p>
              Es una advertencia, no un bloqueo: si lo querías, continúa.
            </p>
            <div className="flex gap-2 pt-1">
              <button
                data-testid="confirmar-subida"
                onClick={() => void subir(pendientes)}
                disabled={subiendo}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-600 text-white hover:bg-amber-700 transition-colors disabled:opacity-50"
              >
                {subiendo ? 'Subiendo…' : 'Subir igualmente'}
              </button>
              <button
                onClick={() => setPendientes(null)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-fg bg-inset border border-default hover:border-fg-subtle transition-colors"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        {error && (
          <p role="alert" className="mx-5 my-3 text-xs text-rose-600 dark:text-rose-400">
            {error}
          </p>
        )}

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {listado?.truncated && (
            <p className="px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
              Este directorio tiene demasiadas entradas: no caben todas y aquí sólo sale
              una parte.
            </p>
          )}
          {listado?.entries.length === 0 && !cargando && (
            <p className="px-3 py-6 text-center text-xs text-fg-subtle">
              Este directorio está vacío.
            </p>
          )}
          <ul className="divide-y divide-default">
            {(listado?.entries ?? []).map((entrada) => (
              <li key={entrada.name} className="flex items-center gap-3 px-3 py-2 hover:bg-inset">
                <span className="shrink-0">{ICONO[entrada.kind]}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <button
                      data-testid="fila-nombre"
                      onClick={() => {
                        if (entrada.kind === 'dir') {
                          void cargando_(juntar(ruta, entrada.name))
                        } else {
                          void descargar(entrada)
                        }
                      }}
                      disabled={
                        entrada.kind !== 'dir' && entrada.kind !== 'file' && entrada.kind !== 'symlink'
                      }
                      className={`truncate text-sm ${
                        entrada.kind === 'dir'
                          ? 'font-medium text-fg hover:text-blue-600 dark:hover:text-blue-400'
                          : 'text-fg'
                      } ${entrada.kind === 'other' ? 'cursor-not-allowed opacity-60' : ''}`}
                      title={entrada.name}
                    >
                      {entrada.name}
                    </button>
                    <span className="shrink-0 text-xs text-fg-subtle font-mono tabular-nums">
                      {/* `size: 0` significa "no medido", no "vacío": un nombre con
                          espacios dobles no se puede medir con `ls` y no hay forma
                          de distinguirlo de un fichero vacío en el contrato. Un
                          guion dice la verdad; un "0 B" afirmaría algo que no se
                          sabe (SPEC-20 §3.3). */}
                      {entrada.kind === 'file' && entrada.size > 0
                        ? formatearBytes(entrada.size)
                        : entrada.kind === 'file'
                          ? '—'
                          : ''}
                    </span>
                  </div>
                  {entrada.kind === 'symlink' && (
                    <p className="text-xs text-fg-subtle">
                      Enlace a <span className="font-mono">{entrada.symlink_target}</span>.
                      No se sigue: al copiarlo baja el enlace, no lo que apunta.
                    </p>
                  )}
                  {entrada.kind === 'other' && (
                    <p className="text-xs text-fg-subtle">
                      {ETIQUETA.other}: se ve pero no se puede abrir ni subir.
                    </p>
                  )}
                </div>
                {(entrada.kind === 'file' || entrada.kind === 'symlink') && (
                  <button
                    data-testid={`descargar-${entrada.name}`}
                    onClick={() => void descargar(entrada)}
                    aria-label={`Descargar ${entrada.name}`}
                    className="shrink-0 p-1.5 rounded-lg text-fg-muted hover:text-fg hover:bg-surface transition-colors"
                  >
                    <Download className="w-4 h-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>

        <div className="px-5 py-3 border-t border-default">
          <p className="text-xs text-fg-muted leading-relaxed">
            Lo que ves es el filesystem del contenedor, montajes incluidos. Si tiene un
            volumen montado, ahí están los ficheros del host que tiene montados.
          </p>
          <p className="text-xs text-fg-subtle mt-1.5">
            Copiar sube el <em>contenido</em> de lo que elijas y baja el contenido a
            donde elijas guardarlo. El panel no escribe en tu disco por su cuenta.
          </p>
        </div>
      </div>
    </div>
  )
}