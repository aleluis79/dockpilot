import { useState } from 'react'
import { Search, AlertCircle, RefreshCw } from 'lucide-react'
import { useContainers } from './hooks/useContainers'
import type { ContainerSummary } from './types/docker'
import { Navbar } from './components/layout/Navbar'
import { ContainersTable } from './components/containers/ContainersTable'
import { ContainerDetailModal } from './components/containers/ContainerDetailModal'
import { DeleteConfirmModal } from './components/containers/DeleteConfirmModal'
import { LogsModal } from './components/logs/LogsModal'
import { CreateContainerModal } from './components/containers/CreateContainerModal'
import { TerminalModal } from './components/terminal/TerminalModal'

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
  const [containerForTerminal, setContainerForTerminal] = useState<ContainerSummary | null>(null)
  const [isCreateModalOpen, setIsCreateModalOpen] = useState<boolean>(false)

  const runningCount = rawContainers.filter((c) => c.status.toLowerCase() === 'running').length
  const exitedCount = rawContainers.filter((c) => c.status.toLowerCase() === 'exited').length

  const filterOptions = [
    { label: 'Todos', value: 'all', count: rawContainers.length },
    { label: 'Activos', value: 'running', count: runningCount },
    { label: 'Detenidos', value: 'exited', count: exitedCount },
    { label: 'Pausados', value: 'paused', count: rawContainers.filter((c) => c.status.toLowerCase() === 'paused').length },
  ]

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans selection:bg-blue-500 selection:text-white">
      <Navbar
        onRefresh={refetch}
        loading={loading}
        onOpenCreateModal={() => setIsCreateModalOpen(true)}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        {/* Banner de Error */}
        {error && (
          <div className="flex items-center justify-between p-4 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-xl text-sm animate-in fade-in">
            <div className="flex items-center gap-3">
              <AlertCircle className="w-5 h-5 shrink-0" />
              <span>{error}</span>
            </div>
            <button
              onClick={refetch}
              className="px-3 py-1 bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Reintentar
            </button>
          </div>
        )}

        {/* Toolbar: Filtros y Búsqueda */}
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
                      : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 border border-zinc-800/80'
                  }`}
                >
                  <span>{opt.label}</span>
                  <span
                    className={`px-1.5 py-0.2 rounded-full text-[10px] ${
                      active ? 'bg-blue-700 text-blue-100' : 'bg-zinc-800 text-zinc-500'
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
            <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Buscar por nombre, imagen o ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-1.5 text-xs bg-zinc-900 border border-zinc-800 rounded-xl text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-all"
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
          onOpenTerminal={(c) => setContainerForTerminal(c)}
          onRequestDelete={(c) => setContainerToDelete(c)}
        />
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

      {/* Modal de Terminal Interactivo */}
      <TerminalModal
        isOpen={!!containerForTerminal}
        container={containerForTerminal}
        onClose={() => setContainerForTerminal(null)}
      />

      {/* Modal de Creación de Contenedor */}
      <CreateContainerModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
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
