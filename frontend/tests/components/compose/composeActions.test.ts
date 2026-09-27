import { describe, it, expect } from 'vitest'
import { FileText, Play, Square, Trash2, Ban, ArrowDownToLine } from 'lucide-react'
import {
  ETIQUETA_ACCION,
  VISUAL_ACCION,
  VISUAL_CANCELAR,
} from '../../../src/components/compose/composeActions'

/**
 * El vocabulario de iconos de la tabla de proyectos tiene que coincidir con el de
 * la tabla de contenedores (`containers/ActionButtons.tsx`). Cuando divergieron,
 * `logs` aparecía con el icono de terminal —que aquí significa shell— y `down`
 * con una flecha que no significaba nada.
 *
 * Estos tests existen para que el próximo cambio de icono sea deliberado.
 */
describe('vocabulario de acciones de compose', () => {
  it('usa el icono de iniciar para levantar', () => {
    // Equivalente a "Iniciar contenedor" (Play).
    expect(VISUAL_ACCION.up.icon).toBe(Play)
  })

  it('usa el icono de detener para parar', () => {
    // Equivalente a "Detener contenedor" (Square).
    expect(VISUAL_ACCION.stop.icon).toBe(Square)
  })

  it('usa el icono de eliminar para bajar', () => {
    // `down` se lleva contenedores y red: es borrar, no "bajar un nivel".
    expect(VISUAL_ACCION.down.icon).toBe(Trash2)
  })

  it('usa el icono de logs para los logs, no el de terminal', () => {
    // Regresión: `logs` usaba `Terminal`, que en este panel significa shell.
    expect(VISUAL_ACCION.logs.icon).toBe(FileText)
  })

  it('mantiene la flecha de descarga para descargar imágenes', () => {
    // `pull` no tiene equivalente por contenedor, así que conserva su icono propio.
    expect(VISUAL_ACCION.pull.icon).toBe(ArrowDownToLine)
  })

  it('colorea el hover con el mismo criterio que los contenedores', () => {
    // Emerald arranca, ámbar para, rosa borra, azul consulta.
    expect(VISUAL_ACCION.up.hover).toMatch(/emerald/)
    expect(VISUAL_ACCION.stop.hover).toMatch(/amber/)
    expect(VISUAL_ACCION.down.hover).toMatch(/rose/)
    expect(VISUAL_ACCION.logs.hover).toMatch(/blue/)
    expect(VISUAL_ACCION.pull.hover).toMatch(/blue/)
  })

  it('no confunde cancelar con parar', () => {
    // Cancelar corta el comando en curso; parar detiene el proyecto. Si
    // compartieran icono, el usuario no podría distinguirlos de un vistazo.
    expect(VISUAL_CANCELAR.icon).not.toBe(VISUAL_ACCION.stop.icon)
    expect(VISUAL_CANCELAR.icon).toBe(Ban)
  })

  it('etiqueta cada acción en español y sin solapamientos', () => {
    const etiquetas = Object.values(ETIQUETA_ACCION)
    expect(etiquetas).toEqual(['Levantar', 'Parar', 'Bajar', 'Logs', 'Descargar imágenes'])
    expect(new Set(etiquetas).size).toBe(etiquetas.length)
  })

  it('cubre todas las acciones del ciclo de vida', () => {
    // Si `ComposeAction` crece y el vocabulario no, la acción nueva se quedaría
    // sin icono y el `tsc` lo delata; esto lo deja explícito.
    expect(Object.keys(VISUAL_ACCION).sort()).toEqual([
      'down',
      'logs',
      'pull',
      'stop',
      'up',
    ])
  })
})
