import { useState } from 'react'
import {
  Search,
  AlertCircle,
  RefreshCw,
  Container,
  Layers,
  HardDrive,
  Network,
} from 'lucide-react'
import { useContainers } from './hooks/useContainers'
import type { ContainerSummary } from './types/docker'
import { Navbar } from './components/layout/Navbar'
import { ContainersTable } from './components/containers/ContainersTable'
import { ContainerDetailModal } from './components/containers/ContainerDetailModal'
import { DeleteConfirmModal } from './components/containers/DeleteConfirmModal'
import { LogsModal } from './components/logs/LogsModal'
import { StatsModal } from './components/stats/StatsModal'
import { CreateContainerModal } from './components/containers/CreateContainerModal'
import { TerminalModal } from './components/terminal/TerminalModal'
import { ImagesView } from './components/images/ImagesView'
import { VolumesView } from './components/volumes/VolumesView'
import { NetworksView } from './components/networks/NetworksView'
import { SystemSummaryBar } from './components/system/SystemSummaryBar'
import type { LocalImageSummary } from './types/image'

function App() {
  const {
    containers,
    rawContainers,
    loading,
    error,
    statusFilter,
    setStatusFilter,
    searchQuery,
    setSearchQuery,
    actionInProgress,
    refetch,
    executeAction,
  } = useContainers()

  const [selectedContainer, setSelectedContainer] = useState<ContainerSummary | null>(null)
  const [containerToDelete, setContainerToDelete] = useState<ContainerSummary | null>(null)
  const [containerForLogs, setContainerForLogs] = useState<ContainerSummary | null>(null)
  const [containerForStats, setContainerForStats] = useState<ContainerSummary | null>(null)
  const [containerForTerminal, setContainerForTerminal] = useState<ContainerSummary | null>(null)
  const [isCreateModalOpen, setIsCreateModalOpen] = useState<boolean>(false)
  const [activeView, setActiveView] = useState<
    'containers' | 'images' | 'volumes' | 'networks'
  >('containers')
  const [presetImage, setPresetImage] = useState<string>('')

  const runningCount = rawContainers.filter((c) => c.status.toLowerCase() === 'running').length
  const exitedCount = rawContainers.filter((c) => c.status.toLowerCase() === 'exited').length

  const filterOptions = [
    { label: 'Todos', value: 'all', count: rawContainers.length },
    { label: 'Activos', value: 'running', count: runningCount },
    { label: 'Detenidos', value: 'exited', count: exitedCount },
    { label: 'Pausados', value: 'paused', count: rawContainers.filter((c) => c.status.toLowerCase() === 'paused').length },
  ]

  return (
    <div className="min-h-screen bg-base text-fg flex flex-col font-sans selection:bg-blue-500 selection:text-white">
      <Navbar
        onRefresh={refetch}
        loading={loading}
        onOpenCreateModal={() => setIsCreateModalOpen(true)}
      />

      {/* La franja comparte la columna del contenido: si se deja fuera de
          `main`, ocupa todo el ancho de la pagina y desentona con las tablas. */}
      <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <SystemSummaryBar />
      </div>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        {/* Banner de Error */}
        {error && (
          <div className="flex items-center justify-between p-4 bg-rose-500/10 border border-rose-500/20 text-rose-700 dark:text-rose-400 rounded-xl text-sm animate-in fade-in">
            <div className="flex items-center gap-3">
              <AlertCircle className="w-5 h-5 shrink-0" />
              <span>{error}</span>
            </div>
            <button
              onClick={refetch}
              className="px-3 py-1 bg-rose-500/20 hover:bg-rose-500/30 text-rose-700 dark:text-rose-300 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Reintentar
            </button>
          </div>
        )}

        {/* Conmutador de vista Contenedores / Imágenes */}
        <div className="flex items-center gap-1 p-1 bg-surface rounded-xl border border-default w-fit">
          {(
            [
              { key: 'containers', label: 'Contenedores', icon: Container },
              { key: 'images', label: 'Imágenes', icon: Layers },
              { key: 'volumes', label: 'Volúmenes', icon: HardDrive },
              { key: 'networks', label: 'Redes', icon: Network },
            ] as const
          ).map((view) => {
            const Icon = view.icon
            const active = activeView === view.key
            return (
              <button
                key={view.key}
                onClick={() => setActiveView(view.key)}
                aria-pressed={active}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer ${
                  active
                    ? 'bg-elevated text-fg shadow-sm'
                    : 'text-fg-muted hover:text-fg'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{view.label}</span>
              </button>
            )
          })}
        </div>

        {activeView === 'volumes' ? (
          <VolumesView onDeleted={refetch} />
        ) : activeView === 'networks' ? (
          <NetworksView />
        ) : activeView === 'images' ? (
          <ImagesView
            onRunImage={(image: LocalImageSummary) => {
              setPresetImage(image.tags[0] ?? image.id)
              setIsCreateModalOpen(true)
            }}
            onDeleted={refetch}
          />
        ) : (
          <>
        {/* Toolbar de contenedores: filtros por estado y búsqueda.
            Solo tiene sentido en esta pestaña: en Imágenes no aplicaría. */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            {/* Pills de Filtrado */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
              {filterOptions.map((opt) => {
                const active = statusFilter === opt.value
                return (
                  <button
                    key={opt.value}
                    onClick={() => setStatusFilter(opt.value)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-all flex items-center gap-2 shrink-0 ${
                      active
                        ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20'
                        : 'bg-surface text-fg-muted hover:text-fg hover:bg-fg/10 border border-default/80'
                    }`}
                  >
                    <span>{opt.label}</span>
                    <span
                      className={`px-1.5 py-0.2 rounded-full text-[10px] ${
                        active ? 'bg-blue-700 text-blue-100' : 'bg-elevated text-fg-muted'
                      }`}
                    >
                      {opt.count}
                    </span>
                  </button>
                )
              })}
            </div>

            {/* Barra de Búsqueda */}
            <div className="relative w-full sm:w-72">
              <Search className="w-4 h-4 text-fg-muted absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Buscar por nombre, imagen o ID..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-4 py-1.5 text-xs bg-surface border border-default rounded-xl text-fg placeholder-fg-muted focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-all"
              />
            </div>
          </div>

        {/* Tabla de Contenedores */}
        <ContainersTable
          containers={containers}
          loading={loading}
          actionInProgress={actionInProgress}
          onAction={executeAction}
          onSelect={(c) => setSelectedContainer(c)}
          onViewLogs={(c) => setContainerForLogs(c)}
          onViewStats={(c) => setContainerForStats(c)}
          onOpenTerminal={(c) => setContainerForTerminal(c)}
          onRequestDelete={(c) => setContainerToDelete(c)}
        />
          </>
        )}
      </main>

      {/* Modal de Detalle */}
      <ContainerDetailModal
        container={selectedContainer}
        onClose={() => setSelectedContainer(null)}
      />

      {/* Modal de Logs en Vivo */}
      <LogsModal
        container={containerForLogs}
        onClose={() => setContainerForLogs(null)}
      />

      {/* Modal de Métricas en Vivo */}
      <StatsModal
        isOpen={!!containerForStats}
        container={containerForStats}
        onClose={() => setContainerForStats(null)}
      />

      {/* Modal de Terminal Interactivo */}
      <TerminalModal
        isOpen={!!containerForTerminal}
        container={containerForTerminal}
        onClose={() => setContainerForTerminal(null)}
      />

      {/* Modal de Creación de Contenedor */}
      <CreateContainerModal
        isOpen={isCreateModalOpen}
        initialImage={presetImage}
        onClose={() => {
          setIsCreateModalOpen(false)
          setPresetImage('')
        }}
        onSuccess={refetch}
      />

      {/* Modal de Confirmación de Borrado */}
      <DeleteConfirmModal
        container={containerToDelete}
        onClose={() => setContainerToDelete(null)}
        onConfirm={(id, force) => executeAction(id, 'remove', force)}
      />
    </div>
  )
}

export default App
