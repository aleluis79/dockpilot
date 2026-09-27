// SPDX-License-Identifier: AGPL-3.0-or-later
import React, { useEffect } from 'react'
import { MODAL_OVERLAY } from '../ui/modalOverlay'
import { Activity, X, Cpu, MemoryStick, Network, HardDrive, Eraser } from 'lucide-react'
import type { ContainerSummary } from '../../types/docker'
import type { StatsHistoryPoint } from '../../types/stats'
import { useDockerStats } from '../../hooks/useDockerStats'
import { formatBytes, formatPercent } from '../../utils/format'
import { StatsSparkline } from './StatsSparkline'

interface StatsModalProps {
  isOpen: boolean
  container: ContainerSummary | null
  onClose: () => void
}

type StatsLevel = 'ok' | 'warn' | 'critical'

const LEVEL_BAR: Record<StatsLevel, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  critical: 'bg-rose-500',
}

const LEVEL_TEXT: Record<StatsLevel, string> = {
  ok: 'text-emerald-700 dark:text-emerald-400',
  warn: 'text-amber-700 dark:text-amber-400',
  critical: 'text-rose-700 dark:text-rose-400',
}

const levelOf = (value: number): StatsLevel => {
  if (value > 90) return 'critical'
  if (value > 70) return 'warn'
  return 'ok'
}

const clamp = (value: number): number => Math.max(0, Math.min(100, value || 0))

interface MetricCardProps {
  title: string
  ariaLabel: string
  icon: React.ReactNode
  percent: number
  history: StatsHistoryPoint[]
  metric: 'cpu_percent' | 'memory_percent'
  color: string
  footer?: React.ReactNode
}

const MetricCard: React.FC<MetricCardProps> = ({
  title,
  ariaLabel,
  icon,
  percent,
  history,
  metric,
  color,
  footer,
}) => {
  const level = levelOf(percent)

  return (
    <div className="p-4 bg-inset/60 border border-default rounded-xl flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-xs uppercase tracking-wider font-semibold text-fg-muted">
          {icon}
          {title}
        </span>
        <span className={`text-2xl font-bold tabular-nums ${LEVEL_TEXT[level]}`}>
          {formatPercent(percent)}
        </span>
      </div>

      <div
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuenow={Math.round(percent) || 0}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-2 w-full bg-elevated rounded-full overflow-hidden"
      >
        <div
          data-level={level}
          className={`h-full rounded-full transition-all duration-500 ease-out ${LEVEL_BAR[level]}`}
          style={{ width: `${clamp(percent)}%` }}
        />
      </div>

      <StatsSparkline points={history} metric={metric} color={color} height={28} />

      {footer && <div className="text-[11px] text-fg-muted font-mono">{footer}</div>}
    </div>
  )
}

interface InfoCardProps {
  title: string
  icon: React.ReactNode
  accent: string
  rows: Array<{ label: string; value: string }>
}

const InfoCard: React.FC<InfoCardProps> = ({ title, icon, accent, rows }) => (
  <div className="p-4 bg-inset/60 border border-default rounded-xl flex flex-col gap-3">
    <span className={`flex items-center gap-2 text-xs uppercase tracking-wider font-semibold ${accent}`}>
      {icon}
      {title}
    </span>
    <div className="space-y-1.5">
      {rows.map((row) => (
        <div key={row.label} className="flex items-center justify-between text-xs">
          <span className="text-fg-muted">{row.label}</span>
          <span className="font-mono text-fg tabular-nums">{row.value}</span>
        </div>
      ))}
    </div>
  </div>
)

