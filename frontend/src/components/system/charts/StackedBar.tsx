// SPDX-License-Identifier: AGPL-3.0-or-later

export interface Tramo {
  label: string
  value: number
  /**
   * Token del tema, no un color: `var(--color-chart-images)`.
   *
   * Es un atributo de estilo, no una clase, así que el guard de tokens no lo
   * cubre por la vía de las utilidades. Por eso `theme-tokens.test.ts` escanea
   * también `stroke` y `fill`, y por eso aquí no se admite un hexo (SPEC-16 §3.3).
   */
  color: string
  /** Cómo pintar el valor en la leyenda. Por defecto, el número tal cual. */
  format?: (value: number) => string
}

interface StackedBarProps {
  titulo: string
  tramos: Tramo[]
  /** Texto cuando no hay nada que repartir. */
  vacio?: string
}

/**
 * Barra apilada horizontal, con la proporción repartida entre tramos.
 *
 * Se eligió una barra y no una gráfica de tartas porque con cuatro o cinco
 * categorías la longitud se compara con precisión y el ángulo no. Y porque una
 * barra se lee sin ambigüedad en un texto alternativo: «Imágenes 600» no admite
 * dos lecturas, un sector de 216 grados sí.
 *
 * Sin librería de por medio: es un `div` con `width`, que es lo mismo que hace
 * `StatsModal` con su barra de nivel (SPEC-16 §3.2).
 */
export function StackedBar({ titulo, tramos, vacio = 'Sin datos' }: StackedBarProps) {
  // Un valor negativo no tiene anchura posible y rompería el reparto. Se ignora
  // en vez de intentar arreglarlo: el dato raro se ve en la cifra de al lado.
  const utiles = tramos
    .filter((t) => Number.isFinite(t.value) && t.value > 0)
    .sort((a, b) => b.value - a.value)

  const total = utiles.reduce((suma, t) => suma + t.value, 0)

  if (total <= 0) {
    // Una barra vacía parecería un 0 % del total, que es una afirmación distinta
    // de "no hay nada que medir".
    return (
      <p className="text-[11px] text-fg-subtle" data-testid="stacked-vacio">
        {vacio}
      </p>
    )
  }

  const porcentaje = (valor: number) => (valor / total) * 100

  return (
    <div className="min-w-0" data-testid="stacked-barra">
      <div
        role="img"
        aria-label={`${titulo}: ${utiles
          .map((t) => `${t.label} ${(t.format ?? String)(t.value)}`)
          .join(', ')}`}
        className="h-2.5 w-full flex overflow-hidden rounded-full bg-elevated"
      >
        {utiles.map((t) => (
          <div
            key={t.label}
            data-testid={`stacked-tramo-${t.label}`}
            title={`${t.label}: ${(t.format ?? String)(t.value)}`}
            style={{
              width: `${porcentaje(t.value)}%`,
              // Sin color declarado la trama se quedaría transparente y la barra
              // parecería un hueco: es mejor un token inválido visible que un
              // silencio.
              backgroundColor: t.color || 'var(--color-fg-subtle)',
            }}
          />
        ))}
      </div>

      <ul className="mt-1.5 space-y-0.5">
        {utiles.map((t) => (
          <li
            key={t.label}
            data-testid={`stacked-leyenda-${t.label}`}
            className="flex items-center gap-1.5 text-[11px] text-fg-muted"
          >
            <span
              aria-hidden="true"
              className="w-2 h-2 rounded-sm shrink-0"
              style={{ backgroundColor: t.color || 'var(--color-fg-subtle)' }}
            />
            <span className="truncate">{t.label}</span>
            <span className="ml-auto font-mono tabular-nums text-fg-subtle">
              {(t.format ?? String)(t.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
