// SPDX-License-Identifier: AGPL-3.0-or-later
import { Server, Cpu, MemoryStick, HardDrive, Layers, Package, Box, Database, ArrowRight } from 'lucide-react'
import { formatBytes, formatPercent } from '../../utils/format'
import type { ResourceUsage, TopConsumer, SystemOverview, CleanupTab } from '../../types/system'

/**
 * Porcentaje que el daemon considera recuperable sobre el total del recurso.
 *
 * El total se compara con el tipo **propio**: mezclar denominadores haría que
 * "1 MB recuperable" pareciera un problema cuando el total son 20 GB. Con
 * `total_size = 0` el resultado es 0 en vez de `Infinity` o `NaN`, que se
 * renderizarían literalmente en pantalla.
 */
function porcentajeRecuperable(usage: ResourceUsage): number {
  if (!usage.total_size) return 0
  return (usage.reclaimable / usage.total_size) * 100
}

function UsageBlock({
  icon: Icon,
  id,
  label,
  usage,
  tab,
  onNavigateTab,
}: {
  icon: typeof Package
  id: string
  label: string
  usage: ResourceUsage
  /** Pestaña a la que lleva la cifra recuperable. `undefined` = no hay destino. */
  tab?: CleanupTab
  onNavigateTab?: (tab: CleanupTab) => void
}) {
  const porcentaje = porcentajeRecuperable(usage)
  const destacado = usage.reclaimable > 0
  // Solo hay enlace si además de destino hay a quién avisar: un tipo sin vista
  // associated se queda como texto plano.
  const enlazable = tab !== undefined && onNavigateTab !== undefined

  return (
    <div
      className="flex items-start gap-2.5 p-3 bg-elevated rounded-lg border border-default"
      data-testid={`usage-${id}`}
    >
      <Icon className="w-4 h-4 mt-0.5 shrink-0 text-fg-subtle" />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-fg">{label}</div>
        <div className="text-[11px] text-fg-subtle mt-0.5">
          {usage.total_count} en total · {usage.active_count} en uso
        </div>
        <div className="text-[11px] text-fg-subtle">
          {formatBytes(usage.total_size)} ocupados
        </div>
        {/*
          La cifra recuperable es lo único accionable de la spec, así que es un
          botón cuando hay adónde ir. No se ejecuta ninguna limpieza desde aquí:
          solo lleva a la pestaña que ya la hace.
        */}
        {enlazable ? (
          <button
            type="button"
            onClick={() => onNavigateTab?.(tab)}
            className={`text-[11px] mt-0.5 flex items-center gap-1 text-left hover:underline cursor-pointer ${
              destacado ? 'text-amber-600 dark:text-amber-400' : 'text-fg-subtle'
            }`}
          >
            {formatBytes(usage.reclaimable)} recuperables{' '}
            <span>{formatPercent(porcentaje)}</span>
            {/* El destino solo existe para quien usa lector de pantalla: sin él
                el botón se anuncia como "1.0 GB recuperables 50.0%, botón" y no
                dice que lleva a otra vista. */}
            <span className="sr-only">, ir a la vista de {label}</span>
            <ArrowRight className="w-3 h-3 shrink-0" />
          </button>
        ) : (
          <div
            className={`text-[11px] mt-0.5 ${
              destacado ? 'text-amber-600 dark:text-amber-400' : 'text-fg-subtle'
            }`}
          >
            {formatBytes(usage.reclaimable)} recuperables <span>{formatPercent(porcentaje)}</span>
          </div>
        )}
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

interface SystemDetailPanelProps {
  overview: SystemOverview
  /**
   * Callback de navegación. Es opcional porque el panel se monta también sin
   * pestaña que abrir; en ese caso las cifras recuperables se muestran como
   * texto plano en vez de como enlaces.
   */
  onNavigateTab?: (tab: CleanupTab) => void
}

/**
 * Detalle del host: identificación, desglose de uso y mayores consumidores.
 *
 * El resumen llega por prop desde `SystemSummaryBar`, que ya hizo la petición:
 * pedirlo aquí abriría una segunda llamada idéntica al daemon cada vez que se
 * despliega el panel.
 */
export function SystemDetailPanel({ overview, onNavigateTab }: SystemDetailPanelProps) {
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
          <UsageBlock
            icon={Package}
            id="images"
            label="Imágenes"
            usage={usage.images}
            tab="images"
            onNavigateTab={onNavigateTab}
          />
          {/* Sin `tab`: no hay vista que recicle contenedores, así que su cifra
              recuperable se informa pero no lleva a ninguna parte. */}
          <UsageBlock
            icon={Box}
            id="containers"
            label="Contenedores"
            usage={usage.containers}
          />
          <UsageBlock
            icon={Database}
            id="volumes"
            label="Volúmenes"
            usage={usage.volumes}
            tab="volumes"
            onNavigateTab={onNavigateTab}
          />
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
            Sin datos de consumo por recurso: el daemon no informó de desgloses por elemento.
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
