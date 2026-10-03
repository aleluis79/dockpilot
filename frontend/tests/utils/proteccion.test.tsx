// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ActionButtons } from '../../src/components/containers/ActionButtons'
import { DeleteConfirmModal } from '../../src/components/containers/DeleteConfirmModal'
import { esContenedorDelPanel, esProyectoDelPanel, esRedDelPanel, esImagenDelPanel } from '../../src/utils/proteccion'
import type { ContainerSummary } from '../../src/types/docker'

/**
 * El panel se ve a sí mismo en su propio listado y su API puede pararlo o
 * borrarlo. No hay red detrás: se comprobó que ninguna política de reinicio lo
 * recupera, porque un `stop` de la API cuenta como parada deliberada. Estos
 * tests fijan que los botones que lo matan no se pintan.
 *
 * Y fijan lo contrario, que es lo importante: **iniciar, reanudar y reiniciar
 * siguen**. Si el backend ya está caído, ese botón es lo único que lo levanta.
 */

const base: Partial<ContainerSummary> = {
  image: 'nginx:alpine',
  status: 'running',
  state: 'Up 2 hours',
  created: 1727290000,
  ports: [],
}

const delPanel = (over: Partial<ContainerSummary> = {}): ContainerSummary => ({
  ...base,
  id: 'c1',
  name: 'dockpilot-backend-1',
  compose_project: 'dockpilot',
  ...over,
})

const normal = (over: Partial<ContainerSummary> = {}): ContainerSummary => ({
  ...base,
  id: 'c2',
  name: 'web',
  compose_project: 'otro',
  ...over,
})

const renderAcciones = (c: ContainerSummary, onAction = vi.fn(), onRequestDelete = vi.fn()) =>
  render(
    <ActionButtons
      container={c}
      actionInProgress={null}
      onAction={onAction}
      onRequestDelete={onRequestDelete}
    />
  )

