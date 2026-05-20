// ============================================================
// 前后端协议层：socket 事件的 payload 类型
// ------------------------------------------------------------
// 仅放"过线"的类型；服务端内部决策结构（LegalAction、Provider 等）
// 留在 server/llm/types.ts。
// ============================================================

import type { Phase } from './types';

export interface AiThoughtEvent {
  player: number;
  phase: Phase;
  thought: string;
  actionId: string;
  actionSummary: string;
  provider: string;
  retries: number;
  status: 'success' | 'fallback';
  ts: number;
}

export interface AiErrorEvent {
  player: number;
  phase: Phase;
  provider: string;
  message: string;
  rawOutput?: string;
  retries: number;
  ts: number;
}
