// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from 'react'
import {
  Search,
  RefreshCw,
  AlertCircle,
  Layers,
  Box,
  Network as NetworkIcon,
  HardDrive,
  FileSearch,
} from 'lucide-react'
import { useComposeProjects } from '../../hooks/useComposeProjects'
import { dockerApi } from '../../services/dockerApi'
import { ProjectsTable } from './ProjectsTable'
import { rutaDeProyecto } from '../../utils/compose'
import { ProjectDetailModal } from './ProjectDetailModal'
import { ComposePlanModal } from './ComposePlanModal'
import { ComposeActionPanel } from './ComposeActionPanel'
import { ComposeDownDialog } from './ComposeDownDialog'
import { ComposeLogsViewer } from './ComposeLogsViewer'
import type { ComposeAction, ComposeProjectFilter, ComposeProjectSummary } from '../../types/compose'

interface ProjectsViewProps {
  onNavigateTab?: (tab: 'containers' | 'volumes' | 'networks') => void
  /** Se pasa desde `App` para que el inventario se recargue al cambiar algo. */
  onRefrescar?: () => void
}

const FILTERS: { key: ComposeProjectFilter; label: string }[] = [
  { key: 'all', label: 'Todos' },
  { key: 'running', label: 'En ejecución' },
  { key: 'orphaned', label: 'Huérfanos' },
]

