import React, { useEffect } from 'react'
import { MODAL_OVERLAY } from '../ui/modalOverlay'
import type { ContainerSummary } from '../../types/docker'
import { useDockerLogs } from '../../hooks/useDockerLogs'
import { LogsViewer } from './LogsViewer'

interface LogsModalProps {
  container: ContainerSummary | null
  onClose: () => void
}

export const LogsModal: React.FC<LogsModalProps> = ({ container, onClose }) => {
  const { logs, connected, error, clearLogs } = useDockerLogs(container ? container.id : null)

  // Cerrar modal al presionar la tecla Escape
  useEffect(() => {
    if (!container) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [container, onClose])

  if (!container) return null

  return (
    <div
      className={`${MODAL_OVERLAY} p-3 sm:p-6 overflow-hidden`}
      onClick={onClose}
    >
      <div
        className="w-full max-w-5xl h-[85vh] max-h-[85vh] min-h-0 flex flex-col rounded-2xl overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <LogsViewer
          logs={logs}
          connected={connected}
          containerName={container.name}
          error={error}
          onClear={clearLogs}
          onClose={onClose}
        />
      </div>
    </div>
  )
}
