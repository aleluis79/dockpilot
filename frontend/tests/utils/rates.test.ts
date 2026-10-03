// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest'

import {
  cortar_ventana,
  esTasa,
  segmentos,
  serieDe,
  resumen,
  tasa,
  tasas,
  umbralDeHueco,
} from '../../src/utils/rates'
import type { MetricSample } from '../../src/types/metrics'

function muestra(t: number, over: Partial<MetricSample> = {}): MetricSample {
  return {
    t,
    cpu_percent: 10,
    memory_percent: 20,
    network_rx_bytes: 0,
    network_tx_bytes: 0,
    block_read_bytes: 0,
    block_write_bytes: 0,
    ...over,
  }
}

/** n muestras cada `paso` segundos, con los contadores subiendo `delta` cada vez. */
function serie(n: number, paso = 2, delta = 1000): MetricSample[] {
  return Array.from({ length: n }, (_, i) =>
    muestra(1000 + i * paso, {
      network_rx_bytes: i * delta,
      network_tx_bytes: i * delta * 2,
      block_read_bytes: i * delta * 3,
      block_write_bytes: i * delta * 4,
    })
  )
}

describe('tasa', () => {
  it('divide el contador por el intervalo real', () => {
    const a = muestra(100, { network_rx_bytes: 1000 })
    const b = muestra(102, { network_rx_bytes: 3000 })

    expect(tasa(a, b, 'network_rx_bytes').bytes_per_second).toBe(1000)
  })

  it('divide por el intervalo real y no por el nominal', () => {
    // El daemon tardó 8 s en el tic. Con periodo nominal de 2 s, dividir por 2
    // daría una tasa 4,5 veces mayor que la real.
    const a = muestra(100, { block_write_bytes: 0 })
    const b = muestra(108, { block_write_bytes: 8000 })

    const r = tasa(a, b, 'block_write_bytes')

    expect(r.bytes_per_second).toBe(1000)
  })

  it('marca el salto cuando el contador baja', () => {
    const a = muestra(100, { network_rx_bytes: 9000 })
    const b = muestra(102, { network_rx_bytes: 10 })

    const r = tasa(a, b, 'network_rx_bytes')

    expect(r.broken).toBe(true)
    expect(r.bytes_per_second).toBeNull()
  })

  it('no inventa una tasa con dos muestras de la misma t', () => {
    const a = muestra(100, { network_rx_bytes: 0 })
    const b = muestra(100, { network_rx_bytes: 500 })

    expect(tasa(a, b, 'network_rx_bytes').bytes_per_second).toBeNull()
  })

  it('una tasa de cero es una tasa medida, no una ausencia', () => {
    const a = muestra(100, { network_tx_bytes: 700 })
    const b = muestra(102, { network_tx_bytes: 700 })

    const r = tasa(a, b, 'network_tx_bytes')

    expect(r.broken).toBe(false)
    expect(r.bytes_per_second).toBe(0)
  })
})

describe('tasas', () => {
  it('no devuelve nada con una sola muestra', () => {
    expect(tasas([muestra(100)], 'network_rx_bytes')).toEqual([])
  })

  it('devuelve una tasa por par consecutive', () => {
    expect(tasas(serie(5), 'network_rx_bytes')).toHaveLength(4)
  })
})

describe('serieDe', () => {
  it('para una tasa devuelve los valores derivados', () => {
    const puntos = serieDe(serie(4), 'network_rx', 300)

    expect(puntos).toHaveLength(3)
    expect(puntos[0].valor).toBe(500)
  })

  it('para un porcentaje devuelve el valor de la muestra', () => {
    const puntos = serieDe(serie(4), 'cpu_percent', 300)

    expect(puntos).toHaveLength(4)
    expect(puntos.every((p) => p.valor === 10)).toBe(true)
  })

  it('con una sola muestra y métrica de tasa no inventa un valor', () => {
    const puntos = serieDe([muestra(100)], 'network_rx', 300)

    expect(puntos).toHaveLength(1)
    expect(puntos[0].valor).toBeNull()
  })

  it('con una sola muestra y porcentaje sí hay valor', () => {
    const puntos = serieDe([muestra(100)], 'cpu_percent', 300)

    expect(puntos[0].valor).toBe(10)
  })

  it('marca el corte donde el contenedor se reinició', () => {
    const conReinicio = [
      muestra(100, { network_rx_bytes: 5000 }),
      muestra(102, { network_rx_bytes: 7000 }),
      muestra(104, { network_rx_bytes: 0 }),
      muestra(106, { network_rx_bytes: 100 }),
    ]

    const puntos = serieDe(conReinicio, 'network_rx', 300)

    expect(puntos[1].corte).toBe(true)
    expect(puntos[1].valor).toBeNull()
  })
})

