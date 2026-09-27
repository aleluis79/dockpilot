// SPDX-License-Identifier: AGPL-3.0-or-later
import { formatBytes } from '../../../utils/format'
import type { TopConsumer } from '../../../types/system'

interface ConsumerBarsProps {
  titulo: string
  consumidores: TopConsumer[]
  format?: (value: number) => string
  /** Se llama al pulsar una fila, para llevar a la vista correspondiente. */
  onSelect?: (consumidor: TopConsumer) => void
}

/**
 * Barras proporcionales de los mayores consumidores de disco.
 *
 * Antes era una lista de texto con el tamaño al lado, que obligaba a comparar
 * mentalmente seis números. Con la barra, qué se lleva el espacio se ve de un
 * vistazo, y el número sigue ahí para dar el valor exacto (SPEC-16 §1).
 */
export function ConsumerBars({
  titulo,
  consumidores,
  format = formatBytes,
  onSelect,
}: ConsumerBarsProps) {
  const utiles = consumidores
    .filter((c) => Number.isFinite(c.size) && c.size > 0)
    .sort((a, b) => b.size - a.size)

  const maximo = utiles.length > 0 ? utiles[0].size : 0

  if (maximo <= 0) {
    return (
      <p className="text-[11px] text-fg-subtle" data-testid="consumer-vacio">
        Sin datos
      </p>
    )
  }

  return (
    <ul className="space-y-1.5" data-testid="consumer-bars" aria-label={titulo}>
      {utiles.map((c) => {
        const ancho = (c.size / maximo) * 100
        const cuerpo = (
          <>
            <span
              data-testid={`consumer-nombre-${c.name}`}
              data-consumer={c.name}
              className="text-[11px] text-fg truncate"
              title={c.name}
            >
              {c.name}
            </span>
            {c.detail && (
              <span className="text-[10px] text-fg-subtle truncate">{c.detail}</span>
            )}
            <span className="ml-auto text-[11px] font-mono tabular-nums text-fg-muted shrink-0">
              {format(c.size)}
            </span>
            <span
              data-testid={`consumer-barra-${c.name}`}
              aria-hidden="true"
              className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-chart-images/70"
              style={{ width: `${ancho}%` }}
            />
          </>
        )

        return (
          <li key={c.name} className="relative" data-testid={`consumer-fila-${c.name}`}>
            {onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(c)}
                className="w-full flex items-center gap-2 text-left pb-1 hover:text-fg transition-colors cursor-pointer"
              >
                {cuerpo}
              </button>
            ) : (
              <div className="w-full flex items-center gap-2 pb-1">{cuerpo}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
