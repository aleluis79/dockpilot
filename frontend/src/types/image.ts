export interface ImageSearchResult {
  name: string;
  description: string;
  is_official: boolean;
  star_count: number;
}

export interface LocalImageSummary {
  id: string;
  tags: string[];
  size: number;
  created: number;
  containers: number;
  repo_digests: string[];
}

export interface ImageHistoryEntry {
  id: string;
  created: number;
  created_by: string;
  size: number;
  comment: string;
  tags?: string[] | null;
}

export interface ImageDetail {
  id: string;
  tags: string[];
  repo_digests: string[];
  size: number;
  created: number;
  architecture: string;
  os: string;
  entrypoint?: string[] | null;
  cmd?: string[] | null;
  env: string[];
  exposed_ports: Record<string, unknown>;
  working_dir: string;
  user: string;
  labels: Record<string, string>;
  layer_count: number;
  history: ImageHistoryEntry[];
}

export type ImagePullMessageType = 'start' | 'layer' | 'digest' | 'done' | 'error';

export interface ImagePullMessage {
  type: ImagePullMessageType;
  image: string;
  id?: string;
  status?: string;
  current?: number;
  total?: number;
  progress?: string;
  digest?: string;
  tags?: string[];
  code?: number;
  message?: string;
}

export type ImageLayerState = 'pending' | 'downloading' | 'extracting' | 'done';

export interface ImagePullLayer {
  id: string;
  status: string;
  current: number;
  total: number;
  state: ImageLayerState;
}

export interface ImageDeleteResponse {
  id: string;
  deleted: boolean;
  untagged: string[];
  message: string;
}
