import { describe, it, expect } from 'vitest'
import { redPropia, validarNombreContenedor, MAX_NOMBRE } from '../../src/utils/containerName'

// Las reglas se midieron contra el daemon 29.8.1 antes de escribir el spec
// (SPEC-19 §2.3). Este archivo es la copia del cliente; el backend tiene la suya
// y `test_containers.py` verifica que las dos dicen lo mismo.

describe('validarNombreContenedor', () => {
  it('acepta lo que acepta Docker', () => {
    for (const nombre of ['mi-web', '1web', 'mi_web', 'mi.web', 'Web', 'a-b.c_d']) {
      expect(validarNombreContenedor(nombre), nombre).toEqual({ valido: true })
    }
  })

  it('exige al menos dos caracteres', () => {
    // El validador de REDES del proyecto usa `*` y aceptaría uno solo; Docker
    // exige dos. Por eso el de contenedores es propio.
    for (const nombre of ['x', 'a', ' 1 ']) {
      const r = validarNombreContenedor(nombre)
      expect(r.valido, nombre).toBe(false)
      expect(r.error).toMatch(/al menos dos caracteres/)
    }
  })

  it('rechaza vacío', () => {
    for (const nombre of ['', '   ', '\t']) {
      const r = validarNombreContenedor(nombre)
      expect(r.valido).toBe(false)
      expect(r.error).toMatch(/vacío/)
    }
  })

  it('nombra el carácter prohibido en vez de soltar la lista de permitidos', () => {
    expect(validarNombreContenedor('mi web').error).toMatch(/espacios/)
    expect(validarNombreContenedor('mi/web').error).toMatch(/barras/)
    expect(validarNombreContenedor('mi:web').error).toMatch(/dos puntos/)
    expect(validarNombreContenedor('mi@web').error).toMatch(/arrobas/)
  })

  it('rechaza lo que no cabe en un nombre de host', () => {
    expect(validarNombreContenedor('a'.repeat(MAX_NOMBRE))).toEqual({ valido: true })
    const r = validarNombreContenedor('a'.repeat(MAX_NOMBRE + 1))
    expect(r.valido).toBe(false)
    expect(r.error).toMatch(new RegExp(String(MAX_NOMBRE)))
  })

  it('detecta que el nombre no cambió', () => {
    const r = validarNombreContenedor('web-app', { nombreActual: 'web-app' })
    expect(r.valido).toBe(false)
    expect(r.error).toMatch(/no ha cambiado/)
  })

  it('detecta un nombre ya ocupado en el inventario, sin llamar al daemon', () => {
    const otros = ['db', 'cache']
    expect(validarNombreContenedor('db', { otrosNombres: otros })).toEqual({
      valido: false,
      error: "Ya existe un contenedor llamado 'db'.",
    })
    expect(validarNombreContenedor('nuevo', { otrosNombres: otros }).valido).toBe(true)
  })
})

describe('redPropia', () => {
  it('no hay red propia en la red por defecto', () => {
    expect(redPropia(['bridge'])).toBeNull()
    expect(redPropia(['default'])).toBeNull()
    expect(redPropia(['host'])).toBeNull()
    expect(redPropia([])).toBeNull()
    expect(redPropia(undefined)).toBeNull()
  })

  it('la encuentra cuando el contenedor está en una red propia', () => {
    // El bug que motivó quitar `network_mode`: un contenedor en `bridge`
    // conectado además a una red propia sigue diciendo `bridge` en
    // `HostConfig.NetworkMode`, y ese es justo el caso que hay que detectar.
    expect(redPropia(['bridge', 'mi-red'])).toBe('mi-red')
    expect(redPropia(['mi-red', 'bridge'])).toBe('mi-red')
    expect(redPropia(['elasticsearch-local_elastic'])).toBe('elasticsearch-local_elastic')
  })
})