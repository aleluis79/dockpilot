// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ContainerFilesModal } from '../../src/components/containers/ContainerFilesModal'
import { validarTamano, formatearBytes, validarTamanoConTopes } from '../../src/types/filesystem'

// El modal abre en la raíz del contenedor, así que el listado por defecto es el
// de `/`. Que `path` sea coherente con lo que se pidió importa: si el doble
// miente sobre la ruta, el fallo se tcapa en el componente.
const LISTADO = {
  container_id: 'c777',
  path: '/',
  parent: null,
  truncated: false,
  entries: [
    { name: 'sub', kind: 'dir' as const, size: 4096, symlink_target: null },
    { name: 'uno.txt', kind: 'file' as const, size: 2048, symlink_target: null },
    { name: 'con espacios', kind: 'file' as const, size: 10, symlink_target: null },
    { name: 'atajo', kind: 'symlink' as const, size: 6, symlink_target: '/datos' },
    { name: 'caché', kind: 'other' as const, size: 0, symlink_target: null },
  ],
}

function apiFalsa(sobrescritas: Record<string, unknown> = {}) {
  return {
    listFiles: vi.fn().mockResolvedValue(LISTADO),
    downloadFile: vi.fn().mockResolvedValue({ blob: new Blob(['x']), filename: 'uno.txt' }),
    uploadFiles: vi.fn().mockResolvedValue({ enviados: 1 }),
    ...sobrescritas,
  }
}

