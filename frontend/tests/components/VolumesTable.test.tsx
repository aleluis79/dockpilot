import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { VolumesTable } from '../../src/components/volumes/VolumesTable'
import type { VolumeSummary } from '../../src/types/volume'

const datosApp: VolumeSummary = {
  name: 'datos-app',
  driver: 'local',
  mountpoint: '/var/lib/docker/volumes/datos-app/_data',
  scope: 'local',
  created_at: '2026-09-20T10:00:00-03:00',
  size: 104857600,
  ref_count: 1,
  is_anonymous: false,
  labels: { app: 'dockpilot' },
}

const anonimo: VolumeSummary = {
  name: 'aa342f746404c4a57823f40a9bccdc6cc78a2520701d2507f050b5aa5dcc9c09',
  driver: 'local',
  mountpoint: '/var/lib/docker/volumes/aa34/_data',
  scope: 'local',
  created_at: '2026-09-22T09:15:00-03:00',
  size: 48505107,
  ref_count: 0,
  is_anonymous: true,
  labels: {},
}

const temporal: VolumeSummary = {
  name: 'temporal',
  driver: 'local',
  mountpoint: '/var/lib/docker/volumes/temporal/_data',
  scope: 'local',
  created_at: '2026-09-21T11:30:00-03:00',
  size: 5242880,
  ref_count: 0,
  is_anonymous: false,
  labels: {},
}

describe('VolumesTable', () => {
  const baseProps = {
    loading: false,
    error: null,
    onRefresh: vi.fn(),
    onInspect: vi.fn(),
    onRequestDelete: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('muestra el estado de carga', () => {
    render(<VolumesTable {...baseProps} volumes={[]} loading />)

    expect(screen.getByText('Cargando volúmenes...')).toBeInTheDocument()
  })

  it('muestra el estado vacío', () => {
    render(<VolumesTable {...baseProps} volumes={[]} />)

    expect(screen.getByText('No hay volúmenes')).toBeInTheDocument()
  })

  it('muestra el error de la API y permite reintentar', () => {
    render(<VolumesTable {...baseProps} volumes={[]} error="No se pudo conectar con Docker" />)

    expect(screen.getByText('No se pudo conectar con Docker')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Reintentar carga de volúmenes'))
    expect(baseProps.onRefresh).toHaveBeenCalled()
  })

  it('lista el nombre, el tamaño y la fecha', () => {
    render(<VolumesTable {...baseProps} volumes={[datosApp]} />)

    expect(screen.getByText('datos-app')).toBeInTheDocument()
    expect(screen.getByText('100.0 MB')).toBeInTheDocument()
    expect(screen.getByText(/2026/)).toBeInTheDocument()
  })

  it('marca los volúmenes anónimos', () => {
    render(<VolumesTable {...baseProps} volumes={[datosApp, anonimo]} />)

    expect(screen.getAllByText('anónimo')).toHaveLength(1)
    // El nombre se muestra abreviado, no completo
    expect(screen.getByText(/^aa342f746404/)).toBeInTheDocument()
  })

  it('indica si el volumen está en uso', () => {
    render(<VolumesTable {...baseProps} volumes={[datosApp, temporal]} />)

    expect(screen.getByText('En uso (1)')).toBeInTheDocument()
    expect(screen.getByText('Libre')).toBeInTheDocument()
  })

  it('ofrece las acciones de inspeccionar y eliminar', () => {
    render(<VolumesTable {...baseProps} volumes={[datosApp]} />)

    fireEvent.click(screen.getByTitle('Ver el detalle de datos-app'))
    expect(baseProps.onInspect).toHaveBeenCalledWith(datosApp)

    fireEvent.click(screen.getByTitle('Eliminar el volumen datos-app'))
    expect(baseProps.onRequestDelete).toHaveBeenCalledWith(datosApp)
  })
})
