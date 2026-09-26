export interface ContainerStats {
  container_id: string;
  container_name: string;
  cpu_percent: number;
  memory_usage: number;
  memory_limit: number;
  memory_percent: number;
  network_rx_bytes: number;
  network_tx_bytes: number;
  block_read_bytes: number;
  block_write_bytes: number;
  pids_current?: number;
  timestamp: string;
}

export interface StatsHistoryPoint {
  timestamp: string;
  cpu_percent: number;
  memory_percent: number;
}
