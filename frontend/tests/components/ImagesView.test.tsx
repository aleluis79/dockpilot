import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ImagesView } from '../../src/components/images/ImagesView'
import type { LocalImageSummary } from '../../src/types/image'

const nginx: LocalImageSummary = {
  id: 'sha256:img1',
  tags: ['nginx:alpine', 'nginx:latest'],
  size: 25000000,
  created: 1727290000,
  containers: 0,
  repo_digests: [],
}

const redis: LocalImageSummary = {
  id: 'sha256:img2',
  tags: ['redis:alpine'],
  size: 35000000,
  created: 1727280000,
  containers: 1,
  repo_digests: [],
}

const postgres: LocalImageSummary = {
  id: 'sha256:img3',
  tags: ['postgres:16-alpine'],
  size: 40000000,
  created: 1727270000,
  containers: 0,
  repo_digests: [],
}

class MockWebSocket {
  static instances: MockWebSocket[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn()
  constructor(url: string) {
    MockWebSocket.instances.push(this)
    void url
  }
}

const stubImages = (images: LocalImageSummary[]) => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => images,
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const ALL = [nginx, redis, postgres]

describe('ImagesView · buscador', () => {
  const originalWebSocket = global.WebSocket

  beforeEach(() => {
    MockWebSocket.instances = []
    // @ts-expect-error Mocking WebSocket
    global.WebSocket = MockWebSocket
  })

  afterEach(() => {
    global.WebSocket = originalWebSocket
    vi.unstubAllGlobals()
  })

  const renderView = (images: LocalImageSummary[] = ALL) => {
    stubImages(images)
    return render(<ImagesView onRunImage={vi.fn()} onDeleted={vi.fn()} />)
  }

  const search = (value: string) =>
    fireEvent.change(screen.getByLabelText('Buscar imágenes'), { target: { value } })

  it('filtra por tag sin distinguir mayúsculas', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('nginx:alpine')).toBeInTheDocument())

    search('NGIN')

    expect(screen.getByText('nginx:alpine')).toBeInTheDocument()
    expect(screen.getByText('nginx:latest')).toBeInTheDocument()
    expect(screen.queryByText('redis:alpine')).not.toBeInTheDocument()
    expect(screen.queryByText('postgres:16-alpine')).not.toBeInTheDocument()
  })

  it('filtra por cualquier tag, no solo por el principal', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('nginx:alpine')).toBeInTheDocument())

    // "nginx:latest" es el tag secundario de la primera imagen
    search('latest')

    expect(screen.getByText('nginx:alpine')).toBeInTheDocument()
    expect(screen.queryByText('redis:alpine')).not.toBeInTheDocument()
  })

  it('filtra por ID de imagen', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('nginx:alpine')).toBeInTheDocument())

    search('img2')

    expect(screen.getByText('redis:alpine')).toBeInTheDocument()
    expect(screen.queryByText('nginx:alpine')).not.toBeInTheDocument()
  })

  it('el contador muestra las coincidencias sobre el total', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('nginx:alpine')).toBeInTheDocument())

    // Sin búsqueda, el contador es el total simple
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.queryByText(/de 3/)).not.toBeInTheDocument()

    search('redis')
    expect(screen.getByText('1 de 3')).toBeInTheDocument()

    // Las tres contienen "alpine" en algún tag
    search('alpine')
    expect(screen.getByText('3 de 3')).toBeInTheDocument()
  })

  it('muestra un estado de sin coincidencias distinto del host vacío', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('nginx:alpine')).toBeInTheDocument())

    search('no-existe-esta-imagen')

    expect(screen.getByText(/Ninguna imagen coincide/)).toBeInTheDocument()
    expect(screen.queryByText('No hay imágenes locales')).not.toBeInTheDocument()
  })

  it('el host vacío sigue mostrando su propio mensaje', async () => {
    renderView([])
    await waitFor(() => expect(screen.getByText('No hay imágenes locales')).toBeInTheDocument())

    // Sin imágenes, el buscador no debe inventar un estado de "sin coincidencias"
    expect(screen.queryByText(/Ninguna imagen coincide/)).not.toBeInTheDocument()
  })

  it('al borrar el texto se restaura el inventario completo', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('nginx:alpine')).toBeInTheDocument())

    search('redis')
    expect(screen.queryByText('nginx:alpine')).not.toBeInTheDocument()

    search('')

    expect(screen.getByText('nginx:alpine')).toBeInTheDocument()
    expect(screen.getByText('redis:alpine')).toBeInTheDocument()
    expect(screen.getByText('postgres:16-alpine')).toBeInTheDocument()
    expect(screen.queryByText(/de 3/)).not.toBeInTheDocument()
  })

  it('las acciones de la tabla siguen funcionando con el filtro activo', async () => {
    const onRunImage = vi.fn()
    stubImages(ALL)
    render(<ImagesView onRunImage={onRunImage} onDeleted={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('nginx:alpine')).toBeInTheDocument())

    search('redis')
    fireEvent.click(screen.getByTitle('Ejecutar un contenedor con redis:alpine'))

    expect(onRunImage).toHaveBeenCalledWith(redis)
  })
})

