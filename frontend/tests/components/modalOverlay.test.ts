import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { MODAL_OVERLAY } from '../../src/components/ui/modalOverlay'

const SRC_DIR = resolve(process.cwd(), 'src')
const CANONICAL_FILE = join(SRC_DIR, 'components', 'ui', 'modalOverlay.ts')

const collectFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (entry === 'assets') return []
    if (!statSync(full).isDirectory()) return []
    return [
      ...readdirSync(full)
        .filter((child) => child.endsWith('.tsx'))
        .map((child) => join(full, child)),
      ...collectFiles(full),
    ]
  })

describe('velo de los modales', () => {
  // Un "overlay" se detecta por cualquiera de these dos señales: consumir la
  // constante compartida, o declarar el velo a mano (que es justo lo que
  // este test prohíbe). Tras centralizar, `fixed inset-0` ya no aparece en
  // los modales porque vive dentro de MODAL_OVERLAY.
  const overlays = collectFiles(SRC_DIR).filter((file) => {
    if (file === CANONICAL_FILE) return false
    const content = readFileSync(file, 'utf-8')
    return content.includes('MODAL_OVERLAY') || content.includes('fixed inset-0')
  })

  const handRolled = overlays.filter((file) =>
    /bg-black\/\d+/.test(readFileSync(file, 'utf-8'))
  )

  it('hay varios modales con overlay en la aplicación', () => {
    // Si este test falla, la app ha dejado de usar overlays: hay que revisarlo
    // antes de tocar nada, porque el resto de aserciones quedarían en verde vacío.
    expect(overlays.length).toBeGreaterThanOrEqual(5)
  })

  it('ningún modal declara su propia opacidad de velo', () => {
    expect(
      handRolled.map((f) => f.replace(`${SRC_DIR}/`, '')),
      `Usa MODAL_OVERLAY de src/components/ui/modalOverlay.ts en lugar de ` +
        `declarar el velo a mano: bg-black/NN escrito en un componente es la ` +
        `causa directa de que los overlays divergan entre sí.`
    ).toEqual([])
  })

  it('todos los overlays consumen la constante compartida', () => {
    const users = overlays.filter((file) =>
      readFileSync(file, 'utf-8').includes('MODAL_OVERLAY')
    )
    expect(users.sort()).toEqual(overlays.sort())
  })

  it('la constante canónica no se ha modificado', () => {
    expect(MODAL_OVERLAY).toBe(
      'fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm animate-fade-in'
    )
  })

  it('usa una animación de entrada que existe en este proyecto', () => {
    // `animate-in fade-in` venía del plugin `tailwindcss-animate`, que no está
    // instalado: las clases no existían y el fundido nunca se ejecutaba.
    expect(MODAL_OVERLAY).not.toContain('animate-in')
    expect(MODAL_OVERLAY).toContain('animate-fade-in')
  })
})