describe('esTasa', () => {
  it('distingue las derivadas de las absolutas', () => {
    expect(esTasa('network_rx')).toBe(true)
    expect(esTasa('block_write')).toBe(true)
    expect(esTasa('cpu_percent')).toBe(false)
    expect(esTasa('memory_percent')).toBe(false)
  })
})

describe('cortar_ventana', () => {
  it('recorta por tiempo y no por número de muestras', () => {
    // 10 minutos de historial (t de 1000 a 1600, una muestra cada 2 s) y
    // ventana de 1 minuto: la primera que entra es la de t=1540.
    const diezMinutos = Array.from({ length: 301 }, (_, i) => muestra(1000 + i * 2))

    const recortada = cortar_ventana(diezMinutos, 60)

    expect(recortada[0].t).toBe(1600 - 60)
    // 31 puntos a 2 s: ni las 30 muestras de un tope por defecto ni la ventana
    // entera. El recorte es por reloj, no por cantidad.
    expect(recortada).toHaveLength(31)
  })

  it('con una ventana más corta que el hueco devuelve el último punto', () => {
    const separadas = [muestra(1000), muestra(2000)]

    expect(cortar_ventana(separadas, 10)).toHaveLength(1)
  })

  it('con la serie vacía devuelve la serie vacía', () => {
    expect(cortar_ventana([], 60)).toEqual([])
  })
})

describe('umbralDeHueco', () => {
  it('es 2,5 intervalos', () => {
    expect(umbralDeHueco(2)).toBe(5)
    expect(umbralDeHueco(10)).toBe(25)
  })
})

describe('segmentos', () => {
  it('una serie regular es un solo tramo', () => {
    expect(segmentos(serieDe(serie(6), 'network_rx', 300), 2)).toHaveLength(1)
  })

  it('parte el trazo en un hueco y no une los extremos', () => {
    // Hay un hueco de 20 s entre las muestras 3 y 4, con periodo de 2 s.
    const conHueco = [muestra(1000), muestra(1002), muestra(1004), muestra(1024), muestra(1026)]
    const puntos = serieDe(conHueco, 'network_rx', 300)

    const tramos = segmentos(puntos, 2)

    expect(tramos).toHaveLength(2)
    expect(tramos[0]).toHaveLength(2)
    expect(tramos[1]).toHaveLength(2)
  })

  it('parte el trazo en el salto de un reinicio', () => {
    const conReinicio = [
      muestra(1000, { network_rx_bytes: 0 }),
      muestra(1002, { network_rx_bytes: 1000 }),
      muestra(1004, { network_rx_bytes: 0 }),
      muestra(1006, { network_rx_bytes: 10 }),
    ]
    const puntos = serieDe(conReinicio, 'network_rx', 300)

    expect(segmentos(puntos, 2)).toHaveLength(2)
  })

  it('un hueco justo del límite no parte el trazo', () => {
    // 5 s con periodo de 2 es exactamente 2,5 intervalos: el borde.
    const justo = [muestra(1000), muestra(1005), muestra(1010)]

    expect(segmentos(serieDe(justo, 'network_rx', 300), 2)).toHaveLength(1)
  })

  it('una serie vacía no da tramos', () => {
    expect(segmentos([], 2)).toEqual([])
  })

  it('una sola muestra es un tramo de un punto y no un error', () => {
    expect(segmentos([{ t: 1000, valor: 5, corte: false }], 2)).toHaveLength(1)
  })
})

describe('resumen', () => {
  it('calcula actual, media y máximo ignorando los nulos', () => {
    const puntos = [
      { t: 1, valor: 10, corte: false },
      { t: 2, valor: null, corte: true },
      { t: 3, valor: 30, corte: false },
    ]

    expect(resumen(puntos)).toEqual({ actual: 30, media: 20, maximo: 30 })
  })

  it('sin datos no inventa un cero', () => {
    expect(resumen([])).toEqual({ actual: null, media: null, maximo: null })
  })

  it('con todos nulos tampoco', () => {
    expect(resumen([{ t: 1, valor: null, corte: true }])).toEqual({
      actual: null,
      media: null,
      maximo: null,
    })
  })
})