describe('ContainerFilesModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('lista el directorio y muestra nombre, tipo y tamaño', async () => {
    render(
      <ContainerFilesModal
        isOpen={true}
        onClose={vi.fn()}
        containerId="c777"
        containerName="web"
        containerState="running"
        api={apiFalsa()}
      />
    )

    expect(await screen.findByText('uno.txt')).toBeInTheDocument()
    expect(screen.getByText('sub')).toBeInTheDocument()
    expect(screen.getByText('2.0 KiB')).toBeInTheDocument()
  })

  it('los directorios salen antes que los ficheros', async () => {
    render(
      <ContainerFilesModal
        isOpen={true}
        onClose={vi.fn()}
        containerId="c777"
        containerName="web"
        containerState="running"
        api={apiFalsa()}
      />
    )

    await screen.findByText('uno.txt')
    const nombres = screen
      .getAllByTestId('fila-nombre')
      .map((el) => el.textContent)

    expect(nombres[0]).toBe('sub')
  })

  it('un directorio se puede abrir y el padre aparece para volver', async () => {
    const api = apiFalsa({
      listFiles: vi
        .fn()
        .mockResolvedValueOnce(LISTADO)
        .mockResolvedValueOnce({
          ...LISTADO,
          path: '/sub',
          parent: '/',
          entries: [{ name: 'interno.txt', kind: 'file', size: 5, symlink_target: null }],
        }),
    })

    render(
      <ContainerFilesModal
        isOpen={true}
        onClose={vi.fn()}
        containerId="c777"
        containerName="web"
        containerState="running"
        api={api}
      />
    )

    fireEvent.click(await screen.findByText('sub'))

    expect(await screen.findByText('interno.txt')).toBeInTheDocument()
    // La segunda llamada es al subdirectorio, no a la raíz.
    expect(api.listFiles).toHaveBeenLastCalledWith('c777', '/sub')
  })

  it('un symlink enseña su destino, avisa y se puede descargar', async () => {
    const api = apiFalsa()
    render(
      <ContainerFilesModal
        isOpen={true}
        onClose={vi.fn()}
        containerId="c777"
        containerName="web"
        containerState="running"
        api={api}
      />
    )

    await screen.findByText('atajo')
    expect(screen.getByText(/\/datos/)).toBeInTheDocument()
    expect(screen.getByText(/no se sigue/i)).toBeInTheDocument()

    // Y se puede descargar: el enlace baja como enlace, no como su destino.
    // Dejarlo como la unica entrada visible que no hace nada seria un hueco.
    fireEvent.click(screen.getByTestId('descargar-atajo'))
    await waitFor(() => expect(api.downloadFile).toHaveBeenCalledWith('c777', '/atajo'))
  })

  it('un fichero sin medir muestra un guion y no un cero', async () => {
    const api = apiFalsa({
      listFiles: vi.fn().mockResolvedValue({
        ...LISTADO,
        entries: [{ name: 'raro.txt', kind: 'file', size: 0, symlink_target: null }],
      }),
    })

    render(
      <ContainerFilesModal
        isOpen={true}
        onClose={vi.fn()}
        containerId="c777"
        containerName="web"
        containerState="running"
        api={api}
      />
    )

    await screen.findByText('raro.txt')
    // `size: 0` significa "no medido". Poner "0 B" affirmaría algo que no se sabe.
    expect(screen.queryByText('0 B')).not.toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('subir a un contenedor en marcha avisa antes de enviar nada', async () => {
    const api = apiFalsa()
    render(
      <ContainerFilesModal
        isOpen={true}
        onClose={vi.fn()}
        containerId="c777"
        containerName="web"
        containerState="running"
        api={api}
      />
    )

    await screen.findByText('uno.txt')
    const input = screen.getByTestId('input-subida') as HTMLInputElement
    const fichero = new File(['hola'], 'notas.txt', { type: 'text/plain' })
    fireEvent.change(input, { target: { files: [fichero] } })

    // Aparece el aviso: escribir encima no es atómico y un proceso puede
    // seguir usando la versión anterior.
    expect(await screen.findByText(/en marcha/i)).toBeInTheDocument()
    expect(api.uploadFiles).not.toHaveBeenCalled()
  })

  it('subir a un contenedor parado no avisa', async () => {
    const api = apiFalsa()
    render(
      <ContainerFilesModal
        isOpen={true}
        onClose={vi.fn()}
        containerId="c777"
        containerName="web"
        containerState="exited"
        api={api}
      />
    )

    await screen.findByText('uno.txt')
    const input = screen.getByTestId('input-subida') as HTMLInputElement
    fireEvent.change(input, {
      target: { files: [new File(['hola'], 'notas.txt', { type: 'text/plain' })] },
    })

    expect(screen.queryByText(/en marcha/i)).not.toBeInTheDocument()
  })

  it('un fichero demasiado grande se rechaza antes de subirlo', async () => {
    const api = apiFalsa()
    render(
      <ContainerFilesModal
        isOpen={true}
        onClose={vi.fn()}
        containerId="c777"
        containerName="web"
        containerState="exited"
        api={api}
      />
    )

    await screen.findByText('uno.txt')
    // Un fichero de 20 MiB pasa del tope de subida (16 MiB).
    const enorme = new File([new Uint8Array(20 * 1024 * 1024)], 'enorme.bin')
    Object.defineProperty(enorme, 'size', { value: 20 * 1024 * 1024 })
    fireEvent.change(screen.getByTestId('input-subida'), { target: { files: [enorme] } })

    expect(await screen.findByText(/máximo/i)).toBeInTheDocument()
    expect(api.uploadFiles).not.toHaveBeenCalled()
  })

  it('descargar usa el contenido recibido y no una ruta del host', async () => {
    const crearUrl = vi.fn().mockReturnValue('blob:fantasia')
    vi.stubGlobal('URL', { ...URL, createObjectURL: crearUrl })

    const api = apiFalsa()
    render(
      <ContainerFilesModal
        isOpen={true}
        onClose={vi.fn()}
        containerId="c777"
        containerName="web"
        containerState="running"
        api={api}
      />
    )

    await screen.findByText('uno.txt')
    fireEvent.click(screen.getByTestId('descargar-uno.txt'))

    await waitFor(() => expect(api.downloadFile).toHaveBeenCalledWith('c777', '/uno.txt'))
    // Lo que se guarda es el Blob que vino del backend, no un path.
    expect(crearUrl).toHaveBeenCalled()
    expect(api.downloadFile).toHaveBeenCalledTimes(1)
  })

  it('un error del backend se enseña y el listado no se queda a medias', async () => {
    const api = apiFalsa({
      downloadFile: vi.fn().mockRejectedValue(new Error('El daemon no está disponible')),
    })
    render(
      <ContainerFilesModal
        isOpen={true}
        onClose={vi.fn()}
        containerId="c777"
        containerName="web"
        containerState="running"
        api={api}
      />
    )

    await screen.findByText('uno.txt')
    fireEvent.click(screen.getByTestId('descargar-uno.txt'))

    expect(await screen.findByText(/no está disponible/i)).toBeInTheDocument()
    // Y el listado sigue en su sitio: un fallo no borra lo que había.
    expect(screen.getByText('uno.txt')).toBeInTheDocument()
  })

  it('un listado truncado lo dice, en vez de fingir que está completo', async () => {
    const api = apiFalsa({
      listFiles: vi.fn().mockResolvedValue({ ...LISTADO, truncated: true }),
    })
    render(
      <ContainerFilesModal
        isOpen={true}
        onClose={vi.fn()}
        containerId="c777"
        containerName="web"
        containerState="running"
        api={api}
      />
    )

    expect(await screen.findByText(/no caben todas/i)).toBeInTheDocument()
  })
})

describe('formatearBytes y los topes', () => {
  it('formatea con unidades y sin decimales inútiles', () => {
    expect(formatearBytes(512)).toBe('512 B')
    expect(formatearBytes(2048)).toBe('2.0 KiB')
    expect(formatearBytes(5 * 1024 * 1024)).toBe('5.0 MiB')
  })

  it('da null cuando el tamaño está bien', () => {
    expect(validarTamano(1024, 'subida')).toBeNull()
  })

  it('explica el rechazo con el peso y el tope, no con un error genérico', () => {
    const mensaje = validarTamano(20 * 1024 * 1024, 'subida')
    expect(mensaje).toContain('20.0 MiB')
    expect(mensaje).toContain('16.0 MiB')
  })

  it('respeta un tope configurado en el backend', () => {
    const mensaje = validarTamanoConTopes(30, 'descarga', { descarga: 10 })
    expect(mensaje).toContain('30 B')
    expect(mensaje).toContain('10 B')
  })
})