export const StatsModal: React.FC<StatsModalProps> = ({ isOpen, container, onClose }) => {
  const { currentStats, history, connected, error, clearHistory } = useDockerStats(
    container && isOpen ? container.id : null
  )

  // Cerrar al presionar la tecla Escape
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen || !container) return null

  const cleanName = container.name?.replace(/^\//, '') || container.id.slice(0, 12)

  return (
    <div
      className={`${MODAL_OVERLAY} p-3 sm:p-6 overflow-hidden font-sans`}
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl max-h-[85vh] flex flex-col bg-surface border border-default rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between gap-3 p-4 border-b border-default/80 bg-surface/90">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2 bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-xl border border-blue-500/20 shrink-0">
              <Activity className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base font-semibold text-fg">Métricas en Vivo</h2>
                <span className="font-mono text-xs px-2 py-0.5 rounded-md bg-elevated text-fg truncate">
                  {cleanName}
                </span>
                <span
                  className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${
                    connected
                      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20'
                      : 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20'
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      connected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400 animate-ping'
                    }`}
                  />
                  <span>{connected ? 'En vivo' : 'Conectando...'}</span>
                </span>
              </div>
              <p className="text-xs text-fg-muted font-mono mt-0.5">{container.image}</p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={clearHistory}
              title="Limpiar historial"
              className="p-1.5 text-fg-muted hover:text-fg hover:bg-fg/10 rounded-lg transition-colors flex items-center gap-1.5 text-xs font-medium cursor-pointer"
            >
              <Eraser className="w-4 h-4" />
              <span className="hidden sm:inline">Limpiar</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              title="Cerrar métricas"
              className="p-1.5 text-fg-muted hover:text-fg hover:bg-fg/10 rounded-lg transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {error && (
            <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-700 dark:text-rose-400 rounded-xl text-sm">
              {error}
            </div>
          )}

          {!currentStats && !error && (
            <div className="py-12 text-center text-fg-muted">
              <Activity className="w-8 h-8 mx-auto mb-2 animate-pulse text-blue-600 dark:text-blue-500" />
              <p className="text-sm">Esperando métricas...</p>
            </div>
          )}

          {currentStats && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <MetricCard
                  title="CPU"
                  ariaLabel="Uso de CPU"
                  icon={<Cpu className="w-3.5 h-3.5" />}
                  percent={currentStats.cpu_percent}
                  history={history}
                  metric="cpu_percent"
                  color="var(--color-chart-images)"
                  footer={`${history.length} muestras · ${currentStats.pids_current ?? 0} procesos`}
                />
                <MetricCard
                  title="Memoria"
                  ariaLabel="Uso de Memoria"
                  icon={<MemoryStick className="w-3.5 h-3.5" />}
                  percent={currentStats.memory_percent}
                  history={history}
                  metric="memory_percent"
                  color="var(--color-chart-containers)"
                  footer={`${formatBytes(currentStats.memory_usage)} / ${formatBytes(currentStats.memory_limit)}`}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <InfoCard
                  title="Red"
                  icon={<Network className="w-3.5 h-3.5" />}
                  accent="text-emerald-700 dark:text-emerald-400"
                  rows={[
                    { label: 'Recibido', value: formatBytes(currentStats.network_rx_bytes) },
                    { label: 'Transmitido', value: formatBytes(currentStats.network_tx_bytes) },
                  ]}
                />
                <InfoCard
                  title="Disco"
                  icon={<HardDrive className="w-3.5 h-3.5" />}
                  accent="text-amber-700 dark:text-amber-400"
                  rows={[
                    { label: 'Lectura', value: formatBytes(currentStats.block_read_bytes) },
                    { label: 'Escritura', value: formatBytes(currentStats.block_write_bytes) },
                  ]}
                />
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 px-4 py-3 border-t border-default/80 bg-surface/90 flex items-center justify-between gap-3 text-[11px] text-fg-muted">
          <span>
            {currentStats
              ? `Última muestra: ${currentStats.timestamp}`
              : 'Los datos se emiten continuamente por el daemon Docker.'}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 bg-elevated hover:bg-fg/10 text-fg text-xs rounded-lg transition-colors cursor-pointer shrink-0"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  )
}
