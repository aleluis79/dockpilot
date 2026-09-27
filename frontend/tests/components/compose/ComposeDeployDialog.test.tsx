// SPDX-License-Identifier: AGPL-3.0-or-later
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposeDeployDialog } from '../../../src/components/compose/ComposeDeployDialog'
import { formatBytes } from '../../../src/utils/format'
import type { ComposePlan } from '../../../src/types/compose'

/** Un plan con los servicios que se le pasan, y el resto en cero. */
function plan(servicios: Record<string, ComposePlan['services'][number]['build']>): ComposePlan {
  return {
    project_name: 'app',
    source_path: '/p/docker-compose.yml',
    services: Object.entries(servicios).map(([name, build]) => ({
      name,
      image: 'x',
      build,
      container_name: null,
      command: null,
      entrypoint: null,
      restart: null,
      ports: [],
      mounts: [],
      networks: [],
      depends_on: [],
      profiles: [],
      environment_count: 0,
    })),
    networks: [],
    volumes: [],
    warnings: [],
    proyecto_en_uso: null,
    resolved_by: 'docker-compose-cli',
  }
}

const contextoGrande = (bytes: number) => ({
  context: '/p/app',
  bytes_aprox: bytes,
  ficheros_aprox: 19000,
  truncado: false,
  error: null,
})

describe('ComposeDeployDialog', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('no se abre si nada lleva build', () => {
    // Sin `build` no hay nada que decidir: un diálogo de confirmación vacío sería
    // un clic de más en el camino más común.
    const onConfirm = vi.fn()
    render(
      <ComposeDeployDialog
        open
        plan={plan({ web: null })}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    )

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('nombra los servicios que se van a construir', () => {
    render(
      <ComposeDeployDialog
        open
        plan={plan({ api: contextoGrande(393_000_000), web: contextoGrande(152_000_000) })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByText(/api/)).toBeInTheDocument()
    expect(screen.getByText(/web/)).toBeInTheDocument()
  })

  it('dice el peso del contexto', () => {
    render(
      <ComposeDeployDialog
        open
        plan={plan({ api: contextoGrande(393_000_000) })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    // El peso se muestra con el formateador del panel, no con uno propio: dos
    // reglas de unidades distintas en la misma pantalla hacen que 375 y 393
    // parezcan el mismo número.
    expect(screen.getByText(formatBytes(393_000_000))).toBeInTheDocument()
  })

  it('cuenta un contexto compartido una sola vez', () => {
    // `tickets-app` declara `build` en `api` y en `web` sobre el mismo `.`. Decir
    // 880 MB cuando se van a enviar 440 sería motivo para no hacerlo.
    render(
      <ComposeDeployDialog
        open
        plan={plan({ api: contextoGrande(440_000_000), web: contextoGrande(440_000_000) })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    // Un solo contexto, un solo peso: decir 880 MB cuando se van a enviar 440 es
    // motivo de sobra para no hacerlo.
    expect(screen.getAllByText(formatBytes(440_000_000))).toHaveLength(1)
  })

  it('avisa de los contextos que no se pudieron medir', () => {
    render(
      <ComposeDeployDialog
        open
        plan={plan({
          api: contextoGrande(1000),
          roto: { context: '/no/existe', bytes_aprox: 0, ficheros_aprox: 0, truncado: false, error: 'El contexto no existe: /no/existe' },
        })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    // Un 0 mudo se lee como "no pesa", y es un peso enorme y desconocido.
    expect(screen.getByText(/no se pudo medir/i)).toBeInTheDocument()
    expect(screen.getByText(/roto/)).toBeInTheDocument()
  })

  it('avisa cuando la cifra es parcial', () => {
    render(
      <ComposeDeployDialog
        open
        plan={plan({
          api: { ...contextoGrande(500_000_000), truncado: true },
        })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByText(/parcial/i)).toBeInTheDocument()
  })

  it('dice que la cifra no aplica .dockerignore', () => {
    render(
      <ComposeDeployDialog
        open
        plan={plan({ api: contextoGrande(393_000_000) })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    // La estimación sobreestima a propósito; si no se dice, el número se toma por
    // exacto y la sorpresa cae en el `up`.
    expect(screen.getByText(/dockerignore/i)).toBeInTheDocument()
  })

  it('confirmar no arranca nada por su cuenta', () => {
    const onConfirm = vi.fn()
    render(
      <ComposeDeployDialog
        open
        plan={plan({ api: contextoGrande(393_000_000) })}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /construir y arrancar/i }))

    // El diálogo solo levanta la barrera: el `up` lo lanza el panel de acción.
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('cancelar no confirma nada', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(
      <ComposeDeployDialog
        open
        plan={plan({ api: contextoGrande(393_000_000) })}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /^cancelar$/i }))

    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalled()
  })

  it('no ofrece arrancar sin construir', () => {
    // `up --no-build` sobre una imagen que no existe falla, y un botón de arranque
    // que a veces falla es peor que uno lento a propósito.
    render(
      <ComposeDeployDialog
        open
        plan={plan({ api: contextoGrande(393_000_000) })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.queryByRole('button', { name: /sin construir/i })).not.toBeInTheDocument()
  })
})
