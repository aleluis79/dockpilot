// SPDX-License-Identifier: AGPL-3.0-or-later
import { FileCode2, Wand2 } from 'lucide-react'

const EJEMPLO = `services:
  web:
    image: nginx:1.27
    ports:
      - "8080:80"
    volumes:
      - datos:/srv/datos
    networks:
      - front
    environment:
      - CLAVE=valor

  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
    volumes:
      - datos:/var/lib/postgresql/data

volumes:
  datos:

networks:
  front:
    driver: bridge
`

interface ComposeEditorProps {
  value: string
  onChange: (value: string) => void
  /** Contenido original del disco, para avisar de que hay cambios sin guardar. */
  original?: string
}

/**
 * Editor del YAML de compose.
 *
 * Existe para **probar un cambio y ver el plan que produce**, no para
 * reemplazar el archivo: el panel no escribe en el disco del usuario. Por eso no
 * hay botón de guardar, y el texto lo dice (SPEC-12 §1).
 */
export function ComposeEditor({ value, onChange, original }: ComposeEditorProps) {
  const editado = original !== undefined && value !== original

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <label
          htmlFor="compose-editor"
          className="text-xs font-semibold text-fg flex items-center gap-1.5"
        >
          <FileCode2 className="w-3.5 h-3.5 text-fg-subtle" />
          Contenido
        </label>
        <div className="flex items-center gap-2">
          {editado && (
            <span
              data-testid="editor-dirty"
              className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20"
            >
              editado
            </span>
          )}
          <button
            type="button"
            onClick={() => onChange(EJEMPLO)}
            className="text-[11px] px-2 py-1 rounded text-fg-muted hover:text-fg hover:bg-elevated-hover transition-colors flex items-center gap-1"
          >
            <Wand2 className="w-3 h-3" />
            Pegar ejemplo
          </button>
        </div>
      </div>

      <textarea
        id="compose-editor"
        data-testid="compose-editor"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        placeholder="services:"
        className="flex-1 min-h-48 w-full p-2.5 text-xs font-mono bg-inset border border-default rounded-lg text-fg placeholder-fg-subtle focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 resize-y"
      />

      <p className="text-[10px] text-fg-subtle mt-1.5">
        El contenido editado <strong>no se guarda</strong> en el disco: solo se usa para
        ver el plan que produce.
      </p>
    </div>
  )
}
