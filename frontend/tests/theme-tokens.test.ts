import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// `import.meta.url` no es una URL de esquema file bajo el entorno jsdom,
// así que se resuelve desde la raíz del proyecto (donde Vitest se ejecuta).
const SRC_DIR = resolve(process.cwd(), 'src')

/** Familias de escala neutra prohibidas en componentes (ver SPEC-06 §2.3). */
const FORBIDDEN = /\b(?:bg|text|border|ring|divide|placeholder|from|via|to|shadow|outline|decoration|accent|caret|fill|stroke)-(?:zinc|gray|grey|slate|neutral|stone)(?:-\d{2,3})?(?:\/\d+)?\b/g

const collectFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (entry === 'node_modules' || entry === 'assets') return []
    if (/\.(tsx|ts)$/.test(entry)) return [full]
    try {
      return readdirSync(full) ? collectFiles(full) : []
    } catch {
      return []
    }
  })

describe('arquitectura de tokens de tema', () => {
  const files = collectFiles(SRC_DIR)

  it('encuentra fuentes sobre las que auditar', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('no reintroduce colores neutros literales en los componentes', () => {
    const offenders: string[] = []

    for (const file of files) {
      const content = readFileSync(file, 'utf-8')
      content.split('\n').forEach((line, index) => {
        const matches = line.match(FORBIDDEN)
        if (matches) {
          const relative = file.replace(`${SRC_DIR}/`, '')
          offenders.push(
            `  ${relative}:${index + 1} -> ${[...new Set(matches)].join(', ')}`
          )
        }
      })
    }

    expect(
      offenders,
      `Se han encontrado clases de color neutras literales. Usa los tokens del ` +
        `sistema de temas (bg-base, bg-surface, bg-elevated, bg-inset, text-fg, ` +
        `text-fg-muted, text-fg-subtle, border-default, border-strong):\n${offenders.join('\n')}`
    ).toEqual([])
  })
})
