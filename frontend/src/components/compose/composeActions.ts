// SPDX-License-Identifier: AGPL-3.0-or-later
import { FileText, Play, Square, Trash2, ArrowDownToLine, Ban, type LucideIcon } from 'lucide-react'
import type { ComposeAction } from '../../types/compose'

/**
 * Vocabulario de iconos de las acciones, compartido por toda la interfaz.
 *
 * El panel ya tenía un criterio en `containers/ActionButtons.tsx`: el icono **y**
 * el color del hover dicen qué va a pasar. Emerald arranca, ámbar para, rosa
 * borra, azul consulta. La tabla de proyectos usaba otro criterio distinto, y
 * `logs` aparecía con el icono de terminal, que en este panel significa shell.
 *
 * Vive aquí, y no duplicado en cada componente, por la misma razón que existe
 * `ui/modalOverlay.ts`: cuatro modales con cuatro velos distintos acabaron
 * necesitándose centralizar, y esto es el mismo fallo en otra forma.
 *
 * Si alguna vez cambia el criterio de `ActionButtons.tsx`, se cambia aquí y en
 * los dos sitios a la vez.
 */
export interface AccionVisual {
  icon: LucideIcon
  /** Color con el que se resalta el botón al pasar el ratón. */
  hover: string
}

const HOV = {
  /** Arranca algo: verde, como en el botón de iniciar un contenedor. */
  arranca: 'hover:text-emerald-700 dark:hover:text-emerald-400 hover:bg-emerald-500/10',
  /** Para algo: ámbar, como en el botón de detener un contenedor. */
  para: 'hover:text-amber-700 dark:hover:text-amber-400 hover:bg-amber-500/10',
  /** Borra algo: rosa, como en el botón de eliminar un contenedor. */
  borra: 'hover:text-rose-700 dark:hover:text-rose-400 hover:bg-rose-500/10',
  /** Consulta: azul, como en los de logs y métricas. */
  consulta: 'hover:text-blue-700 dark:hover:text-blue-400 hover:bg-blue-500/10',
} as const

/** Icono y color de cada acción del ciclo de vida de un proyecto. */
export const VISUAL_ACCION: Record<ComposeAction, AccionVisual> = {
  // `up` levanta contenedores: el mismo gesto que iniciarlos a mano.
  up: { icon: Play, hover: HOV.arranca },
  // `stop` los detiene sin borrarlos: el mismo gesto que detenerlos a mano.
  stop: { icon: Square, hover: HOV.para },
  // `down` se lleva contenedores y red. Es borrar, no "bajar un nivel": por eso
  // lleva el icono de papelera y no una flecha hacia abajo, que además no
  // significaba nada respecto a nada.
  down: { icon: Trash2, hover: HOV.borra },
  // `logs` es una consulta, y en este panel el icono de logs es `FileText`.
  logs: { icon: FileText, hover: HOV.consulta },
  // `pull` no tiene equivalente por contenedor: descarga imágenes sin arrancar
  // nada, así que comparte el azul de las consultas.
  pull: { icon: ArrowDownToLine, hover: HOV.consulta },
}

/**
 * Cancelar una acción en curso.
 *
 * No reutiliza `Square`, que en este panel significa «parar el proyecto»: parar
 * algo que se está levantando no es lo mismo que cortar el comando que lo levanta.
 */
export const VISUAL_CANCELAR: AccionVisual = {
  icon: Ban,
  hover: 'hover:text-rose-700 dark:hover:text-rose-400 hover:bg-rose-500/10',
}

/** Etiqueta corta de cada acción, para `title` y `aria-label`. */
export const ETIQUETA_ACCION: Record<ComposeAction, string> = {
  up: 'Levantar',
  stop: 'Parar',
  down: 'Bajar',
  logs: 'Logs',
  pull: 'Descargar imágenes',
}

/** Clases base de un botón de acción de tabla, idénticas a las de contenedores. */
export const CLASE_BOTON_ACCION = 'p-1.5 text-fg-muted rounded transition-colors cursor-pointer'
