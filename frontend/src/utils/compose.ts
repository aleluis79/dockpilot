// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ComposeProjectSummary } from '../types/compose'

/**
 * Ruta del archivo compose de un proyecto.
 *
 * Sale de la etiqueta `project.config_files` que compose pone en sus recursos.
 * Si un proyecto no la trae, la ruta es vacía: el panel no inventa una, porque
 * adivinar mal significaría ejecutar el comando sobre el archivo equivocado.
 */
export function rutaDeProyecto(project: ComposeProjectSummary): string {
  return project.config_files[0] ?? ''
}
