// SPDX-License-Identifier: AGPL-3.0-or-later
import { Layers } from 'lucide-react'

interface ComposeBadgeProps {
  /** Proyecto compose del recurso, o `null`/`undefined` si no lo tiene. */
  project?: string | null
}

/**
 * Insignia del proyecto compose al que pertenece un recurso.
 *
 * No renderiza nada cuando el recurso no es de un proyecto: en una tabla de
 * contenedores, redes o volúmenes hay más recursos sueltos que de proyecto, y
 * una columna vacía en la mayoría de las filas es ruido (SPEC-11 §3.5).
 */
export function ComposeBadge({ project }: ComposeBadgeProps) {
  if (!project) return null

  return (
    <span
      data-testid="compose-badge"
      title={`Proyecto Docker Compose: ${project}`}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 text-[10px] font-mono max-w-full"
    >
      <Layers className="w-3 h-3 shrink-0" />
      <span className="truncate">{project}</span>
    </span>
  )
}
