// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useMemo, useRef, useState } from 'react'
import { X, PauseCircle, Radio, Search, ArrowDown, Copy, Check, Trash2 } from 'lucide-react'
import { MODAL_OVERLAY } from '../ui/modalOverlay'
import { useComposeCommand } from '../../hooks/useComposeCommand'
import type { LineaCompose } from '../../hooks/useComposeCommand'

interface ComposeLogsViewerProps {
  project: string
  path: string
  onClose: () => void
  /** Filtro inicial por servicio, si el modal de detalle se abrió desde uno. */
  service?: string | null
}

type FiltroStream = 'all' | 'stdout' | 'stderr'

/** Compose prefija cada línea con `servicio  | `. */
const PREFIJO_SERVICIO = /^(?<servicio>[A-Za-z0-9_.-]+)\s*\|\s?/

interface LineaVista {
  stream: 'stdout' | 'stderr'
  servicio: string
  texto: string
}

/**
 * Trocea la salida en líneas y le saca el prefijo de servicio.
 *
 * Se conservan **los dos streams**: el filtro de stream del visor necesita saber
 * de cuál salía cada línea, y descartar `stderr` aquí dejaría ese filtro vacío
 * de contenido.
 */
function separar(lineas: LineaCompose[]): LineaVista[] {
  return lineas.flatMap((linea) =>
    linea.data
      .split('\n')
      .filter((cruda) => cruda !== '')
      .map((cruda) => {
        const coincidencia = PREFIJO_SERVICIO.exec(cruda)
        return {
          stream: linea.stream,
          servicio: coincidencia?.groups?.servicio ?? '',
          texto: coincidencia ? cruda.slice(coincidencia[0].length) : cruda,
        }
      })
  )
}

/**
 * Logs de un proyecto completo, en modo seguimiento.
 *
 * Es la pieza de SPEC-02 (logs de un contenedor) elevada a proyecto, y por eso
 * tiene **los mismos controles**: buscar, filtrar por stream, auto-scroll, copiar
 * y limpiar. Un visor de logs sin buscador es inservible en cuanto un proyecto
 * tiene más de un servicio hablando a la vez.
 *
 * Se distingue de `stop`: cortar el seguimiento cierra **solo** este canal y no
 * ejecuta ninguna acción sobre el proyecto, que sigue exactamente como estaba.
 */
