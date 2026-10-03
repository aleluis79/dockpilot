// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Tasas, ventanas y roturas de una serie de métricas (SPEC-17 §4.4).
 *
 * Todo son funciones puras y sin estado, y a propósito. Una tasa no es un dato
 * del daemon: es una **diferencia entre dos muestras** que depende de cuánto
 * tiempo pasó entre ellas. Si eso viviera dentro del backend, una muestra
 * perdida —una excepción, un tic que se pasó— dejaría la tasa mal en lugar de
 * simplemente faltar. Con absolutos, un hueco es un hueco, y el par que lo cruza
 * produce la media real del intervalo, que es un dato correcto.
 *
 * Y hay tres cosas que **no** son "un cero":
 *
 * 1. **La primera muestra** no tiene con quién compararse: `valor` es `null`.
 * 2. **El reinicio del contenedor** pone los contadores a cero, así que restar
 *    daría un negativo y tomar el absoluto daría una flecha de 40 GB. El punto
 *    se marca `corte` y el trazo se parte ahí.
 * 3. **El hueco** —un contenedor parado, un tic perdido— es una distancia en el
 *    tiempo, y el gráfico lo enseña como un corte en vez de unir dos extremos
 *    que no son comparables.
 */

import type { MetricKey, MetricSample, RateSample } from '../types/metrics'
import { CONTADOR_DE } from '../types/metrics'

/** Cuánto puede durar un intervalo sin que se considere un hueco. */
export const FACTOR_HUECO = 2.5

/** El hueco a partir del cual el trazo se parte, en segundos. */
export function umbralDeHueco(interval_s: number): number {
  return interval_s * FACTOR_HUECO
}

export type ContadorAcumulado =
  | 'network_rx_bytes'
  | 'network_tx_bytes'
  | 'block_read_bytes'
  | 'block_write_bytes'

/** El par del que sale cada tasa, según la clave que se pinte. */
export function contadorDe(clave: MetricKey): ContadorAcumulado | null {
  return (CONTADOR_DE[clave] as ContadorAcumulado | undefined) ?? null
}

/** ¿La clave es una tasa derivada o un valor absoluto? */
export function esTasa(clave: MetricKey): boolean {
  return contadorDe(clave) !== null
}

/**
 * Deriva la tasa de un contador acumulado entre dos muestras consecutivas.
 *
 * El intervalo es el **real** entre las dos muestras, no el periodo nominal del
 * muestreo. Con la diferencia pequeña que hay entre muestras de 2 s no se nota,
 * pero si el daemon tarda 9 s en un tic, dividir por el periodo nominal daría
 * una tasa 4,5 veces mayor que la real.
 */
export function tasa(anterior: MetricSample, actual: MetricSample, contador: ContadorAcumulado): RateSample {
  const dt = actual.t - anterior.t

  // El contador bajó: el contenedor se ha reiniciado y `anterior` no es
  // comparable con `actual`. Restar daría un negativo.
  if (actual[contador] < anterior[contador]) {
    return { t: actual.t, bytes_per_second: null, broken: true }
  }

  if (dt <= 0) {
    // Dos muestras con la misma `t` no tienen intervalo. No se inventa uno.
    return { t: actual.t, bytes_per_second: null, broken: false }
  }

  return {
    t: actual.t,
    bytes_per_second: (actual[contador] - anterior[contador]) / dt,
    broken: false,
  }
}

/** La serie de tasas de un contador a lo largo de toda la serie. */
export function tasas(muestras: MetricSample[], contador: ContadorAcumulado): RateSample[] {
  if (muestras.length < 2) {
    return []
  }
  return muestras.slice(1).map((m, i) => tasa(muestras[i], m, contador))
}

/**
 * Un punto de la serie, ya sea un porcentaje o una tasa.
 *
 * Es el único tipo que consume el gráfico, para que `MetricChart` no tenga que
 * ramificar por el tipo de métrica: si el valor no es comparable, `valor` es
 * `null` y `corte` dice si además hay que partir el trazo.
 */
