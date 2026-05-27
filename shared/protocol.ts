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

export interface AiModelOutputEvent {
  /** 产生该输出的 Provider 名称 */
  provider: string;
  /** llm-raw = 真实模型返回的原始文本（解析前）；structured = rule/mock 仅有结构化决策 */
  format: 'llm-raw' | 'structured';
  /** 模型返回的原始文本（JSON 解析之前）；仅真实 LLM Provider 有 */
  rawOutput?: string;
  /** 最终采用的结构化决策（thought / actionId / turnGoal / stance）JSON 字符串 */
  parsedJson: string;
  chars: {
    /** 原始文本字数；仅 LLM 有 */
    raw?: number;
    /** 结构化决策 JSON 字数 */
    parsed: number;
    total: number;
  };
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
  /** Provider / LLM 本次决策返回的输出快照（原始文本 + 解析结果），与 modelContext 对应 */
  modelOutput?: AiModelOutputEvent;
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
  /**
   * 各 AI 席位的 thinking 模式状态。
   * - supported=true 表示该 provider 是注册表里的 LLM（rule/mock 都是 false）
   * - mode='auto' 走 server/llm/thinkingPolicy.ts（setup1/setup2/moveRobber/steal 才开）
   * - mode='on' / 'off' 强制
   * - effective 是当前 phase 下 mode 的实际取值（auto 时已经被 policy 解析过）
   * 仅影响该 agent 的决策路径（buildProvider→adapter）；交易/社交 LLM 仍读 spec 默认。
   */
  thinkingByPlayer: Record<
    number,
    { mode: 'auto' | 'on' | 'off'; effective: boolean; supported: boolean }
  >;
  /**
   * 自由社交聊天（嘴炮/结盟/威胁）总开关。默认开；前端可通过 set_social_chat 实时熄火。
   * 关闭时不触发任何社交 LLM 调用，是防 token 失控的实时刹车。关系账本（确定性、零 LLM）不受影响。
   */
  socialChatEnabled: boolean;
  currentAgent?: {
    player: number;
    name: string;
    provider: string;
    memorySize: number;
  };
  /**
   * LLM 调用累计统计（本次进程启动以来）。
   * 决策 / 交易 / 社交三类 LLM 调用都计入；rule/mock 不计。
   * 新局会清零；服务端重启亦清零（不持久化）。
   */
  llmStats: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
}

export type TradeDecisionEvent =
  | 'PROPOSE'
  | 'CHAT'
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

/** 真人此刻可一键成交的一个候选，均从真人视角描述：真人给 give、收 receive */
export interface HumanStandingDeal {
  player: number;
  give: ResMap;
  receive: ResMap;
  source: 'accept' | 'counter';
  note: string;
}

/** 真人交互谈判的实时状态；每次真人发言或 AI 回应后广播 */
export interface HumanTradeStateEvent {
  active: boolean;
  sessionId?: string;
  turn?: number;
  initiator?: number;
  participants?: number[];
  currentOffer?: TradeOfferEvent | null;
  standingDeals?: HumanStandingDeal[];
  messagesUsed?: number;
  messagesMax?: number;
  /** 服务端正在让 AI 逐个回应本轮喊话 / 报价，前端据此禁用输入 */
  busy?: boolean;
}

// ============================================================
// 社交房间：事件触发的自由发言（嘴炮/结盟/威胁）+ 关系账本快照
// 与交易谈判（trade_chat_*）是不同维度：社交不绑 session、不改游戏状态，纯旁路。
// ============================================================

export type SocialChatKind =
  | 'taunt' // 嘲讽
  | 'ally' // 拉拢结盟
  | 'threat' // 威胁/警告
  | 'gloat' // 炫耀/示威
  | 'chat'; // 普通桌面闲聊

/** 一条 AI 社交发言；由游戏事件（强盗/最长路/逼近胜利等）触发、受预算与开关约束 */
export interface SocialChatEvent {
  player: number;
  agentName?: string;
  /** 触发该发言的事件类型（robber / longest-road / largest-army / near-win） */
  trigger: string;
  /** 发言主要针对的对象（通常是触发事件的主角），前端可用于高亮 */
  target?: number;
  kind: SocialChatKind;
  message: string;
  turn: number;
  phase: Phase;
  /** 生成该发言的 provider（含模型名）；模板兜底为 'template' */
  provider?: string;
  /** LLM 生成时的输入快照；模板兜底无 */
  modelContext?: AiModelContextEvent;
  /** LLM 原始返回（解析前）；模板兜底无 */
  rawOutput?: string;
  ts: number;
}

/** 关系账本扁平快照，供观察者面板可视化（观察局全公开；未来隐私化推送再裁剪） */
export interface RelationshipSnapshotEvent {
  entries: Array<{
    viewer: number;
    target: number;
    trust: number;
    threat: number;
    debt: number;
  }>;
  ts: number;
}

/**
 * 人情账「上墙 / 进 prompt」的统一阈值（单一事实来源）：`|debt| >= 此值` 才显示。
 * 服务端 `relationshipTags`（喂 LLM 的措辞）与前端关系矩阵角标共用它，保证观察者看到的
 * 和模型读到的口径一致——改阈值只动这一处，两侧自动跟随，不会漂移。
 */
export const DEBT_TAG_THRESHOLD = 2;