export function ComposeLogsViewer({
  project,
  path,
  onClose,
  service = null,
}: ComposeLogsViewerProps) {
  const { output, enCurso, error, ejecutar, cancelar } = useComposeCommand()
  const [busqueda, setBusqueda] = useState<string>('')
  const [filtroStream, setFiltroStream] = useState<FiltroStream>('all')
  const [filtroServicio, setFiltroServicio] = useState<string>('all')
  const [autoScroll, setAutoScroll] = useState<boolean>(true)
  const [copiado, setCopiado] = useState<boolean>(false)
  /* Cuántas líneas se han descartado con "limpiar". Un contador y no un
     `slice` sobre las propias líneas, para que las que lleguen después no
     revivan lo borrado. */
  const [descartadas, setDescartadas] = useState<number>(0)
  const cajaRef = useRef<HTMLPreElement | null>(null)

  useEffect(() => {
    ejecutar({ action: 'logs', path, project_name: project, service, follow: true })
    // Solo al montar: `ejecutar` es estable y volver a lanzarlo abriría otro canal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const todas = useMemo(() => separar(output), [output])
  const vivas = useMemo(() => todas.slice(descartadas), [todas, descartadas])

  // Se mantiene pegado al final solo si el usuario no lo ha desactivado: si ha
  // subido a leer algo, no se le baja el scroll.
  useEffect(() => {
    const caja = cajaRef.current
    if (caja && autoScroll) caja.scrollTop = caja.scrollHeight
  }, [vivas.length, autoScroll])

  const servicios = useMemo(
    () => [...new Set(vivas.map((l) => l.servicio).filter(Boolean))].sort(),
    [vivas]
  )

  const visibles = useMemo(() => {
    const term = busqueda.trim().toLowerCase()
    return vivas.filter((linea) => {
      if (filtroStream !== 'all' && linea.stream !== filtroStream) return false
      if (filtroServicio !== 'all' && linea.servicio !== filtroServicio) return false
      if (!term) return true
      return linea.texto.toLowerCase().includes(term)
    })
  }, [vivas, busqueda, filtroServicio, filtroStream])

  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(visibles.map((l) => l.texto).join('\n'))
      setCopiado(true)
      setTimeout(() => setCopiado(false), 1500)
    } catch {
      // El portapapeles puede estar bloqueado: no es un fallo que merezca un
      // cartel en un visor de logs.
    }
  }

  const cerrarSeguimiento = () => {
    cancelar()
    onClose()
  }

  return (
    <div className={MODAL_OVERLAY} onClick={onClose}>
      <div
        className="bg-surface border border-default rounded-lg w-full max-w-4xl max-h-[85vh] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Logs de ${project}`}
        data-testid="compose-logs-modal"
      >
        <div className="flex items-center justify-between p-4 border-b border-default shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <h3 className="text-sm font-semibold text-fg font-mono truncate">
              {project}
              {service ? ` · ${service}` : ''}
            </h3>
            <span
              data-testid="compose-follow-state"
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border shrink-0"
            >
              {enCurso ? (
                <>
                  <Radio className="w-3 h-3" />
                  Siguiendo
                </>
              ) : (
                <>
                  <PauseCircle className="w-3 h-3" />
                  Detenido
                </>
              )}
            </span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {enCurso && (
              <button
                type="button"
                onClick={cerrarSeguimiento}
                className="px-2.5 py-1 text-xs rounded text-fg-muted hover:text-fg hover:bg-elevated-hover transition-colors"
              >
                Dejar de seguir
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar"
              className="p-1 rounded text-fg-subtle hover:text-fg hover:bg-elevated-hover transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Mismos controles que el visor de logs de un contenedor (SPEC-02). */}
        <div className="flex items-center flex-wrap gap-2 px-4 py-2.5 border-b border-default shrink-0">
          <div className="relative w-40 sm:w-56">
            <Search
              className="w-3.5 h-3.5 text-fg-muted absolute left-2.5 top-1/2 -translate-y-1/2"
              aria-hidden="true"
            />
            <input
              type="text"
              placeholder="Buscar en logs..."
              aria-label="Buscar en logs"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-inset border border-default rounded-lg text-fg placeholder-fg-muted focus:outline-none focus:border-blue-500/50"
            />
          </div>

          {servicios.length > 1 && (
            <select
              aria-label="Filtrar por servicio"
              value={filtroServicio}
              onChange={(e) => setFiltroServicio(e.target.value)}
              className="text-xs bg-inset border border-default rounded-lg px-2 py-1.5 text-fg focus:outline-none focus:border-blue-500/50 cursor-pointer"
            >
              <option value="all">Todos los servicios</option>
              {servicios.map((nombre) => (
                <option key={nombre} value={nombre}>
                  {nombre}
                </option>
              ))}
            </select>
          )}

          <select
            aria-label="Filtrar por stream"
            value={filtroStream}
            onChange={(e) => setFiltroStream(e.target.value as FiltroStream)}
            className="text-xs bg-inset border border-default rounded-lg px-2 py-1.5 text-fg focus:outline-none focus:border-blue-500/50 cursor-pointer"
          >
            <option value="all">Todos</option>
            <option value="stdout">stdout</option>
            <option value="stderr">stderr</option>
          </select>

          <button
            type="button"
            onClick={() => setAutoScroll((prev) => !prev)}
            aria-label={autoScroll ? 'Desactivar auto-scroll' : 'Activar auto-scroll'}
            className={`p-1.5 rounded-lg border text-xs flex items-center gap-1 transition-colors cursor-pointer ${
              autoScroll
                ? 'bg-blue-600/20 text-blue-600 dark:text-blue-400 border-blue-500/30'
                : 'bg-surface text-fg-muted border-default hover:text-fg'
            }`}
          >
            <ArrowDown className="w-3.5 h-3.5" />
            <span className="hidden md:inline text-[11px]">Auto-scroll</span>
          </button>

          <button
            type="button"
            onClick={() => void copiar()}
            aria-label="Copiar logs"
            title="Copiar logs al portapapeles"
            className="p-1.5 text-fg-muted hover:text-fg hover:bg-fg/10 rounded-lg border border-default transition-colors cursor-pointer"
          >
            {copiado ? (
              <Check className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>

          <button
            type="button"
            onClick={() => setDescartadas(todas.length)}
            aria-label="Limpiar consola"
            title="Limpiar consola de logs"
            className="p-1.5 text-fg-muted hover:text-rose-700 dark:hover:text-rose-400 hover:bg-fg/10 rounded-lg border border-default transition-colors cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {error && (
          <div
            role="alert"
            className="m-4 p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-700 dark:text-rose-300 text-xs"
          >
            {error}
          </div>
        )}

        <pre
          ref={cajaRef}
          data-testid="compose-logs"
          className="flex-1 min-h-0 overflow-auto p-3 text-[11px] font-mono text-fg whitespace-pre-wrap break-words"
        >
          {vivas.length > 0 && visibles.length === 0 ? (
            <span className="text-fg-subtle">Sin líneas que coincidan con el filtro.</span>
          ) : vivas.length === 0 ? (
            <span className="text-fg-subtle">
              {enCurso ? 'Esperando salida de los contenedores…' : 'Sin salida.'}
            </span>
          ) : (
            visibles.map((linea, indice) => (
              <div key={indice} className="flex gap-2">
                {linea.servicio && (
                  <span className="text-fg-subtle shrink-0">{linea.servicio}</span>
                )}
                <span className="min-w-0">{linea.texto}</span>
              </div>
            ))
          )}
        </pre>

        <p className="px-4 py-2 text-[10px] text-fg-subtle border-t border-default">
          Dejar de seguir cierra este canal y nada más: no para el proyecto.
        </p>
      </div>
    </div>
  )
}
