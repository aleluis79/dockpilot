/**
 * DockPilot - system.ts
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU Affero General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option) any
 * later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more
 * details.
 *
 * You should have received a copy of the GNU Affero General Public License along
 * with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * Licencia: AGPL-3.0-or-later. Titular del copyright: Alejandro.
 * Fecha: 2026.
 */

import type {
  ContainerSummary,
  ContainerDetail,
  ContainerActionResponse,
  CreateContainerRequest,
  CreateContainerResponse,
  RenameContainerRequest,
  RenameContainerResponse,
} from '../types/docker'
import type { ContainerStats } from '../types/stats'
import type { MetricsHistory, WatchResponse } from '../types/metrics'
import type { ImagePrunePreview, ImagePruneResult } from '../types/image'
import type { ContainerPrunePreview, ContainerPruneResult } from '../types/docker'
import type { ListDirectoryResult } from '../types/filesystem'
import type {
  ImageDeleteResponse,
  ImageDetail,
  ImageSearchResult,
  LocalImageSummary,
} from '../types/image'
import type {
  CreateNetworkRequest,
  NetworkDeleteResponse,
  NetworkDetail,
  NetworkPruneResult,
  NetworkSummary,
} from '../types/network'
import type {
  BrowseResult,
  ComposeOverview,
  ComposePlan,
  ComposePlanRequest,
  ComposeProjectDetail,
} from '../types/compose'
import type { DiskUsage, SystemInfo, SystemOverview } from '../types/system'
import type {
  VolumeDeleteResponse,
  VolumeDetail,
  VolumePruneResult,
  VolumeSummary,
} from '../types/volume'

const BASE_URL = '/api/v1'

/**
 * Patrón de referencia de imagen replicado del backend (SPEC-07 §3.2).
 * Se mantiene en cliente para dar feedback inmediato sin ir al servidor.
 */
const IMAGE_REF_PATTERN =
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?::\d+)?(?:\/[a-zA-Z0-9_][a-zA-Z0-9._-]*)*(?::[a-zA-Z0-9._-]+)?(?:@sha256:[a-f0-9]{64})?$/

const MAX_IMAGE_REF_LENGTH = 255

/** Resumen previo a la limpieza, para poder confirmar con cifras (SPEC-08 §3.4). */
export interface UnusedVolumesSummary {
  count: number
  bytes: number
  names: string[]
}

export function isValidImageRef(ref: string): boolean {
  const candidate = (ref ?? '').trim()
  if (!candidate || candidate.length > MAX_IMAGE_REF_LENGTH) return false
  return IMAGE_REF_PATTERN.test(candidate)
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let errorDetail = `Error ${res.status}: ${res.statusText}`
    try {
      const data = await res.json()
      if (data?.detail) {
        errorDetail = data.detail
      }
    } catch {
      // Ignorar si el cuerpo no es JSON
    }
    throw new Error(errorDetail)
  }
  return res.json()
}

