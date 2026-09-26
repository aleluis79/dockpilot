// SPDX-License-Identifier: AGPL-3.0-or-later
export type LogStreamType = 'stdout' | 'stderr' | 'system';

export interface LogEntry {
  timestamp?: string;
  stream: LogStreamType;
  message: string;
}

export interface LogSnapshotResponse {
  id: string;
  total_lines: number;
  lines: LogEntry[];
}
