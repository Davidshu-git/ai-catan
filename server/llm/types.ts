// ============================================================
// LLM 控制层公共类型：Provider 接口、决策输入/输出、思考事件
// ------------------------------------------------------------
// 设计取舍：LLM 不直接生成 Action，而是从 server 生成的 legalActions
// 中选一个 actionId。这样：
//   1) Maker-Checker 三层校验有靠山
//   2) state 唯一权威仍是 reducer
//   3) LLM 乱编坐标/资源的概率显著降低
// ============================================================

import type { Action } from '../../shared/reducer';
import type { PlayerView } from './stateTranslator';

// 协议层事件类型从 shared/protocol re-export，server 内部按惯例走 ./types
export type { AiThoughtEvent, AiErrorEvent } from '../../shared/protocol';

/** 每个 AI 玩家独立注入的 agent 上下文：性格 + 短期记忆 */
export interface AgentPromptContext {
  playerId: number;
  name: string;
  providerName: string;
  personality: string;
  memory: string[];
  decisionCount: number;
}

/** 单条合法动作：稳定 ID + 中文摘要 + 真正派发的 Action */
export interface LegalAction {
  /** 稳定的可读 ID，如 build-road-e17 / end-turn / yop-木-砖 */
  id: string;
  /** 给 LLM 输入与前端展示用的中文摘要 */
  label: string;
  /**
   * 空间动作的"战略情报"：把 v/e/h id 翻译成周围资源/概率/建筑分布的可读文本。
   * 见 server/llm/actionHints.ts。仅 setup-/build-/move-robber 等空间动作填，
   * 银行兑换 / 发展卡 / END_TURN 等不需要。
   */
  hint?: string;
  action: Action;
}

/** 之前一次失败的反馈，用于让 Provider 重试时调整输出 */
export interface RetryFeedback {
  rawOutput?: string;
  parsedActionId?: string;
  error: string;
}

/** 喂给 Provider 的决策输入 */
export interface LlmDecisionInput {
  view: PlayerView;
  legalActions: LegalAction[];
  /** 当前玩家对应的独立 agent；rule/mock/llm 都可以读取 */
  agent?: AgentPromptContext;
  /** 历史失败反馈（按重试顺序） */
  retryFeedback?: RetryFeedback[];
}

/** Provider 必须返回的最小决策结果 */
export interface LlmDecisionOutput {
  thought: string;
  actionId: string;
}

/** Provider 抽象：rule / mock / 真实 LLM 实现这一个接口 */
export interface AiDecisionProvider {
  /** 名称（rule / mock / llm），出现在日志和 ai_thought 事件里便于排查 */
  readonly name: string;
  decide(input: LlmDecisionInput): Promise<LlmDecisionOutput>;
}
