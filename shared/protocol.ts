// ============================================================
// 前后端协议层：socket 事件的 payload 类型
// ------------------------------------------------------------
// 仅放"过线"的类型；服务端内部决策结构（LegalAction、Provider 等）
// 留在 server/llm/types.ts。
// ============================================================

import type { Action } from './reducer';
import type { Phase, ResMap } from './types';

export interface AiModelContextEvent {
  /** 产生该输入快照的 Provider 名称 */
  provider: string;
  /** llm-prompt = 真实发给模型的 prompt；provider-input = rule/mock 的结构化输入 */
  format: 'llm-prompt' | 'provider-input';
  legalActionCount: number;
  retryFeedbackCount: number;
  chars: {
    system?: number;
    user?: number;
    total: number;
    /** 行动决策有；交易聊天没有 */
    view?: number;
    /** 行动决策有；交易聊天里若用则代表 counter 候选数对应的字符量 */
    legalActions?: number;
    providerInput?: number;
  };
  /** Anthropic messages 的 system 字段；仅真实 LLM Provider 有 */
  systemPrompt?: string;
  /** Anthropic messages 的 user content；仅真实 LLM Provider 有 */
  userPrompt?: string;
  /** 非 LLM Provider 没有 prompt，用 JSON 展示其收到的同等决策上下文 */
  providerInputJson?: string;
}

export interface AiTimingStage {
  /** 稳定阶段 key，便于前端归类，例如 provider / checker / catalog */
  key: string;
  /** 中文阶段名，直接给前端展示 */
  label: string;
  ms: number;
  detail?: string;
}

export interface AiTimingEvent {
  /** 服务端开始处理本次 AI step 的时间戳 */
  startedAt: number;
  /** 服务端生成该耗时快照的时间戳 */
  finishedAt: number;
  /** 当前快照总耗时；经过 scheduleAI 补充后等于服务端端到端耗时 */
  totalMs: number;
  /** decideAiStep 内部耗时：catalog/view/prompt/provider/check 等 */
  decisionMs?: number;
  /** setTimeout 调度排队等待耗时 */
  queueMs?: number;
  /** 服务端提交新状态并发出广播的同步耗时 */
  commitMs?: number;
  /** queue + decision + commit 的服务端端到端耗时 */
  serverTotalMs?: number;
  stages: AiTimingStage[];
}

export interface AiThoughtEvent {
  player: number;
  agentName?: string;
  agentPersonality?: string;
  agentMemorySize?: number;
  /** LLM 声明的本回合目标（END_TURN 时由 controller 清空） */
  turnGoal?: string;
  /** LLM 声明的长期策略阶段 */
  stance?: string;
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
  /** Provider / LLM 本次决策拿到的上下文输入快照，供前端分析 prompt 冗余 */
  modelContext?: AiModelContextEvent;
  /** 本次 AI 调用链路的服务端阶段耗时 */
  timing?: AiTimingEvent;
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
  /** 出错那次 Provider / LLM 调用拿到的上下文输入快照 */
  modelContext?: AiModelContextEvent;
  /** 出错那次 AI 调用链路的服务端阶段耗时 */
  timing?: AiTimingEvent;
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
  /** 可在后端切换的 AI provider / 模型档位；不包含任何 API key */
  providerOptions: Array<{
    key: string;
    label: string;
    available: boolean;
    model?: string;
    reason?: string;
  }>;
  /** 各 AI 席位当前的 provider；前端按玩家展示开关时使用 */
  agentProviders: Record<number, string>;
  /** 各 AI 席位的角色策略提示词（即 LLM prompt 内 agent.personality 字段）；前端用作悬浮提示 */
  agentPersonalities: Record<number, string>;
  currentAgent?: {
    player: number;
    name: string;
    provider: string;
    memorySize: number;
  };
}

export type TradeDecisionEvent =
  | 'PROPOSE'
  | 'ACCEPT'
  | 'REJECT'
  | 'COUNTER_OFFER'
  | 'SYSTEM';

export type TradeSessionStatus =
  | 'accepted'
  | 'rejected'
  | 'expired'
  | 'invalid';

/** 交易谈判里的结构化报价；to=null 表示向所有参与 AI 广播的开放报价 */
export interface TradeOfferEvent {
  from: number;
  to: number | null;
  give: ResMap;
  receive: ResMap;
}

export interface TradeLimitsEvent {
  messagesUsed: number;
  messagesMax: number;
  offersUsed: number;
  offersMax: number;
  counterOffersUsed: number;
  counterOffersMax: number;
  repliesByPlayer: Record<number, number>;
  repliesMaxPerPlayer: number;
  sessionsUsedByInitiator: number;
  sessionsMaxPerTurn: number;
}

export interface TradeChatStartedEvent {
  sessionId: string;
  turn: number;
  phase: Phase;
  initiator: number;
  participants: number[];
  proposedTrade: TradeOfferEvent;
  limits: TradeLimitsEvent;
  ts: number;
}

export interface TradeChatMessageEvent {
  sessionId: string;
  turn: number;
  speaker: number | null;
  decision: TradeDecisionEvent;
  message: string;
  offer?: TradeOfferEvent;
  limits: TradeLimitsEvent;
  /** 该条消息背后 LLM 调用的输入快照；仅 LLM provider 生成的消息有，规则 fallback 无 */
  modelContext?: AiModelContextEvent;
  /** LLM 原始返回（解析前的字符串），便于前端排查 */
  rawOutput?: string;
  /** 该 LLM 调用使用的 provider（含模型名），与 modelContext.provider 一致 */
  provider?: string;
  ts: number;
}

export interface TradeChatClosedEvent {
  sessionId: string;
  turn: number;
  status: TradeSessionStatus;
  reason: string;
  finalTrade?: TradeOfferEvent;
  limits: TradeLimitsEvent;
  ts: number;
}