// --- SPEC-21: la limpieza de imágenes ----------------------------------------

const PREVIEW = {
  dangling_count: 1,
  dangling_bytes: 806_423_444,
  dangling_ids: ['sha256:ae21ea6bfe46'],
  tagged_count: 1,
  tagged_bytes: 179_402_011,
  tagged_refs: ['python:3.12-slim'],
  in_use_dangling: 1,
}

describe('ImagesView · limpieza (SPEC-21)', () => {
  const originalWebSocket = global.WebSocket

  beforeEach(() => {
    MockWebSocket.instances = []
    // @ts-expect-error Mocking WebSocket
    global.WebSocket = MockWebSocket
  })

  afterEach(() => {
    global.WebSocket = originalWebSocket
    vi.unstubAllGlobals()
  })

  const stubRutas = (over: Record<string, unknown> = {}) => {
    const mock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const ruta = String(url)
      if (ruta.includes('/images/prune') && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            deleted: ['python:3.12-slim'],
            bytes_reclaimed: 179_402_011,
            message: '1 imagen eliminada',
            kept: [],
            ...(over.respuesta ?? {}),
          }),
        })
      }
      if (ruta.includes('/images/prune')) {
        const p = { ...PREVIEW, ...over }
        if (p.error) {
          return Promise.resolve({ ok: false, status: 503, json: async () => ({ detail: 'sin df' }) })
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => p })
      }
      if (ruta.includes('/images/local')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ALL })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => [] })
    })
    vi.stubGlobal('fetch', mock)
    return mock
  }

  const renderView = (over: Record<string, unknown> = {}) => {
    const mock = stubRutas(over)
    return {
      mock,
      ...render(<ImagesView onRunImage={vi.fn()} onDeleted={vi.fn()} />),
    }
  }

  it('el botón dice los bytes del preaviso, no los del sistema', async () => {
    renderView()
    await waitFor(() => expect(screen.getByTestId('images-prune-pendiente')).toBeInTheDocument())

    // 806 MB es lo que daría la limpieza segura. El `df` del host dice 4,3 GB,
    // y ese número no puede aparecer aquí: la acción por defecto no lo toca.
    expect(screen.getByTestId('images-prune-pendiente')).toHaveTextContent('769')
    expect(screen.queryByText(/4\.3 GB/)).not.toBeInTheDocument()
  })

  it('el diálogo sin etiqueta no menciona las imágenes con etiqueta', async () => {
    renderView()
    await waitFor(() => screen.getByRole('button', { name: /Limpiar sin etiqueta/ }))

    fireEvent.click(screen.getByRole('button', { name: /Limpiar sin etiqueta/ }))

    expect(screen.getByRole('dialog', { name: /Limpiar imágenes sin etiqueta/ })).toBeInTheDocument()
    expect(screen.getByText('sha256:ae21ea6bfe46')).toBeInTheDocument()
    expect(screen.queryByText('python:3.12-slim')).not.toBeInTheDocument()
  })

  it('el nivel agresivo abre OTRO diálogo, con los tags y su aviso', async () => {
    renderView()
    await waitFor(() => screen.getByRole('button', { name: /quitar también las que tienen etiqueta/ }))

    fireEvent.click(screen.getByRole('button', { name: /quitar también las que tienen etiqueta/ }))

    expect(
      screen.getByRole('dialog', { name: /Quitar también las imágenes con etiqueta/ })
    ).toBeInTheDocument()
    expect(screen.getByText('python:3.12-slim')).toBeInTheDocument()
    expect(screen.getByText(/volver a descargarlas/)).toBeInTheDocument()
  })

  it('los dos botones destructivos no comparten aspecto', async () => {
    renderView()
    await waitFor(() => screen.getByRole('button', { name: /Limpiar sin etiqueta/ }))

    fireEvent.click(screen.getByRole('button', { name: /Limpiar sin etiqueta/ }))
    const seguro = screen.getByRole('button', { name: 'Limpiar' })

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    fireEvent.click(screen.getByRole('button', { name: /quitar también las que tienen etiqueta/ }))
    const agresivo = screen.getByRole('button', { name: /Quitar también/ })

    expect(seguro).toHaveAttribute('data-nivel', 'seguro')
    expect(agresivo).toHaveAttribute('data-nivel', 'agresivo')
  })

  it('avisa de que hay una imagen sin etiqueta en uso que no se puede borrar', async () => {
    renderView()
    await waitFor(() => screen.getByTestId('images-prune-en-uso'))

    expect(screen.getByTestId('images-prune-en-uso')).toHaveTextContent('1')
  })

  it('sin nada que limpiar el botón está deshabilitado y no dice 0', async () => {
    renderView({ dangling_count: 0, dangling_bytes: 0, dangling_ids: [] })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Limpiar sin etiqueta/ })).toBeDisabled()
    )

    expect(screen.queryByTestId('images-prune-pendiente')).not.toBeInTheDocument()
  })

  it('si el preaviso falla lo dice, y no dice que no hay nada', async () => {
    renderView({ error: true })
    await waitFor(() => screen.getByTestId('images-prune-error'))

    expect(screen.getByTestId('images-prune-error')).toBeInTheDocument()
    expect(screen.queryByText(/no hay nada que limpiar/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /quitar también las que tienen etiqueta/ })).toBeDisabled()
  })

  it('el bytes del diálogo llevan la palabra hasta', async () => {
    renderView()
    await waitFor(() => screen.getByRole('button', { name: /Limpiar sin etiqueta/ }))

    fireEvent.click(screen.getByRole('button', { name: /Limpiar sin etiqueta/ }))

    expect(screen.getByText(/hasta 769/)).toBeInTheDocument()
  })
})


