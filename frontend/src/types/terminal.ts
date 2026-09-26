// SPDX-License-Identifier: AGPL-3.0-or-later
export type TerminalMessageType = 'stdin' | 'resize' | 'stdout' | 'system' | 'error';

export interface TerminalClientMessage {
  type: 'stdin' | 'resize';
  data?: string;
  cols?: number;
  rows?: number;
}

export interface TerminalServerMessage {
  type: 'stdout' | 'system' | 'error';
  data?: string;
  message?: string;
}
