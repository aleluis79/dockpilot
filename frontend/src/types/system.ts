export interface SystemInfo {
  server_version: string
  os_name: string
  os_type: string
  architecture: string
  kernel_version: string
  hostname: string
  ncpu: number
  memory_total: number
  storage_driver: string
  docker_root_dir: string
  containers_total: number
  containers_running: number
  containers_stopped: number
  containers_paused: number
  images_total: number
}

/** Uso y recuperabilidad de un tipo de recurso. */
export interface ResourceUsage {
  total_count: number
  active_count: number
  total_size: number
  /** Bytes que el daemon considera recuperables. */
  reclaimable: number
}

export interface DiskUsage {
  /** Tamaño de las capas de imagen compartidas. */
  layers_size: number
  images: ResourceUsage
  containers: ResourceUsage
  volumes: ResourceUsage
  build_cache_size: number
}

/** Mayor consumidor de espacio, para señalar dónde mirar. */
export interface TopConsumer {
  kind: 'image' | 'container' | 'volume'
  name: string
  size: number
  detail: string
}

/** Payload único para la franja de resumen y su panel de detalle. */
export interface SystemOverview {
  info: SystemInfo
  usage: DiskUsage
  top_images: TopConsumer[]
  top_volumes: TopConsumer[]
}
