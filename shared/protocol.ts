// ============================================================
// 前后端协议层：socket 事件的 payload 类型
// ------------------------------------------------------------
// 仅放"过线"的类型；服务端内部决策结构（LegalAction、Provider 等）
// 留在 server/llm/types.ts。
// ============================================================

import type { Action } from './reducer';
import type { Phase } from './types';

export interface AiThoughtEvent {
  player: number;
  agentName?: string;
  agentPersonality?: string;
  agentMemorySize?: number;
  phase: Phase;
  thought: string;
  actionId: string;
  actionSummary: string;
  /**
   * 该 actionId 对应的"语义化情报"（见 server/llm/actionHints.ts）。
   * 仅空间动作有；前端在思考流面板里渲染，方便观察 LLM 是基于什么信息做的决定。
   * discard fallback 等不走 LegalAction 的路径没有 hint。
   */
  actionHint?: string;
  /** 已通过服务端 Maker-Checker 的真实动作；前端可用来做棋盘联动高亮 */
  action?: Action;
  provider: string;
  retries: number;
  status: 'success' | 'fallback';
  ts: number;
}

export interface AiErrorEvent {
  player: number;
  agentName?: string;
  phase: Phase;
  provider: string;
  message: string;
  rawOutput?: string;
  retries: number;
  ts: number;
}

export interface AiControlState {
  /** true 时服务端会在 AI 行动后继续自动调度下一步；false 时只响应 step_ai */
  autoplay: boolean;
  /** 已有 setTimeout 等待执行下一步 */
  queued: boolean;
  /** Provider 正在决策中，可能是一次长 LLM 调用 */
  busy: boolean;
  /** 当前局面是否存在可由 AI 推进的一步 */
  canStep: boolean;
  /**
   * LLM Provider 当前是否会在 prompt 里塞空间动作 hint。
   * 仅影响 llm provider；rule/mock 永远忽略 hint。前端思考流的历史条目
   * 不受此开关影响（已记录的 actionHint 字段照常显示），切换只影响后续 LLM 决策。
   */
  hintEnabled: boolean;
  provider: string;
  currentAgent?: {
    player: number;
    name: string;
    provider: string;
    memorySize: number;
  };
}