export function ProjectsView({ onNavigateTab, onRefrescar }: ProjectsViewProps) {
  const {
    overview,
    projects,
    counts,
    loading,
    refreshing,
    error: errorInventario,
    filter,
    setFilter,
    searchQuery,
    setSearchQuery,
    refetch,
  } = useComposeProjects()
  const [selected, setSelected] = useState<ComposeProjectSummary | null>(null)
  const [planOpen, setPlanOpen] = useState<boolean>(false)
  const [accionando, setAccionando] = useState<ComposeProjectSummary | null>(null)
  const [accionActual, setAccionActual] = useState<ComposeAction | null>(null)
  const [bajando, setBajando] = useState<{
    proyecto: ComposeProjectSummary
    volumenes: string[]
  } | null>(null)
  const [viendoLogs, setViendoLogs] = useState<ComposeProjectSummary | null>(null)
  const [pendiente, setPendiente] = useState<{ accion: ComposeAction; volumes: boolean } | null>(
    null
  )
  const [errorAccion, setErrorAccion] = useState<string | null>(null)

  /**
   * Abrir el diálogo de bajada pide primero el detalle del proyecto.
   *
   * El resumen solo trae `volumes_count`, y el diálogo tiene que mostrar **qué**
   * se va a borrar, no cuántos: quien borra necesita el nombre en pantalla.
   */
  const bajarProyecto = async (proyecto: ComposeProjectSummary) => {
    try {
      const detalle = await dockerApi.getComposeProject(proyecto.name)
      setBajando({ proyecto, volumenes: detalle.volumes.map((v) => v.name) })
    } catch (err: unknown) {
      // Sin los nombres no se puede enseñar qué se borra, así que no se abre el
      // diálogo: se informa y no se hace nada.
      setErrorAccion(
        err instanceof Error
          ? err.message
          : 'No se pudieron leer los volúmenes del proyecto'
      )
    }
  }

  return (
    <div className="space-y-6">
      {/* Inventario: qué proyectos hay, cuáles conservan recursos y qué queda
          fuera de compose. */}
      {overview && (
        <div
          className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-fg-subtle"
          data-testid="unlabelled-summary"
        >
          <span className="flex items-center gap-1.5" title="Proyectos de Docker Compose en el host">
            <Layers className="w-3.5 h-3.5" />
            <span className="font-mono text-fg">{overview.total_projects}</span> proyectos
          </span>
          <span className="flex items-center gap-1.5" title="Proyectos con contenedores en marcha">
            <Box className="w-3.5 h-3.5" />
            <span className="font-mono text-fg">{overview.running_projects}</span> en
            ejecución
          </span>
          <span
            className="flex items-center gap-1.5"
            title="Sin contenedores pero con red o volúmenes: espacio que compose ya no usa"
          >
            <HardDrive className="w-3.5 h-3.5" />
            <span className="font-mono text-fg">{overview.orphaned_projects}</span>{' '}
            huérfanos
          </span>
          <span
            className="flex items-center gap-1.5"
            title="Recursos que no pertenecen a ningún proyecto compose"
          >
            <NetworkIcon className="w-3.5 h-3.5" />
            <span className="font-mono text-fg">
              {overview.unlabelled_containers}/{overview.unlabelled_networks}/
              {overview.unlabelled_volumes}
            </span>{' '}
            sin proyecto
          </span>

          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPlanOpen(true)}
              className="px-2.5 py-1 rounded text-[11px] text-fg-muted hover:text-fg hover:bg-elevated-hover transition-colors flex items-center gap-1.5"
            >
              <FileSearch className="w-3.5 h-3.5" />
              Plan
            </button>
            <button
              type="button"
              onClick={() => void refetch()}
              disabled={refreshing}
              aria-label="Refrescar proyectos"
              title="Refrescar proyectos"
              className="p-1.5 rounded hover:bg-elevated-hover transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      )}

      {errorAccion && (
        <div
          role="alert"
          className="flex items-center gap-3 p-3 bg-rose-500/10 border border-rose-500/20 text-rose-700 dark:text-rose-300 rounded-xl text-xs"
        >
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="flex-1">{errorAccion}</span>
          <button
            type="button"
            onClick={() => setErrorAccion(null)}
            className="px-2 py-1 rounded hover:bg-rose-500/20 transition-colors"
          >
            Descartar
          </button>
        </div>
      )}

      {errorInventario && (
        <div
          role="alert"
          className="flex items-center justify-between p-4 bg-rose-500/10 border border-rose-500/20 text-rose-700 dark:text-rose-300 rounded-xl text-sm"
        >
          <div className="flex items-center gap-3 min-w-0">
            <AlertCircle className="w-5 h-5 shrink-0" />
            <span className="truncate">{errorInventario}</span>
          </div>
          <button
            type="button"
            onClick={() => void refetch()}
            className="px-3 py-1 bg-rose-500/20 hover:bg-rose-500/30 text-rose-700 dark:text-rose-300 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Reintentar
          </button>
        </div>
      )}

      {loading && projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center p-12 text-fg-muted">
          <RefreshCw className="w-8 h-8 animate-spin mb-3 text-blue-600 dark:text-blue-500" />
          <p className="text-sm">Leyendo los proyectos compose...</p>
        </div>
      ) : (
        <>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0">
              {FILTERS.map((option) => {
                const active = filter === option.key
                return (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => setFilter(option.key)}
                    aria-pressed={active}
                    className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-all flex items-center gap-2 shrink-0 ${
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
                      {counts[option.key]}
                    </span>
                  </button>
                )
              })}
            </div>

            <div className="relative w-full sm:w-72">
              <Search className="w-4 h-4 text-fg-muted absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Buscar proyecto..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-4 py-1.5 text-xs bg-surface border border-default rounded-xl text-fg placeholder-fg-muted focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-all"
              />
            </div>
          </div>

          <ProjectsTable
            projects={projects}
            onSelect={setSelected}
            onAccion={(proyecto, accion) => {
              if (accion === 'logs') {
                setViendoLogs(proyecto)
                return
              }
              setAccionando(proyecto)
              setAccionActual(accion)
              setPendiente(null)
            }}
            onBajar={bajarProyecto}
          />
        </>
      )}

      {selected && (
        <ProjectDetailModal
          project={selected.name}
          onClose={() => setSelected(null)}
          onNavigateTab={onNavigateTab}
        />
      )}

      {accionando && accionActual && (
        <ComposeActionPanel
          project={accionando.name}
          path={rutaDeProyecto(accionando)}
          accionInicial={accionActual}
          volumes={pendiente?.volumes ?? false}
          onClose={() => {
            setAccionando(null)
            setAccionActual(null)
            setPendiente(null)
          }}
          /* `up`, `stop` y `down` dejan obsoleto el inventario: el backend avisa
             con su `exit` y esta es la recarga que lo refleja. */
          onRefrescar={() => {
            void refetch()
            onRefrescar?.()
          }}
        />
      )}

      {bajando && (
        <ComposeDownDialog
          project={bajando.proyecto.name}
          volumes={bajando.volumenes}
          onClose={() => setBajando(null)}
          onConfirm={(volumes) => {
            // El diálogo confirma; la acción la lanza el panel, que ya sabe
            // enviar `volumes` por el canal.
            setAccionando(bajando.proyecto)
            setAccionActual('down')
            setPendiente({ accion: 'down', volumes })
            setBajando(null)
          }}
        />
      )}

      {viendoLogs && (
        <ComposeLogsViewer
          project={viendoLogs.name}
          path={rutaDeProyecto(viendoLogs)}
          onClose={() => setViendoLogs(null)}
        />
      )}

      {planOpen && (
        <ComposePlanModal
          open
          onClose={() => setPlanOpen(false)}
          /* La etiqueta `project.config_files` dice dónde está el archivo, así que
             al abrir el Plan desde un proyecto ya se propone su ruta. */
          initialPath={selected?.config_files[0] ?? ''}
          /* Desplegar desde el plan deja obsoleto el inventario igual que una
             acción desde la fila: el proyecto recién arrancado ya existe y tiene
             que verse sin cambiar de pestaña. */
          onRefrescar={() => {
            void refetch()
            onRefrescar?.()
          }}
        />
      )}
    </div>
  )
}
