// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { dockerApi } from '../../src/services/dockerApi'
import type { ImagePrunePreview } from '../../src/types/image'
import type { ContainerPrunePreview } from '../../src/types/docker'

const previewImagenes: ImagePrunePreview = {
  dangling_count: 1,
  dangling_bytes: 806_423_444,
  dangling_ids: ['sha256:ae21ea6bfe46'],
  tagged_count: 1,
  tagged_bytes: 179_402_011,
  tagged_refs: ['python:3.12-slim'],
  in_use_dangling: 1,
}

const previewContenedores: ContainerPrunePreview = {
  stopped_count: 2,
  stopped_bytes: 155_648,
  stopped_names: ['peluchito', 'full-editor-db'],
}

describe('dockerApi · limpieza (SPEC-21)', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.unstubAllGlobals()
  })

  const stubFetch = (payload: unknown, ok = true, status = 200) => {
    const mock = vi.fn().mockResolvedValue({
      ok,
      status,
      json: async () => payload,
    })
    vi.stubGlobal('fetch', mock)
    return mock
  }

  describe('los preavisos son GET y no borran', () => {
    it('previewImagePrune pide el preaviso de imágenes', async () => {
      const mock = stubFetch(previewImagenes)

      const result = await dockerApi.previewImagePrune()

      expect(mock).toHaveBeenCalledWith('/api/v1/images/prune')
      expect(result.dangling_count).toBe(1)
    })

    it('previewContainerPrune pide el preaviso de contenedores', async () => {
      const mock = stubFetch(previewContenedores)

      const result = await dockerApi.previewContainerPrune()

      expect(mock).toHaveBeenCalledWith('/api/v1/containers/prune')
      expect(result.stopped_names).toEqual(['peluchito', 'full-editor-db'])
    })
  })

  describe('el prune es un POST y el nivel se pide en la URL', () => {
    it('pruneImages sin argumento es el nivel sin etiqueta', async () => {
      const mock = stubFetch({ deleted: [], bytes_reclaimed: 0, message: 'nada' })

      await dockerApi.pruneImages()

      expect(mock).toHaveBeenCalledWith('/api/v1/images/prune?all=false', { method: 'POST' })
    })

    it('pruneImages(true) es el nivel agresivo', async () => {
      const mock = stubFetch({ deleted: ['python:3.12-slim'], bytes_reclaimed: 179_402_011, message: 'ok' })

      const result = await dockerApi.pruneImages(true)

      expect(mock).toHaveBeenCalledWith('/api/v1/images/prune?all=true', { method: 'POST' })
      expect(result.bytes_reclaimed).toBe(179_402_011)
    })

    it('pruneContainers no lleva parámetros: no hay nivel', async () => {
      const mock = stubFetch({ deleted: ['a4d168477d28'], bytes_reclaimed: 131_072, message: 'ok' })

      await dockerApi.pruneContainers()

      expect(mock).toHaveBeenCalledWith('/api/v1/containers/prune', { method: 'POST' })
    })
  })

  it('propaga el mensaje del 503 cuando el preaviso no se puede calcular', async () => {
    stubFetch({ detail: 'El daemon no informó del tamaño de los contenedores.' }, false, 503)

    await expect(dockerApi.previewContainerPrune()).rejects.toThrow(/tamaño/)
  })
})