export interface Punto {
  t: number;
  valor: number | null;
  /** Este punto no se une con el anterior. */
  corte: boolean;
}

/** La serie completa de una métrica, recortada a la ventana. */
export function serieDe(muestras: MetricSample[], clave: MetricKey, ventana_s: number): Punto[] {
  const ventana = cortar_ventana(muestras, ventana_s)
  const contador = contadorDe(clave)

  if (contador === null) {
    // Porcentaje: el valor de la muestra es el valor. No hay nada que derivar y
    // por eso tampoco hay nada que pueda estar roto. La clave se estrecha
    // porque aquí sólo pueden llegar `cpu_percent` y `memory_percent`: las otras
    // cuatro de `MetricKey` son tasas y tienen su rama.
    const campo = clave as 'cpu_percent' | 'memory_percent'
    return ventana.map((m) => ({ t: m.t, valor: m[campo], corte: false }))
  }

  const puntos: Punto[] = []
  if (ventana.length === 1) {
    // Una sola muestra no tiene tasa. Se dibuja como punto suelto, y no como
    // una línea desde cero, que afirmaría una medición que no se hizo.
    return [{ t: ventana[0].t, valor: null, corte: false }]
  }

  for (let i = 1; i < ventana.length; i++) {
    const r = tasa(ventana[i - 1], ventana[i], contador)
    puntos.push({ t: r.t, valor: r.bytes_per_second, corte: r.broken })
  }
  return puntos
}

/**
 * Parte la serie en tramos dibujables.
 *
 * Corta en dos sitios y por dos razones distintas, y son las dos que hacen que
 * una línea mienta:
 *
 * - **El salto** (`corte`): el contador bajó porque el contenedor se reinició.
 * - **El hueco**: entre dos muestras pasa más de 2,5 intervalos. Puede ser un
 *   contenedor parado o un tic perdido; no se distingue y no hace falta: lo que
 *   se sabe es que no hay nada entre medias, y unirlo lo parecería.
 */
export function segmentos(puntos: Punto[], interval_s: number): Punto[][] {
  if (puntos.length === 0) {
    return []
  }

  const limite = umbralDeHueco(interval_s)
  const tramos: Punto[][] = []
  let actual: Punto[] = []

  puntos.forEach((punto, i) => {
    const anterior = i > 0 ? puntos[i - 1] : null
    const corta = punto.corte || (anterior !== null && punto.t - anterior.t > limite)
    if (corta && actual.length > 0) {
      tramos.push(actual)
      actual = []
    }
    actual.push(punto)
  })

  if (actual.length > 0) {
    tramos.push(actual)
  }
  return tramos
}

/**
 * Recorta la serie a la ventana elegida.
 *
 * Se recorta por el **reloj del backend** (`t`), no por el número de muestras:
 * un anillo con un hueco tiene menos puntos por minuto que uno sin él, y
 * quedarse con las N últimas de cada ventana daría menos tiempo del que se pide
 * justo cuando el contenedor estuvo parado.
 */
export function cortar_ventana(muestras: MetricSample[], ventana_s: number): MetricSample[] {
  if (muestras.length === 0) {
    return []
  }
  const ultima = muestras[muestras.length - 1].t
  const desde = ultima - ventana_s
  const dentro = muestras.filter((m) => m.t >= desde)
  // Con una ventana más corta que la separación entre muestras no quedaría
  // ninguna, y un gráfico vacío aquí mentiría más que un último punto.
  return dentro.length > 0 ? dentro : [muestras[muestras.length - 1]]
}

/** Actual, media y máximo de una serie, para la lectura de la cabecera. */
export function resumen(puntos: Punto[]): { actual: number | null; media: number | null; maximo: number | null } {
  const valores = puntos.map((p) => p.valor).filter((v): v is number => v !== null)
  if (valores.length === 0) {
    return { actual: null, media: null, maximo: null }
  }
  return {
    actual: valores[valores.length - 1],
    media: valores.reduce((a, b) => a + b, 0) / valores.length,
    maximo: Math.max(...valores),
  }
}