// SPDX-License-Identifier: AGPL-3.0-or-later
import { Server, Cpu, MemoryStick, HardDrive, Layers, Package, Box, Database } from 'lucide-react'
import { useSystemOverview } from '../../hooks/useSystemOverview'
import { formatBytes } from '../../utils/format'
import type { ResourceUsage, TopConsumer } from '../../types/system'

function UsageBlock({
  icon: Icon,
  label,
  usage,
}: {
  icon: typeof Package
  label: string
  usage: ResourceUsage
}) {
  return (
    <div className="flex items-start gap-2.5 p-3 bg-elevated rounded-lg border border-default">
      <Icon className="w-4 h-4 mt-0.5 shrink-0 text-fg-subtle" />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-fg">{label}</div>
        <div className="text-[11px] text-fg-subtle mt-0.5">
          {usage.total_count} en total · {usage.active_count} en uso
        </div>
        <div className="text-[11px] text-fg-subtle">
          {formatBytes(usage.total_size)} ocupados
        </div>
        <div
          className={`text-[11px] mt-0.5 ${
            usage.reclaimable > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-fg-subtle'
          }`}
        >
          {formatBytes(usage.reclaimable)} recuperables
        </div>
      </div>
    </div>
  )
}

function ConsumerList({
  title,
  consumers,
  emptyLabel,
}: {
  title: string
  consumers: TopConsumer[]
  emptyLabel: string
}) {
  return (
    <div className="min-w-0">
      <h4 className="text-xs font-semibold text-fg mb-1.5">{title}</h4>
      {consumers.length === 0 ? (
        <p className="text-[11px] text-fg-subtle">{emptyLabel}</p>
      ) : (
        <ul className="space-y-1">
          {consumers.map((consumer) => (
            <li
              key={`${consumer.kind}-${consumer.name}`}
              data-testid="top-consumer"
              className="flex items-baseline justify-between gap-2 text-[11px]"
            >
              <span className="font-mono text-fg truncate" title={consumer.name}>
                {consumer.name}
              </span>
              <span className="flex items-baseline gap-2 shrink-0">
                <span className="text-fg-subtle">{consumer.detail}</span>
                <span className="text-fg font-medium">{formatBytes(consumer.size)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Detalle del host: identificación, desglose de uso y mayores consumidores.
 *
 * Los datos llegan por prop desde `SystemSummaryBar`, que ya hizo la petición, para
 * no duplicar la llamada al daemon al abrir y cerrar el panel.
 */
export function SystemDetailPanel() {
  const { overview, loading } = useSystemOverview()

  if (loading || !overview) {
    return <div className="p-4 text-xs text-fg-subtle">Cargando detalle del host...</div>
  }

  const { info, usage } = overview

  return (
    <div className="p-4 space-y-4" data-testid="system-detail">
      <div>
        <h3 className="text-xs font-semibold text-fg mb-2">Host</h3>
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-[11px]">
          <div className="flex gap-1.5">
            <dt className="text-fg-subtle">Sistema</dt>
            <dd className="text-fg truncate">{info.os_name || 'desconocido'}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-fg-subtle">Núcleo</dt>
            <dd className="text-fg font-mono truncate">{info.kernel_version || '-'}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-fg-subtle">Arquitectura</dt>
            <dd className="text-fg font-mono">{info.architecture || '-'}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-fg-subtle">Host</dt>
            <dd className="text-fg font-mono truncate">{info.hostname || '-'}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-fg-subtle">Raíz de Docker</dt>
            <dd className="text-fg font-mono truncate">{info.docker_root_dir || '-'}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-fg-subtle">Driver</dt>
            <dd className="text-fg font-mono">{info.storage_driver || '-'}</dd>
          </div>
        </dl>
      </div>

      <div>
        <h3 className="text-xs font-semibold text-fg mb-2">Uso de disco</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2" data-testid="usage-blocks">
          <UsageBlock icon={Package} label="Imágenes" usage={usage.images} />
          <UsageBlock icon={Box} label="Contenedores" usage={usage.containers} />
          <UsageBlock icon={Database} label="Volúmenes" usage={usage.volumes} />
        </div>
        <p className="text-[11px] text-fg-subtle mt-2 flex items-center gap-1.5">
          <Layers className="w-3.5 h-3.5" />
          <span data-testid="layers-size">{formatBytes(usage.layers_size)}</span> de capas compartidas entre imágenes ·{' '}
          {formatBytes(usage.build_cache_size)} de caché de builds
        </p>
        <p className="text-[11px] text-fg-subtle mt-0.5">
          Las capas compartidas se informan aparte: sumarlas al total de imágenes contaría el mismo
          espacio dos veces.
        </p>
      </div>

      <div>
        <h3 className="text-xs font-semibold text-fg mb-2">Mayores consumidores</h3>
        {overview.top_images.length === 0 && overview.top_volumes.length === 0 ? (
          <p className="text-[11px] text-fg-subtle">
            Sin datos de consumo por recurso: el daemon no informó de desglos por elemento.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <ConsumerList
              title="Imágenes"
              consumers={overview.top_images}
              emptyLabel="Sin datos de consumo por recurso."
            />
            <ConsumerList
              title="Volúmenes"
              consumers={overview.top_volumes}
              emptyLabel="Sin datos de consumo por recurso."
            />
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
        <Server className="w-3.5 h-3.5" />
        <span>
          {info.containers_running} en ejecución · {info.containers_stopped} detenidos ·{' '}
          {info.containers_paused} pausados
        </span>
        <Cpu className="w-3.5 h-3.5 ml-2" />
        <MemoryStick className="w-3.5 h-3.5 ml-2" />
        <HardDrive className="w-3.5 h-3.5 ml-2" />
      </div>
    </div>
  )
}
