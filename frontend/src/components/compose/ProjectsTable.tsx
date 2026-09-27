// SPDX-License-Identifier: AGPL-3.0-or-later
import { AlertTriangle, Layers } from 'lucide-react'
import type { ComposeAction, ComposeProjectSummary } from '../../types/compose'
import { rutaDeProyecto } from '../../utils/compose'
import {
  CLASE_BOTON_ACCION,
  ETIQUETA_ACCION,
  VISUAL_ACCION,
} from './composeActions'

interface ProjectsTableProps {
  projects: ComposeProjectSummary[]
  onSelect: (project: ComposeProjectSummary) => void
  /** Lanza una acción del ciclo de vida. `path` sale de `config_files`. */
  onAccion?: (project: ComposeProjectSummary, action: ComposeAction) => void
  /** Abrir el diálogo de `down`. Va aparte porque necesita los nombres. */
  onBajar?: (project: ComposeProjectSummary) => void
}

function ConfigFile({ files }: { files: string[] }) {
  if (files.length === 0) {
    return <span className="text-fg-subtle italic">sin archivo conocido</span>
  }
  const [primero, ...resto] = files
  return (
    <span className="flex items-baseline gap-1 min-w-0">
      <span className="font-mono truncate" title={files.join(', ')}>
        {primero}
      </span>
      {/* `project.config_files` es una lista separada por comas: con `-f a.yml
          -f b.yml` el proyecto tiene dos archivos y aquí caben los dos. */}
      {resto.length > 0 && (
        <span
          className="text-fg-subtle shrink-0"
          title={files.join(', ')}
          data-testid="extra-config-files"
        >
          +{resto.length}
        </span>
      )}
    </span>
  )
}

export function ProjectsTable({
  projects,
  onSelect,
  onAccion,
  onBajar,
}: ProjectsTableProps) {
  if (projects.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center p-12 bg-surface/50 rounded-xl border border-default text-fg-muted"
        data-testid="projects-empty"
      >
        <Layers className="w-10 h-10 mb-2 stroke-1 text-fg-subtle" />
        <p className="text-sm font-medium text-fg-muted">
          No hay ningún proyecto de Docker Compose en este host
        </p>
        <p className="text-xs text-fg-subtle mt-1">
          Un proyecto aparece aquí cuando compose crea sus recursos, no cuando el
          archivo existe en disco
        </p>
      </div>
    )
  }

  return (
    <div
      className="overflow-x-auto rounded-xl border border-default bg-surface/40 backdrop-blur"
      data-testid="projects-table"
    >
      <table className="w-full text-left text-sm text-fg">
        <thead className="bg-surface/80 text-xs uppercase tracking-wider text-fg-muted border-b border-default">
          <tr>
            <th className="py-3.5 px-4 font-semibold">Proyecto</th>
            <th className="py-3.5 px-4 font-semibold">Estado</th>
            <th className="py-3.5 px-4 font-semibold text-right">Contenedores</th>
            <th className="py-3.5 px-4 font-semibold text-right">Redes</th>
            <th className="py-3.5 px-4 font-semibold text-right">Volúmenes</th>
            <th className="py-3.5 px-4 font-semibold">Compose</th>
            <th className="py-3.5 px-4 font-semibold">Configuración</th>
            <th className="py-3.5 px-4 font-semibold text-right">Acciones</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-default/60 font-sans">
          {projects.map((project) => (
            <tr
              key={project.name}
              data-testid="project-row"
              onClick={() => onSelect(project)}
              className="hover:bg-elevated-hover cursor-pointer transition-colors group"
            >
              <td className="py-3.5 px-4">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-fg group-hover:text-blue-400 transition-colors">
                    {project.name}
                  </span>
                  {project.orphaned && (
                    <span
                      data-testid="orphaned-badge"
                      title="Sin contenedores, pero conserva red o volúmenes: ocupa espacio que compose ya no usa"
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20 text-[10px] font-semibold"
                    >
                      <AlertTriangle className="w-3 h-3" />
                      Huerfano
                    </span>
                  )}
                </div>
                {project.services_count > 0 && (
                  <span className="text-[11px] text-fg-subtle">
                    {project.services_count} servicios
                  </span>
                )}
              </td>
              <td className="py-3.5 px-4 text-xs text-fg-subtle">
                {project.containers_running > 0 ? 'En ejecución' : 'Detenido'}
              </td>
              <td className="py-3.5 px-4 text-right font-mono text-xs">
                {project.containers_running} / {project.containers_total}
              </td>
              <td className="py-3.5 px-4 text-right font-mono text-xs text-fg-muted">
                {project.networks_count}
              </td>
              <td className="py-3.5 px-4 text-right font-mono text-xs text-fg-muted">
                {project.volumes_count}
              </td>
              <td className="py-3.5 px-4 font-mono text-xs text-fg-muted">
                {project.compose_version || '—'}
              </td>
              <td className="py-3.5 px-4 text-xs text-fg-muted max-w-xs">
                <ConfigFile files={project.config_files} />
              </td>
              <td
                className="py-3.5 px-4 text-right"
                onClick={(e) => e.stopPropagation()}
              >
                {rutaDeProyecto(project) && (
                  <div className="flex items-center justify-end gap-1">
                    {(
                      [
                        { action: 'up' as const, accion: onAccion },
                        { action: 'stop' as const, accion: onAccion },
                        // `down` tiene su propia callback porque necesita los
                        // nombres de los volúmenes antes de confirmar.
                        { action: 'down' as const, accion: onBajar },
                        { action: 'logs' as const, accion: onAccion },
                      ]
                    ).map(({ action, accion }) => {
                      const { icon: Icon, hover } = VISUAL_ACCION[action]
                      const label = ETIQUETA_ACCION[action]
                      return (
                        <button
                          key={action}
                          type="button"
                          disabled={!accion}
                          onClick={() => accion?.(project, action)}
                          aria-label={`${label} el proyecto ${project.name}`}
                          title={label}
                          className={`${CLASE_BOTON_ACCION} ${hover} disabled:opacity-50 disabled:hover:bg-transparent`}
                        >
                          <Icon className="w-4 h-4" />
                        </button>
                      )
                    })}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