// --- El nivel agresivo: `all` ya no existe y el borrado puede fallar a medias --

describe('ImagesView · limpieza agresiva (SPEC-21, corrección)', () => {
  const originalWebSocket = global.WebSocket

  beforeEach(() => {
    MockWebSocket.instances = []
    // @ts-expect-error Mocking WebSocket
    global.WebSocket = MockWebSocket
  })

  afterEach(() => {
    global.WebSocket = originalWebSocket
    vi.unstubAllGlobals()
  })

  const abrir = (over: Record<string, unknown> = {}) => {
    const mock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const ruta = String(url)
      if (ruta.includes('/images/prune') && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            deleted: ['python:3.12-slim'],
            bytes_reclaimed: 179_402_011,
            message: '1 imagen eliminada',
            kept: [],
            ...(over.respuesta ?? {}),
          }),
        })
      }
      if (ruta.includes('/images/prune')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => PREVIEW })
      }
      if (ruta.includes('/images/local')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ALL })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => [] })
    })
    vi.stubGlobal('fetch', mock)
    return { mock, ...render(<ImagesView onRunImage={vi.fn()} onDeleted={vi.fn()} />) }
  }

  it('los bytes del nivel agresivo se dicen estimados, no recuperados', async () => {
    abrir()
    await waitFor(() =>
      screen.getByRole('button', { name: /quitar también las que tienen etiqueta/ })
    )

    fireEvent.click(screen.getByRole('button', { name: /quitar también las que tienen etiqueta/ }))
    fireEvent.click(screen.getByRole('button', { name: /Quitar también/ }))

    await waitFor(() => expect(screen.getByText(/estimados/)).toBeInTheDocument())
    expect(screen.queryByText(/recuperados/)).not.toBeInTheDocument()
  })

  it('el nivel seguro sí dice recuperados, porque el prune los da de verdad', async () => {
    abrir()
    await waitFor(() => screen.getByRole('button', { name: /Limpiar sin etiqueta/ }))

    fireEvent.click(screen.getByRole('button', { name: /Limpiar sin etiqueta/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Limpiar' }))

    await waitFor(() => expect(screen.getByText(/recuperados/)).toBeInTheDocument())
  })

  it('enseña las imágenes que el daemon no dejó borrar, con su motivo', async () => {
    abrir({
      respuesta: {
        deleted: ['python:3.12-slim'],
        kept: ['quay.io/keycloak/keycloak:latest (409: image is being used)'],
      },
    })
    await waitFor(() =>
      screen.getByRole('button', { name: /quitar también las que tienen etiqueta/ })
    )

    fireEvent.click(screen.getByRole('button', { name: /quitar también las que tienen etiqueta/ }))
    fireEvent.click(screen.getByRole('button', { name: /Quitar también/ }))

    await waitFor(() => expect(screen.getByTestId('images-prune-kept')).toBeInTheDocument())
    expect(screen.getByText(/quay.io\/keycloak/)).toBeInTheDocument()
    expect(screen.getByText(/image is being used/)).toBeInTheDocument()
  })

  it('sin nada que quedarse no enseña el aviso', async () => {
    abrir()
    await waitFor(() =>
      screen.getByRole('button', { name: /quitar también las que tienen etiqueta/ })
    )

    fireEvent.click(screen.getByRole('button', { name: /quitar también las que tienen etiqueta/ }))
    fireEvent.click(screen.getByRole('button', { name: /Quitar también/ }))

    await waitFor(() => expect(screen.getByText(/estimados/)).toBeInTheDocument())
    expect(screen.queryByTestId('images-prune-kept')).not.toBeInTheDocument()
  })
})