export const dockerApi = {
  /**
   * Listado de contenedores.
   *
   * `status` lo admite el backend, pero **la lista de contenedores no lo usa**:
   * se pide el host entero y el filtro de estado se aplica en el navegador. Pedir
   * solo los de un estado hacía que los contadores de las pills —que se calculan
   * sobre la lista completa— bailaran al cambiar de filtro, y convertía cada clic
   * en una ida y vuelta al daemon. El parámetro se conserva porque es una
   * capacidad real de la API, no porque el panel la necesite.
   */
  async listContainers(all: boolean = true, status?: string): Promise<ContainerSummary[]> {
    const params = new URLSearchParams()
    if (all) params.append('all', 'true')
    if (status) params.append('status', status)
    const url = `${BASE_URL}/containers${params.toString() ? `?${params.toString()}` : ''}`
    const res = await fetch(url)
    return handleResponse<ContainerSummary[]>(res)
  },

  async getContainer(id: string): Promise<ContainerDetail> {
    const res = await fetch(`${BASE_URL}/containers/${id}`)
    return handleResponse<ContainerDetail>(res)
  },

  /**
   * Cambia el nombre del contenedor (SPEC-19).
   *
   * No recrea nada: el id, el estado y los volúmenes no cambian. Lo único que
   * hay que mirar es el `409`, porque el nombre es único en TODO el daemon y no
   * sólo dentro del proyecto.
   */
  async renameContainer(
    id: string,
    data: RenameContainerRequest
  ): Promise<RenameContainerResponse> {
    const res = await fetch(`${BASE_URL}/containers/${id}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    return handleResponse<RenameContainerResponse>(res)
  },

  async createContainer(data: CreateContainerRequest): Promise<CreateContainerResponse> {
    const res = await fetch(`${BASE_URL}/containers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    })
    return handleResponse<CreateContainerResponse>(res)
  },

  async startContainer(id: string): Promise<ContainerActionResponse> {
    const res = await fetch(`${BASE_URL}/containers/${id}/start`, { method: 'POST' })
    return handleResponse<ContainerActionResponse>(res)
  },

  async stopContainer(id: string, timeout: number = 10): Promise<ContainerActionResponse> {
    const res = await fetch(`${BASE_URL}/containers/${id}/stop?timeout=${timeout}`, {
      method: 'POST',
    })
    return handleResponse<ContainerActionResponse>(res)
  },

  async restartContainer(id: string, timeout: number = 10): Promise<ContainerActionResponse> {
    const res = await fetch(`${BASE_URL}/containers/${id}/restart?timeout=${timeout}`, {
      method: 'POST',
    })
    return handleResponse<ContainerActionResponse>(res)
  },

  async pauseContainer(id: string): Promise<ContainerActionResponse> {
    const res = await fetch(`${BASE_URL}/containers/${id}/pause`, { method: 'POST' })
    return handleResponse<ContainerActionResponse>(res)
  },

  async unpauseContainer(id: string): Promise<ContainerActionResponse> {
    const res = await fetch(`${BASE_URL}/containers/${id}/unpause`, { method: 'POST' })
    return handleResponse<ContainerActionResponse>(res)
  },

  async removeContainer(
    id: string,
    force: boolean = false,
    v: boolean = false
  ): Promise<ContainerActionResponse> {
    const res = await fetch(`${BASE_URL}/containers/${id}?force=${force}&v=${v}`, {
      method: 'DELETE',
    })
    return handleResponse<ContainerActionResponse>(res)
  },

  async getContainerStats(id: string): Promise<ContainerStats> {
    const res = await fetch(`${BASE_URL}/containers/${id}/stats`)
    return handleResponse<ContainerStats>(res)
  },

  /**
   * La serie de métricas del contenedor (SPEC-17). No crea el anillo: mirar no
   * es observar, y un `GET` no puede dejar al contenedor midiéndose.
   */
  async getContainerMetrics(id: string): Promise<MetricsHistory> {
    const res = await fetch(`${BASE_URL}/containers/${id}/metrics`)
    return handleResponse<MetricsHistory>(res)
  },

  /** Fija el contenedor para que se mida aunque nadie lo mire. */
  async watchContainer(id: string): Promise<WatchResponse> {
    const res = await fetch(`${BASE_URL}/containers/${id}/watch`, { method: 'POST' })
    return handleResponse<WatchResponse>(res)
  },

  /** Lo desfija. Su serie sigue ahí hasta que expire. */
  async unwatchContainer(id: string): Promise<WatchResponse> {
    const res = await fetch(`${BASE_URL}/containers/${id}/watch`, { method: 'DELETE' })
    return handleResponse<WatchResponse>(res)
  },

  /**
   * La limpieza de imágenes (SPEC-21).
   *
   * `preview` NO borra nada: el backend calcula el recuento leyendo, porque
   * preguntarle a Docker qué borraría un prune ya sería borrarlo.
   *
   * `all` es un parámetro de la URL y no del cuerpo, y por eso `allUntagged()`
   * no tiene equivalente: el nivel agresivo tiene que pedirse explícitamente.
   */
  async previewImagePrune(): Promise<ImagePrunePreview> {
    const res = await fetch(`${BASE_URL}/images/prune`)
    return handleResponse<ImagePrunePreview>(res)
  },

  async pruneImages(allUntagged: boolean = false): Promise<ImagePruneResult> {
    const res = await fetch(`${BASE_URL}/images/prune?all=${allUntagged}`, { method: 'POST' })
    return handleResponse<ImagePruneResult>(res)
  },

  async previewContainerPrune(): Promise<ContainerPrunePreview> {
    const res = await fetch(`${BASE_URL}/containers/prune`)
    return handleResponse<ContainerPrunePreview>(res)
  },

  async pruneContainers(): Promise<ContainerPruneResult> {
    const res = await fetch(`${BASE_URL}/containers/prune`, { method: 'POST' })
    return handleResponse<ContainerPruneResult>(res)
  },

  async getVolumes(): Promise<VolumeSummary[]> {
    const res = await fetch(`${BASE_URL}/volumes`)
    return handleResponse<VolumeSummary[]>(res)
  },

  async getVolume(name: string): Promise<VolumeDetail> {
    const res = await fetch(`${BASE_URL}/volumes/${encodeURIComponent(name)}`)
    return handleResponse<VolumeDetail>(res)
  },

  /**
   * Vista completa del host en una sola peticion: informacion del sistema,
   * consumo de disco y mayores consumidores (SPEC-09).
   */
  async getSystemOverview(): Promise<SystemOverview> {
    const res = await fetch(`${BASE_URL}/system/overview`)
    return handleResponse<SystemOverview>(res)
  },

  async getSystemInfo(): Promise<SystemInfo> {
    const res = await fetch(`${BASE_URL}/system/info`)
    return handleResponse<SystemInfo>(res)
  },

  async getDiskUsage(): Promise<DiskUsage> {
    const res = await fetch(`${BASE_URL}/system/df`)
    return handleResponse<DiskUsage>(res)
  },

  async listNetworks(): Promise<NetworkSummary[]> {
    const res = await fetch(`${BASE_URL}/networks`)
    return handleResponse<NetworkSummary[]>(res)
  },

  async getNetwork(name: string): Promise<NetworkDetail> {
    const res = await fetch(`${BASE_URL}/networks/${encodeURIComponent(name)}`)
    return handleResponse<NetworkDetail>(res)
  },

  async createNetwork(payload: CreateNetworkRequest): Promise<NetworkDetail> {
    const res = await fetch(`${BASE_URL}/networks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return handleResponse<NetworkDetail>(res)
  },

  async deleteNetwork(name: string, force = false): Promise<NetworkDeleteResponse> {
    const res = await fetch(
      `${BASE_URL}/networks/${encodeURIComponent(name)}?force=${force}`,
      { method: 'DELETE' }
    )
    return handleResponse<NetworkDeleteResponse>(res)
  },

  async pruneNetworks(): Promise<NetworkPruneResult> {
    const res = await fetch(`${BASE_URL}/networks/prune`, { method: 'POST' })
    return handleResponse<NetworkPruneResult>(res)
  },

  async getUnusedVolumesSummary(): Promise<UnusedVolumesSummary> {
    const res = await fetch(`${BASE_URL}/volumes/prune`)
    return handleResponse<UnusedVolumesSummary>(res)
  },

  async pruneVolumes(): Promise<VolumePruneResult> {
    const res = await fetch(`${BASE_URL}/volumes/prune`, { method: 'POST' })
    return handleResponse<VolumePruneResult>(res)
  },

  async deleteVolume(name: string, force: boolean = false): Promise<VolumeDeleteResponse> {
    const res = await fetch(
      `${BASE_URL}/volumes/${encodeURIComponent(name)}?force=${force}`,
      { method: 'DELETE' }
    )
    return handleResponse<VolumeDeleteResponse>(res)
  },

  async getLocalImages(): Promise<LocalImageSummary[]> {
    const res = await fetch(`${BASE_URL}/images/local`)
    return handleResponse<LocalImageSummary[]>(res)
  },

  async getImage(id: string): Promise<ImageDetail> {
    const res = await fetch(`${BASE_URL}/images/${id}`)
    return handleResponse<ImageDetail>(res)
  },

  async deleteImage(id: string, force: boolean = false): Promise<ImageDeleteResponse> {
    const res = await fetch(`${BASE_URL}/images/${id}?force=${force}`, { method: 'DELETE' })
    return handleResponse<ImageDeleteResponse>(res)
  },

  async searchImages(term: string, limit: number = 10): Promise<ImageSearchResult[]> {
    const params = new URLSearchParams({ term, limit: String(limit) })
    const res = await fetch(`${BASE_URL}/images/search?${params.toString()}`)
    return handleResponse<ImageSearchResult[]>(res)
  },

  async listComposeProjects(): Promise<ComposeOverview> {
    const res = await fetch(`${BASE_URL}/compose/projects`)
    return handleResponse<ComposeOverview>(res)
  },

  async planCompose(payload: ComposePlanRequest): Promise<ComposePlan> {
    const res = await fetch(`${BASE_URL}/compose/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return handleResponse<ComposePlan>(res)
  },

  /**
   * Sin `path` pide la raíz: el cliente no puede deducirla, porque `~` apunta al
   * home del usuario del backend y no al del navegador.
   */
  async browseComposeFiles(path?: string): Promise<BrowseResult> {
    // La ruta va en la query y por tanto necesita codificarse: una con espacios o
    // con `&` rompería la URL y el backend leería otra cosa.
    const query = path ? `?path=${encodeURIComponent(path)}` : ''
    const res = await fetch(`${BASE_URL}/compose/browse${query}`)
    return handleResponse<BrowseResult>(res)
  },

  async getComposeProject(name: string): Promise<ComposeProjectDetail> {
    // Un nombre de proyecto puede llevar barra o espacio: sin `encodeURIComponent`
    // la petición apunta a otra ruta y el 404 dice "no existe" en vez de "mal
    // formado".
    const res = await fetch(`${BASE_URL}/compose/projects/${encodeURIComponent(name)}`)
    return handleResponse<ComposeProjectDetail>(res)
  },
  /**
   * Lista un directorio de un contenedor (SPEC-20).
   *
   * La ruta es SIEMPRE del contenedor. Este cliente no tiene ningún método que
   * reciba una ruta del host, y esa ausencia es deliberada: es lo que permite
   * que el panel no escriba en el disco del usuario (SPEC-20 §3.2).
   */
  async listFiles(containerId: string, path: string): Promise<ListDirectoryResult> {
    const res = await fetch(
      `${BASE_URL}/containers/${containerId}/files?path=${encodeURIComponent(path)}`
    )
    return handleResponse<ListDirectoryResult>(res)
  },

  /**
   * Descarga un fichero del contenedor como Blob.
   *
   * Devuelve el contenido y el nombre, y NO una ruta. Que sea el navegador el
   * que lo guarde (con un Blob y un `download`) es lo que mantiene al backend
   * fuera del disco del host: el usuario elige dónde acaba, y el panel nunca
   * escribe ahí.
   */
  async downloadFile(
    containerId: string,
    path: string
  ): Promise<{ blob: Blob; filename: string }> {
    const res = await fetch(
      `${BASE_URL}/containers/${containerId}/files/download?path=${encodeURIComponent(path)}`
    )
    if (!res.ok) {
      return handleResponse<never>(res)
    }
    // El nombre viene en `content-disposition`. Se parsea a mano porque el
    // filename* con acentos (RFC 5987) no lo pone `res.json()` por ningún lado.
    const cabecera = res.headers.get('content-disposition') || ''
    const coincidencia = /filename="([^"]+)"/.exec(cabecera)
    const ultimo = path.split('/').pop() || 'fichero'
    return { blob: await res.blob(), filename: coincidencia?.[1] || ultimo }
  },

  /**
   * Sube ficheros al contenedor (SPEC-20).
   *
   * Se mandan los `File` que el navegador ya leyó del disco del usuario. El
   * nombre (`webkitPath` si viene de una carpeta, `name` si no) viaja como
   * parte del multipart; **la ruta local no viaja nunca**, porque el navegador
   * no la expone. Con `webkitdirectory` el nombre incluye la carpeta, y por eso
   * la estructura se conserva al subir.
   */
  async uploadFiles(
    containerId: string,
    path: string,
    files: File[]
  ): Promise<{ enviados: number }> {
    const formulario = new FormData()
    formulario.append('path', path)
    for (const fichero of files) {
      const relativo = (fichero as File & { webkitRelativePath?: string }).webkitRelativePath
      formulario.append(
        'files',
        fichero,
        relativo && relativo.length > 0 ? relativo : fichero.name
      )
    }
    // Sin `Content-Type` a mano: el navegador tiene que poner el `boundary` del
    // multipart, y si se lo damos nosotros la petición llega sin delimitar.
    const res = await fetch(`${BASE_URL}/containers/${containerId}/files/upload`, {
      method: 'POST',
      body: formulario,
    })
    return handleResponse<{ enviados: number }>(res)
  },
}
