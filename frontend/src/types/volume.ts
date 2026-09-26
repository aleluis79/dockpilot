export interface VolumeSummary {
  name: string;
  driver: string;
  mountpoint: string;
  scope: string;
  created_at: string;
  size: number;
  ref_count: number;
  is_anonymous: boolean;
  labels: Record<string, string>;
}

export interface VolumeDetail extends VolumeSummary {
  options: Record<string, unknown>;
  containers: string[];
}

export interface VolumePruneResult {
  deleted: string[];
  bytes_reclaimed: number;
  message: string;
}

export interface VolumeDeleteResponse {
  name: string;
  deleted: boolean;
  message: string;
}