describe('esContenedorDelPanel', () => {
  it('reconoce el proyecto del panel', () => {
    expect(esContenedorDelPanel({ compose_project: 'dockpilot' })).toBe(true)
    expect(esContenedorDelPanel({ compose_project: 'otro' })).toBe(false)
  })

  it('sin compose_project no protege nada, que es el caso de desarrollo', () => {
    // En `make up` el backend corre en el host y no tiene etiqueta de proyecto.
    // Proteger por el nombre sería proteger de más y romper el desarrollo.
    expect(esContenedorDelPanel({ compose_project: null })).toBe(false)
    expect(esContenedorDelPanel({})).toBe(false)
  })

  it('acepta una lista de proyectos por variable de build', () => {
    vi.stubEnv('VITE_PROYECTOS_PROTEGIDOS', 'panel, dockpilot ,otro-mio')
    try {
      expect(esContenedorDelPanel({ compose_project: 'panel' })).toBe(true)
      expect(esContenedorDelPanel({ compose_project: 'otro-mio' })).toBe(true)
      expect(esContenedorDelPanel({ compose_project: 'dockpilot' })).toBe(true)
      expect(esContenedorDelPanel({ compose_project: 'ajeno' })).toBe(false)
      expect(esProyectoDelPanel('panel')).toBe(true)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('una lista vacía cae al proyecto por defecto en vez de desprotegerlo', () => {
    // Fallar hacia «no protege» dejaría el botón de borrar otra vez a un clic,
    // y en silencio.
    vi.stubEnv('VITE_PROYECTOS_PROTEGIDOS', '  ,  ')
    try {
      expect(esContenedorDelPanel({ compose_project: 'dockpilot' })).toBe(true)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('ActionButtons · los botones que matan al panel no se pintan', () => {
  it('sin botón de detener', () => {
    renderAcciones(delPanel())
    expect(screen.queryByTitle(/Detener contenedor/)).not.toBeInTheDocument()
    // Un solo candado para las tres acciones que faltan, no uno por botón: tres
    // iconos iguales en la misma fila son ruido.
    expect(screen.getAllByTestId('accion-protegida')).toHaveLength(1)
  })

  it('sin botón de borrar', () => {
    renderAcciones(delPanel())
    expect(screen.queryByTitle(/Eliminar contenedor/)).not.toBeInTheDocument()
  })

  it('sin botón de pausar', () => {
    renderAcciones(delPanel())
    expect(screen.queryByTitle(/Pausar contenedor/)).not.toBeInTheDocument()
  })

  it('pero CON botón de iniciar, que es lo que lo recupera', () => {
    renderAcciones(delPanel({ status: 'exited', state: 'Exited (0) 5 minutes ago' }))
    // Sin esto, un panel caído sería irrecuperable desde la interfaz.
    expect(screen.getByTitle(/Iniciar contenedor/)).toBeInTheDocument()
  })

  it('pero CON botón de reanudar si estaba pausado', () => {
    renderAcciones(delPanel({ status: 'paused', state: 'Paused' }))
    expect(screen.getByTitle(/Reanudar contenedor/)).toBeInTheDocument()
  })

  it('y CON botón de reiniciar, que tampoco lo mata', () => {
    renderAcciones(delPanel())
    expect(screen.getByTitle(/Reiniciar contenedor/)).toBeInTheDocument()
  })

  it('un contenedor normal conserva todos sus botones', () => {
    renderAcciones(normal())
    expect(screen.getByTitle(/Detener contenedor/)).toBeInTheDocument()
    expect(screen.getByTitle(/Pausar contenedor/)).toBeInTheDocument()
    expect(screen.getByTitle(/Eliminar contenedor/)).toBeInTheDocument()
    expect(screen.queryByTestId('accion-protegida')).not.toBeInTheDocument()
  })

  it('en desarrollo, sin compose_project, no se protege nada', () => {
    renderAcciones(normal({ compose_project: null }))
    expect(screen.getByTitle(/Detener contenedor/)).toBeInTheDocument()
    expect(screen.getByTitle(/Eliminar contenedor/)).toBeInTheDocument()
  })

  it('pulsar el icono protegido no dispara ninguna acción', () => {
    const onAction = vi.fn()
    renderAcciones(delPanel(), onAction)
    screen.getByTestId('accion-protegida').click()
    expect(onAction).not.toHaveBeenCalled()
  })
})

describe('DeleteConfirmModal · segunda barrera', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('no ofrece confirmar para un contenedor del panel', () => {
    const onConfirm = vi.fn()
    render(
      <DeleteConfirmModal container={delPanel()} onClose={vi.fn()} onConfirm={onConfirm} />
    )

    expect(screen.getByTestId('borrado-protegido')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Eliminar/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/Forzar eliminación/)).not.toBeInTheDocument()
  })

  it('y explica cómo se desmonta de verdad', () => {
    render(
      <DeleteConfirmModal container={delPanel()} onClose={vi.fn()} onConfirm={vi.fn()} />
    )
    // Ofrecer solo «no» sin decir qué hacer deja al usuario atascado.
    expect(screen.getByText(/docker compose down/)).toBeInTheDocument()
  })

  it('un contenedor normal sí se puede borrar', () => {
    const onConfirm = vi.fn()
    render(
      <DeleteConfirmModal container={normal()} onClose={vi.fn()} onConfirm={onConfirm} />
    )
    expect(screen.queryByTestId('borrado-protegido')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Eliminar/ })).toBeInTheDocument()
  })

  it('el modo genérico de imágenes no se ve afectado', () => {
    render(
      <DeleteConfirmModal
        container={null}
        target={{ id: 'i1', name: 'nginx:alpine' }}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    )
    expect(screen.queryByTestId('borrado-protegido')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Eliminar/ })).toBeInTheDocument()
  })
})
// El tercer camino al mismo sitio: bajar o parar el PROYECTO compose del panel
// lo apaga entero. No pasa por la tabla de contenedores, así que el filtro de
// `ActionButtons` no lo cubre.

describe('esProyectoDelPanel', () => {
  it('reconoce el proyecto y no otros', () => {
    expect(esProyectoDelPanel('dockpilot')).toBe(true)
    expect(esProyectoDelPanel('mi-web')).toBe(false)
  })
})

// La segunda mitad de lo que se protege: el botón de «bajar» de un proyecto NO
// pasa por `onAccion`. La tabla lo enruta a `onBajar` porque necesita los
// nombres de los volúmenes antes de confirmar, así que un filtro puesto solo en
// `onAccion` deja el agujero entero abierto. Este test fija la cobertura de las
// tres vistas, no solo la de contenedores.

describe('protección de redes e imágenes del panel', () => {
  it('reconoce la red por defecto del proyecto', () => {
    expect(esRedDelPanel('dockpilot_default')).toBe(true)
    expect(esRedDelPanel('bridge')).toBe(false)
    expect(esRedDelPanel('mi-web_default')).toBe(false)
  })

  it('acepta redes declaradas a mano', () => {
    vi.stubEnv('VITE_RECURSOS_PROTEGIDOS', 'red_privada')
    try {
      expect(esRedDelPanel('red_privada')).toBe(true)
      expect(esRedDelPanel('dockpilot_default')).toBe(true)
      expect(esRedDelPanel('otra')).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('reconoce las imágenes del panel ignorando el tag', () => {
    expect(esImagenDelPanel('dockpilot-backend:latest')).toBe(true)
    expect(esImagenDelPanel('dockpilot-frontend:latest')).toBe(true)
    expect(esImagenDelPanel('nginx:alpine')).toBe(false)
  })

  it('no confunde un repositorio que solo empieza igual', () => {
    // `dockpilot-backup` es de otra persona y sí se debe poder borrar.
    expect(esImagenDelPanel('dockpilot-backup:1')).toBe(true)
    expect(esImagenDelPanel('dockpilot')).toBe(true)
    expect(esImagenDelPanel('undockpilot-thing')).toBe(false)
  })
})
