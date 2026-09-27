import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// `import.meta.url` no es una URL de esquema file bajo el entorno jsdom,
// así que se resuelve desde la raíz del proyecto (donde Vitest se ejecuta).
const SRC_DIR = resolve(process.cwd(), 'src')
const CSS_PATH = resolve(SRC_DIR, 'index.css')

/** Familias de escala neutra prohibidas en componentes (ver SPEC-06 §2.3). */
const FORBIDDEN = /\b(?:bg|text|border|ring|divide|placeholder|from|via|to|shadow|outline|decoration|accent|caret|fill|stroke)-(?:zinc|gray|grey|slate|neutral|stone)(?:-\d{2,3})?(?:\/\d+)?\b/g

/**
 * Paletas de Tailwind que SÍ existen y no son tokens del proyecto.
 *
 * `text-white`, `bg-blue-600` o `text-amber-400` son clases legítimas de la
 * librería; lo que no vale es inventar un nombre de token propio (`bg-card`)
 * esperando que exista en `@theme`.
 */
const BUILTIN_PALETTES = new Set([
  'inherit', 'current', 'transparent', 'black', 'white',
  'slate', 'gray', 'zinc', 'neutral', 'stone', 'red', 'orange', 'amber',
  'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue',
  'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
])

/** Prefijos de utilidad que consumen un token de color propio. */
const COLOR_UTILITIES = /(?:^|[\s"'`])(?:[a-z-]+:)*(bg|text|border|ring|divide|placeholder|from|via|to|fill|stroke|accent|caret|outline|decoration)-([a-z][a-z0-9-]*)/g

/** Palabras que aparecen tras el guion pero no son colores. */
const NOT_A_COLOR = new Set([
  'inset', 'solid', 'gradient', 'none', 'clip', 'ellipsis', 'circle', 'square',
  'auto', 'full', 'screen', 'table', 'flex', 'grid', 'block', 'inline',
  'inline-block', 'hidden', 'contents', 'flow-root',
  'sans', 'serif', 'mono',
  'left', 'right', 'center', 'justify', 'start', 'end', 'match-parent',
  'uppercase', 'lowercase', 'capitalize', 'normal-case',
  'underline', 'overline', 'line-through', 'no-underline',
  'truncate', 'balance', 'pretty',
  'wrap', 'nowrap', 'break-normal', 'break-words', 'break-all', 'break-keep',
  'dotted', 'dashed', 'double', 'groove', 'ridge', 'outset', 'miter', 'bevel',
  'round', 'butt', 'thin', 'medium', 'extralight',
  'lighter', 'bold', 'bolder', 'italic', 'oblique', 'not-italic',
  'tabular', 'proportional', 'slashed', 'zero', 'reverse', 'ordinal', 'lining',
  'transition', 'transform', 'transform-gpu', 'transform-none', 'backdrop',
  'spacing', 'collapse', 'fixed', 'local', 'scroll',
  'top', 'bottom', 'start', 'end', 'x', 'y', 'b', 't', 'l', 'r',
  'object', 'aspect', 'columns', 'break-after', 'break-before', 'list',
])

/**
 * Escala tipográfica de `text-*`, que comparte prefijo con el color y no es un
 * token: `text-sm` es tamaño de fuente, no "color sm".
 */
const FONT_SIZES = new Set([
  'xs', 'sm', 'base', 'lg', 'xl',
  '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl',
])

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

  /**
   * En Tailwind v4 una utilidad cuyo color no está declarado en `@theme`
   * simplemente no se genera: la clase queda como texto muerto y el elemento sale
   * sin ese color, sin ningún aviso. Ya ha pasado dos veces
   * (`hover:bg-elevated-hover` en 8 componentes y `bg-card` en 3 modales), así
   * que la comprobación es automática.
   */
  it('no usa tokens de color que no estén declarados en index.css', () => {
    const css = readFileSync(CSS_PATH, 'utf-8')
    const declared = new Set(
      [...css.matchAll(/--color-([a-z-]+)\s*:/g)].map((m) => m[1])
    )
    const offenders: string[] = []

    for (const file of files) {
      const content = readFileSync(file, 'utf-8')
      content.split('\n').forEach((line, index) => {
        for (const match of line.matchAll(COLOR_UTILITIES)) {
          const value = match[2]
          const base = value.split('/')[0]
          if (declared.has(base)) continue
          if (BUILTIN_PALETTES.has(base)) continue
          if (FONT_SIZES.has(base)) continue
          if (NOT_A_COLOR.has(base)) continue
          // `blue-600`, `amber-400`: palette + number, o sea una clase de Tailwind.
          if (/^[a-z]+-\d{2,3}$/.test(base)) continue
          const relative = file.replace(`${SRC_DIR}/`, '')
          offenders.push(`  ${relative}:${index + 1} -> ${match[0].trim()} (falta --color-${base})`)
        }
      })
    }

    expect(
      offenders,
      `Estas clases no generan nada porque su token no existe en ` +
        `frontend/src/index.css, así que el elemento se queda sin ese color:\n` +
        offenders.join('\n')
    ).toEqual([])
  })
})
