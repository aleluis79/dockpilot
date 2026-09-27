// SPDX-License-Identifier: AGPL-3.0-or-later

export interface ComposeService {
  name: string;
  image: string;
  container_names: string[];
  container_ids: string[];
  replicas: number;
  running: number;
}

/**
 * Red de un proyecto compose.
 *
 * `logical_name` es la clave dentro del archivo y `name` el nombre real en
 * Docker, que compose prefija con el proyecto. El archivo puede declarar
 * `elastic` y en Docker ser `tienda_elastic`.
 */
export interface ComposeNetwork {
  logical_name: string;
  name: string;
  driver: string;
}

/** Volumen de un proyecto compose. Misma dualidad de nombres que la red. */
export interface ComposeVolume {
  logical_name: string;
  name: string;
  driver: string;
}

export interface ComposeProjectSummary {
  name: string;
  services_count: number;
  containers_total: number;
  containers_running: number;
  networks_count: number;
  volumes_count: number;
  config_files: string[];
  working_dir: string;
  compose_version: string;
  /** Sin contenedores pero con red o volúmenes: conserva recursos del proyecto. */
  orphaned: boolean;
}

export interface ComposeProjectDetail extends ComposeProjectSummary {
  services: ComposeService[];
  networks: ComposeNetwork[];
  volumes: ComposeVolume[];
}

export interface ComposeOverview {
  projects: ComposeProjectSummary[];
  total_projects: number;
  running_projects: number;
  orphaned_projects: number;
  /** Contenedores sin `com.docker.compose.project`. */
  unlabelled_containers: number;
  unlabelled_networks: number;
  unlabelled_volumes: number;
}

/** Filtro de la pestaña `Proyectos`, análogo a los de Imágenes y Volúmenes. */
export type ComposeProjectFilter = 'all' | 'running' | 'orphaned';

/* --- SPEC-12: previsualización de un archivo compose --- */

export interface ComposePlanRequest {
  path: string;
  content?: string | null;
  project_name?: string | null;
}

export interface PlannedPort {
  target: number;
  /** Cadena, no número: compose devuelve un rango como `8000-8010` tal cual. */
  published: string | null;
  protocol: string;
  mode: string;
}

/** Montaje en forma larga, que es como compose normaliza volúmenes y binds. */
export interface PlannedMount {
  type: string;
  source: string;
  target: string;
  read_only: boolean;
}

export interface PlannedService {
  name: string;
  image: string | null;
  /** Coste de construir. `null` si el servicio no declara `build`. */
  build: PlannedBuild | null;
  container_name: string | null;
  command: string | null;
  entrypoint: string | null;
  restart: string | null;
  ports: PlannedPort[];
  mounts: PlannedMount[];
  networks: string[];
  depends_on: string[];
  profiles: string[];
  /** Cuántas variables declara. Los valores no se devuelven. */
  environment_count: number;
}

/** Red del plan. `external: true` significa que compose no la va a crear. */
export interface PlannedNetwork {
  logical_name: string;
  name: string;
  driver: string;
  external: boolean;
  /** El nombre real ya existe en el daemon: no se crearía. */
  exists: boolean;
}

export interface PlannedVolume {
  logical_name: string;
  name: string;
  driver: string;
  external: boolean;
  /** El nombre real ya existe en el daemon: no se crearía. */
  exists: boolean;
}

/**
 * Configuración resuelta: lo que compose haría, sin haberlo hecho.
 *
 * `warnings` sale de `stderr` con código de salida 0: el archivo es válido pero
 * compose avisa de algo, típicamente una variable sin definir.
 */
export interface PlannedBuild {
  /**
   * Estimación del peso del contexto, **sin aplicar `.dockerignore`**: normalmente
   * sobreestima, y por eso el nombre lo declara. Un número alto hace que el
   * usuario pregunte; uno bajo hace que el `up` tarde 8 minutos sin avisar.
   */
  context: string;
  bytes_aprox: number;
  ficheros_aprox: number;
  /** Se alcanzó el tope de ficheros al medir: la cifra es parcial. */
  truncado: boolean;
  error: string | null;
}

export interface ProjectCollision {
  nombre: string;
  config_files: string[];
  mismo_archivo: boolean;
}

export interface ComposePlan {
  project_name: string;
  source_path: string;
  services: PlannedService[];
  networks: PlannedNetwork[];
  volumes: PlannedVolume[];
  warnings: string[];
  /**
   * Otro proyecto del host ya ocupa este nombre desde otro archivo. Bloquea el
   * despliegue: los nombres de red y volumen llevan prefijo del proyecto, y
   * `container_name` es global en Docker con independencia de él.
   */
  proyecto_en_uso: ProjectCollision | null;
  resolved_by: 'docker-compose-cli';
}

/* --- SPEC-13: ciclo de vida de un proyecto --- */

export type ComposeAction = 'up' | 'stop' | 'down' | 'logs' | 'pull';

export interface ComposeCommandParams {
  action: ComposeAction;
  path: string;
  project_name?: string | null;
  /** Servicio como argumento posicional: compose v2 no tiene `--service`. */
  service?: string | null;
  /** Solo para `logs`. */
  follow?: boolean;
  /** Solo para `down`. Destructivo e irreversible. */
  volumes?: boolean;
  /**
   * `up --remove-orphans`. `false` en el despliegue desde el plan, donde el nombre
   * puede chocar con otro proyecto y el flag se llevaría contenedores ajenos.
   */
  remove_orphans?: boolean;
}

export type ComposeMessage =
  | {
      type: 'start';
      action: string;
      project: string;
      path: string;
      /** Argumentos exactos, para que el usuario vea qué se ejecuta. */
      command: string[];
    }
  | { type: 'output'; stream: 'stdout' | 'stderr'; data: string }
  | { type: 'exit'; action: string; code: number; duration_ms: number }
  | { type: 'error'; code: number; message: string };

export interface ComposeCancelMessage {
  type: 'cancel';
}

// --- SPEC-14: explorador de archivos compose ----------------------------------

export interface BrowseEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  /** El nombre parece un compose file. Ordena el listado, no lo filtra. */
  es_compose: boolean;
  size: number;
  /** mtime en epoch, para ordenar por fecha. */
  modificado: number;
}

export interface BrowseResult {
  path: string;
  root: string;
  /** `null` en la raíz: el botón de subir se deshabilita ahí. */
  parent: string | null;
  entries: BrowseEntry[];
  /** Entradas que había antes de truncar. */
  total: number;
  truncado: boolean;
  /** Entradas omitidas por salir de la raíz vía enlace simbólico. */
  ocultos: number;
}
