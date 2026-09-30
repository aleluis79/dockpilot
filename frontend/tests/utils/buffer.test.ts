import { describe, it, expect } from 'vitest'
import { acumular } from '../../src/utils/buffer'

describe('acumular', () => {
  it('añade al final mientras no se pase del tope', () => {
    expect(acumular([1, 2], 3, 5)).toEqual([1, 2, 3])
  })

  it('descarta por delante cuando se pasa del tope', () => {
    expect(acumular([1, 2, 3, 4, 5], 6, 5)).toEqual([2, 3, 4, 5, 6])
  })

  it('respeta el borde del tope', () => {
    expect(acumular([1, 2], 3, 3)).toEqual([1, 2, 3])
    expect(acumular([1, 2, 3], 4, 3)).toEqual([2, 3, 4])
  })

  it('nunca muta la entrada y devuelve un array nuevo', () => {
    // Imprescindible para React: si se devolviera el mismo array, React lo
    // compararía por identidad, no vería cambios y no habría re-render.
    const previo = [1, 2, 3]
    const siguiente = acumular(previo, 4, 3)

    expect(previo).toEqual([1, 2, 3])
    expect(siguiente).toEqual([2, 3, 4])
    expect(siguiente).not.toBe(previo)
  })

  it('con un tope de 1 sólo queda el último', () => {
    expect(acumular([1, 2, 3], 4, 1)).toEqual([4])
  })

  it('con tope 0 no acumula nada', () => {
    expect(acumular([1, 2], 3, 0)).toEqual([3])
  })
})