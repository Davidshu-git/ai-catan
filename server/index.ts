// ============================================================
// 卡坦岛后端：socket.io WebSocket 服务
// ------------------------------------------------------------
// 职责：
//   1. 持有"上帝视角"游戏状态（单房间 MVP，Map 结构铺多房间路）
//   2. 接收客户端 dispatch(Action)，跑 reducer，广播新状态
//   3. AI 驱动循环：通过 AiDecisionProvider 抽象，rule/mock/llm 可切换
//      事件驱动 + 状态指纹防卡死 + Maker-Checker 三层校验
//   4. 人→AI 交易的服务端自动应答（搬自原 App.tsx 同步逻辑）
//   5. AI-only 交易谈判编排与 trade_chat_* 可视化事件
//   6. 广播 ai_thought / ai_error 供前端做决策可视化
//   7. 提供 AI 自动 / 暂停 / 单步推进控制事件，便于观察 LLM 决策
//   8. 支持观察者把席位切成真人，并与 AI 进行多轮交互谈判
//
// 不在本轮做：玩家身份认证、多房间匹配。
// ============================================================

import { createServer } from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import { Server, type Socket } from 'socket.io';

import { createGame } from '../shared/state';
import { reduce, type Action } from '../shared/reducer';
import { aiAcceptsTrade } from '../shared/ai';
import { RESOURCES, type FullGame, type GameState, type ResMap } from '../shared/types';
import type {
  AiControlState,
  AiModelContextEvent,
  RelationshipSnapshotEvent,
  SocialChatEvent,
  TradeChatClosedEvent,
  TradeChatMessageEvent,
  TradeDecisionEvent,
  TradeLimitsEvent,
  TradeOfferEvent,
} from '../shared/protocol';

import type { AgentPromptContext, AiDecisionProvider, AiErrorEvent, AiThoughtEvent, AiTimingEvent } from './llm/types';
import { createRuleProvider } from './llm/ruleProvider';
import { createMockProvider } from './llm/mockProvider';
import { createLlmProvider } from './llm/llmProvider';
import { createQwenProvider } from './llm/qwenProvider';
import { resolveProviderKey, findModel, llmModelOptions } from './llm/modelRegistry';
import { decideAiStep } from './llm/controller';
import {
  createAgentRuntimes,
  rememberAgentDecision,
  toAgentPromptContext,
  type AiAgentRuntime,
} from './agents/types';
import {
  createAiTradeLedger,
  maybeRunAiNegotiation,
  type AiTradeLedger,
  type TradeEventEntry,
  type TradeDecideFn,
  type TradeProposeMessageFn,
  type TradeInitiateFn,
} from './trading/negotiationManager';
import {
  decideTradeChatResponse,
  decideTradeResponse,
  generateProposeMessage,
  decideTradeInitiation,
  buildCounterCandidates,
} from './llm/tradeProvider';
import {
  HUMAN_TRADE_LIMITS,
  cloneOffer,
  cloneRes,
  deriveStandingDeals,
  emptyRes,
  humanTradeStateEvent,
  resTotal,
  validateHumanOffer,
  type HumanTradeSession,
} from './trading/humanTrade';
import {
  applyTradeOutcome,
  applyTransition,
  createRelationshipLedger,
  describeRelationships,
  snapshotLedger,
  type RelationshipEvent,
  type RelationshipLedger,
} from './social/relationshipLedger';
import {
  createSocialBudget,
  maybeRunSocialChat,
  type SocialChatBudget,
  type SocialLineFn,
} from './social/socialChat';
import { generateSocialLine } from './llm/socialProvider';
import {
  loadSnapshot,
  persistDebounceMs,
  persistEnabled,
  saveSnapshot,
  type AiEventLogEntry,
  type TradeEventLogEntry,
  type SessionSnapshot,
} from './persist';
import { appendAiTrace, traceHttpEnabled } from './trace';

const PORT = Number(process.env.PORT ?? 3001);
const AI_TICK_MS = Number(process.env.AI_TICK_MS ?? 460); // 每步 AI 之间的节奏
const STALL_LIMIT = 8; // 状态指纹连续重复阈值
const AI_EVENT_BUFFER = 60; // 每房间缓存最近 N 条 AI 事件，用于断线后补拉
const TRADE_EVENT_BUFFER = 80; // 每房间缓存最近 N 条交易谈判事件
const SOCIAL_EVENT_BUFFER = 60; // 每房间缓存最近 N 条社交发言，用于断线后补拉
const DEFAULT_ROOM = 'default'; // MVP：单房间
const AI_PROVIDER = normalizeProviderName(process.env.AI_PROVIDER ?? 'qwen36'); // rule | mock | <注册表里的模型 key>，见 llm/modelRegistry.ts
const DEFAULT_AI_AUTOPLAY = process.env.AI_AUTOPLAY === '1'; // 默认手动，便于观察 AI 单步决策
const DEFAULT_AI_HINT = process.env.LLM_HINT !== '0'; // LLM prompt 默认带空间动作 hint；=0 关闭
const DEFAULT_SOCIAL_CHAT = process.env.SOCIAL_CHAT !== '0'; // 自由社交聊天默认开；=0 显式关闭以省 token
const PLAYER_MODE = (process.env.PLAYER_MODE ?? 'all-ai').toLowerCase(); // all-ai | human0

/** provider 字符串归一到稳定 key（rule/mock/注册表模型 key）；细节见 modelRegistry.resolveProviderKey */
function normalizeProviderName(raw: string): string {
  return resolveProviderKey(raw);
}

function aiProviderOptions(): AiControlState['providerOptions'] {
  return [
    { key: 'rule', label: '规则 AI', available: true },
    { key: 'mock', label: 'Mock LLM', available: true },
    ...llmModelOptions(),
  ];
}

interface Session {
  game: FullGame;
  /** 每次权威状态变更递增；用于丢弃异步 LLM 返回的过期决策 */
  version: number;
  stall: { sig: string; count: number };
  aiTimer: NodeJS.Timeout | null;
  /** 是否自动连续推进 AI；关闭时只响应前端 step_ai */
  aiAutoplay: boolean;
  /** 当前是否在 LLM prompt 里塞空间动作 hint；运行时可切换便于 A/B */
  aiHint: boolean;
  /** LLM 调用期间置 true，避免同一房间并发跑多个 AI 决策 */
  aiBusy: boolean;
  /** 会话级 AI provider（llm / rule / mock）；前端可通过 set_ai_provider 切换，new_game 也保留 */
  aiProvider: string;
  /** 每个 AI 席位独立 agent runtime（身份 / 性格 / 记忆 / provider） */
  agents: Record<number, AiAgentRuntime>;
  /** 当前回合 AI 交易谈判限流账本 */
  tradeLedger: AiTradeLedger;
  /** 关系账本：各玩家对彼此的看法（信任/警惕/人情），由游戏事件确定性更新 */
  relationships: RelationshipLedger;
  /** 自由社交聊天开关（默认 DEFAULT_SOCIAL_CHAT）；运行时可由 set_social_chat 实时熄火 */
  socialChatEnabled: boolean;
  /** 社交发言预算（每回合/整局上限 + 每 agent 冷却） */
  socialBudget: SocialChatBudget;
  /** 社交发言生成中标志，避免并发触发多组社交决策 */
  socialBusy: boolean;
  /** 环形 buffer：最近的社交发言，用于断线后补拉 */
  socialEvents: SocialChatEvent[];
  /** 环形 buffer：最近的 AI 决策事件，便于晚来的客户端补齐上下文 */
  aiEvents: AiEventLogEntry[];
  /** 环形 buffer：最近的交易谈判事件，便于晚来的客户端补齐上下文 */
  tradeEvents: TradeEventLogEntry[];
  /** 进行中的真人交互谈判（同一房间一次一个） */
  humanTrade: HumanTradeSession | null;
  /** 真人谈判 session id 序号 */
  humanTradeSeq: number;
}

const sessions = new Map<string, Session>();
const snapshotTimers = new Map<string, NodeJS.Timeout>();

function ensureGameStartedAt(game: FullGame): FullGame {
  if (
    game.startedAt === null ||
    (typeof game.startedAt === 'number' && Number.isFinite(game.startedAt))
  ) {
    return game;
  }
  return { ...game, startedAt: Date.now() };
}

function withStartedAt(game: FullGame, startedAt = Date.now()): FullGame {
  return game.startedAt == null ? { ...game, startedAt } : game;
}

function restoreSession(snap: SessionSnapshot): Session {
  const aiProvider = normalizeProviderName(snap.flags.aiProvider ?? AI_PROVIDER);
  const game = ensureGameStartedAt(snap.game);
  const agents = createAgentRuntimes(game.state, aiProvider);
  for (const [idText, saved] of Object.entries(snap.agents ?? {})) {
    const id = Number(idText);
    const agent = agents[id];
    if (!agent) continue;
    agent.providerName = normalizeProviderName(saved.providerName ?? agent.providerName);
    agent.memory = Array.isArray(saved.memory) ? [...saved.memory] : [];
    agent.decisionCount =
      typeof saved.decisionCount === 'number' && Number.isFinite(saved.decisionCount)
        ? saved.decisionCount
        : agent.memory.length;
    agent.currentTurnGoal = saved.currentTurnGoal;
    agent.stance = saved.stance;
  }
  return {
    game,
    version: snap.version,
    stall: { sig: '', count: 0 },
    aiTimer: null,
    aiAutoplay: Boolean(snap.flags.aiAutoplay),
    aiHint: Boolean(snap.flags.aiHint),
    aiBusy: false,
    aiProvider,
    agents,
    tradeLedger: createAiTradeLedger(),
    relationships: snap.relationships ?? createRelationshipLedger(game.state),
    socialChatEnabled: Boolean(snap.flags.socialChatEnabled),
    socialBudget: createSocialBudget(),
    socialBusy: false,
    socialEvents: (snap.buffers?.social ?? []).slice(-SOCIAL_EVENT_BUFFER),
    aiEvents: (snap.buffers?.ai ?? []).slice(-AI_EVENT_BUFFER),
    tradeEvents: (snap.buffers?.trade ?? []).slice(-TRADE_EVENT_BUFFER),
    humanTrade: null,
    humanTradeSeq: 0,
  };
}

function createFreshSession(): Session {
  const game = createServerGame();
  return {
    game,
    version: 0,
    stall: { sig: '', count: 0 },
    aiTimer: null,
    aiAutoplay: DEFAULT_AI_AUTOPLAY,
    aiHint: DEFAULT_AI_HINT,
    aiBusy: false,
    aiProvider: AI_PROVIDER,
    agents: createAgentRuntimes(game.state, AI_PROVIDER),
    tradeLedger: createAiTradeLedger(),
    relationships: createRelationshipLedger(game.state),
    socialChatEnabled: DEFAULT_SOCIAL_CHAT,
    socialBudget: createSocialBudget(),
    socialBusy: false,
    socialEvents: [],
    aiEvents: [],
    tradeEvents: [],
    humanTrade: null,
    humanTradeSeq: 0,
  };
}

function getSession(roomId: string): Session {
  let s = sessions.get(roomId);
  if (!s) {
    const snap = loadSnapshot(roomId);
    if (snap) {
      try {
        s = restoreSession(snap);
        console.log(
          `[persist] 已恢复房间 ${roomId}：game=${s.game.state.gameId}, turn=${s.game.state.turn}, version=${s.version}`,
        );
      } catch (err) {
        console.warn(`[persist] 恢复房间 ${roomId} 失败，改开新局:`, err);
        s = createFreshSession();
      }
    } else {
      s = createFreshSession();
    }
    sessions.set(roomId, s);
  }
  return s;
}

function createServerGame(): FullGame {
  const game = createGame();
  if (PLAYER_MODE !== 'human0') {
    for (const p of game.state.players) {
      p.isAI = true;
      if (p.id === 0) p.name = '';
    }
    game.state.log = [{ text: '观察局开始：4 个独立 AI Agent 将按控制面板逐步行动。' }];
  }
  return game;
}

// 与 sim.ts / 原 App.tsx 用同一份指纹算法，便于一致性排查
function stateFingerprint(s: GameState): string {
  return [
    s.turn,
    s.phase,
    s.current,
    Object.keys(s.buildings).length,
    Object.keys(s.roads).length,
    s.players.map((p) => RESOURCES.reduce((t, r) => t + p.resources[r], 0)).join(','),
    s.devDeck.length,
  ].join('|');
}

function broadcastState(io: Server, roomId: string) {
  io.to(roomId).emit('sync_state', sessions.get(roomId)!.game);
}

function saveSessionSoon(roomId: string, session: Session, immediate = false) {
  if (!persistEnabled()) return;
  const existing = snapshotTimers.get(roomId);
  if (existing) {
    clearTimeout(existing);
    snapshotTimers.delete(roomId);
  }

  const run = () => {
    snapshotTimers.delete(roomId);
    void saveSnapshot(roomId, session).catch((err) => {
      console.warn(`[persist] 保存房间 ${roomId} 快照失败:`, err);
    });
  };

  if (immediate || persistDebounceMs() === 0) {
    run();
    return;
  }

  snapshotTimers.set(roomId, setTimeout(run, persistDebounceMs()));
}

async function flushSessionSnapshot(roomId: string, session: Session): Promise<void> {
  if (!persistEnabled()) return;
  const existing = snapshotTimers.get(roomId);
  if (existing) {
    clearTimeout(existing);
    snapshotTimers.delete(roomId);
  }
  try {
    await saveSnapshot(roomId, session);
  } catch (err) {
    console.warn(`[persist] 保存房间 ${roomId} 快照失败:`, err);
  }
}

async function flushAllSnapshots(): Promise<void> {
  await Promise.all([...sessions.entries()].map(([roomId, session]) => flushSessionSnapshot(roomId, session)));
}

function hasAiWork(s: GameState): boolean {
  if (s.phase === 'gameOver') return false;
  if (s.phase === 'discard') {
    return Object.keys(s.discardLeft).some((pid) => s.players[Number(pid)]?.isAI);
  }
  return Boolean(s.players[s.current]?.isAI);
}

function getDecisionAgent(session: Session, state = session.game.state): AiAgentRuntime | null {
  if (state.phase === 'discard') {
    const pid = Object.keys(state.discardLeft)
      .map(Number)
      .find((id) => state.players[id]?.isAI);
    return pid == null ? null : session.agents[pid] ?? null;
  }
  if (!state.players[state.current]?.isAI) return null;
  return session.agents[state.current] ?? null;
}

/**
 * 构造某玩家的 agent prompt 上下文，并按其视角注入关系账本看法。
 * 所有要把 agent 喂给 Provider 的地方都走这里，保证 relationships 统一注入。
 */
function agentPromptContextFor(
  session: Session,
  playerId: number,
  state = session.game.state,
): AgentPromptContext | undefined {
  const rt = session.agents[playerId];
  if (!rt) return undefined;
  const ctx = toAgentPromptContext(rt);
  ctx.relationships = describeRelationships(session.relationships, playerId, state);
  return ctx;
}

function getAiControlState(session: Session): AiControlState {
  const currentAgent = getDecisionAgent(session);
  const agentProviders: Record<number, string> = {};
  const agentPersonalities: Record<number, string> = {};
  for (const agent of Object.values(session.agents)) {
    agentProviders[agent.playerId] = agent.providerName;
    agentPersonalities[agent.playerId] = agent.personality;
  }
  return {
    autoplay: session.aiAutoplay,
    queued: session.aiTimer != null,
    busy: session.aiBusy,
    canStep: hasAiWork(session.game.state),
    hintEnabled: session.aiHint,
    socialChatEnabled: session.socialChatEnabled,
    provider: currentAgent?.providerName ?? session.aiProvider,
    providerOptions: aiProviderOptions(),
    agentProviders,
    agentPersonalities,
    currentAgent: currentAgent
      ? {
          player: currentAgent.playerId,
          name: currentAgent.name,
          provider: currentAgent.providerName,
          memorySize: currentAgent.memory.length,
        }
      : undefined,
  };
}

function emitAiControl(io: Server, roomId: string, session = getSession(roomId)) {
  io.to(roomId).emit('ai_control_state', getAiControlState(session));
}

function applyAction(io: Server, roomId: string, action: Action) {
  const session = getSession(roomId);
  const prev = session.game.state;
  const next = reduce(session.game.board, prev, action);
  session.game = withStartedAt({ ...session.game, state: next });
  session.version++;
  // 关系账本：捕捉强盗/最长路/最大军队/逼近胜利等敌意信号（不推断成交）
  const relEvents = applyTransition(session.relationships, session.game.board, prev, next);
  broadcastState(io, roomId);
  saveSessionSoon(roomId, session);
  // 社交发言（旁路、异步、受开关/预算约束）；applyAction 为同步，故 fire-and-forget
  void runSocial(io, roomId, session, relEvents);
}

function pushAiEvent(roomId: string, session: Session, entry: AiEventLogEntry) {
  session.aiEvents.push(entry);
  if (session.aiEvents.length > AI_EVENT_BUFFER) {
    session.aiEvents.splice(0, session.aiEvents.length - AI_EVENT_BUFFER);
  }
  void appendAiTrace(roomId, session.game.state.gameId, entry);
  saveSessionSoon(roomId, session);
}

function pushTradeEvent(roomId: string, session: Session, entry: TradeEventLogEntry) {
  session.tradeEvents.push(entry);
  if (session.tradeEvents.length > TRADE_EVENT_BUFFER) {
    session.tradeEvents.splice(0, session.tradeEvents.length - TRADE_EVENT_BUFFER);
  }
  saveSessionSoon(roomId, session);
}

function emitThought(io: Server, roomId: string, session: Session, ev: AiThoughtEvent) {
  rememberThought(session, ev);
  pushAiEvent(roomId, session, { kind: 'thought', data: ev });
  io.to(roomId).emit('ai_thought', ev);
}

function emitError(io: Server, roomId: string, session: Session, ev: AiErrorEvent) {
  pushAiEvent(roomId, session, { kind: 'error', data: ev });
  io.to(roomId).emit('ai_error', ev);
}

function emitTradeEvent(io: Server, roomId: string, session: Session, entry: TradeEventEntry) {
  pushTradeEvent(roomId, session, entry);
  const eventName =
    entry.kind === 'started'
      ? 'trade_chat_started'
      : entry.kind === 'message'
        ? 'trade_chat_message'
        : 'trade_chat_closed';
  io.to(roomId).emit(eventName, entry.data);
}

function emitSocialChat(io: Server, roomId: string, session: Session, ev: SocialChatEvent) {
  session.socialEvents.push(ev);
  if (session.socialEvents.length > SOCIAL_EVENT_BUFFER) {
    session.socialEvents.splice(0, session.socialEvents.length - SOCIAL_EVENT_BUFFER);
  }
  saveSessionSoon(roomId, session);
  io.to(roomId).emit('social_chat', ev);
}

function relationshipSnapshotEvent(session: Session): RelationshipSnapshotEvent {
  return { entries: snapshotLedger(session.relationships), ts: Date.now() };
}

function emitRelationshipState(io: Server, roomId: string, session = getSession(roomId)) {
  io.to(roomId).emit('relationship_state', relationshipSnapshotEvent(session));
}

/** 社交发言生成器：按 speaker 的 agent providerName 走模板或 LLM */
function makeSocialGenerate(session: Session): SocialLineFn {
  return (speaker, trigger, agent) => {
    const providerName = session.agents[speaker]?.providerName ?? session.aiProvider;
    return generateSocialLine(
      {
        state: session.game.state,
        speaker,
        triggerKind: trigger.type,
        triggerNote: trigger.note,
        target: trigger.actor,
        agent,
      },
      providerName,
    );
  };
}

/**
 * 在一次状态跃迁的关系事件上跑社交发言。纯旁路、不改状态。
 * 开关关 / 无事件 / 已在跑则直接跳过；跑完广播关系账本快照。
 */
async function runSocial(
  io: Server,
  roomId: string,
  session: Session,
  relEvents: RelationshipEvent[],
) {
  if (!session.socialChatEnabled || relEvents.length === 0 || session.socialBusy) return;
  session.socialBusy = true;
  try {
    await maybeRunSocialChat(
      session.game.state,
      session.relationships,
      relEvents,
      session.socialBudget,
      makeSocialGenerate(session),
      (pid) => agentPromptContextFor(session, pid),
      () => session.socialChatEnabled,
      (ev) => {
        ev.agentName = session.agents[ev.player]?.name;
        emitSocialChat(io, roomId, session, ev);
      },
    );
    emitRelationshipState(io, roomId, session);
  } finally {
    session.socialBusy = false;
  }
}

function emitHumanTradeState(io: Server, roomId: string, session = getSession(roomId)) {
  io.to(roomId).emit(
    'human_trade_state',
    humanTradeStateEvent(session.game.board, session.game.state, session.humanTrade),
  );
}

function humanLimits(session: HumanTradeSession): TradeLimitsEvent {
  const repliesByPlayer: Record<number, number> = {};
  for (const player of session.participants) {
    repliesByPlayer[player] = session.stances[player]?.decision ? 1 : 0;
  }
  return {
    messagesUsed: session.humanMessages,
    messagesMax: HUMAN_TRADE_LIMITS.messagesPerSession,
    offersUsed: session.currentOffer ? 1 : 0,
    offersMax: 1,
    counterOffersUsed: Object.values(session.stances).filter(
      (stance) => stance.decision === 'COUNTER_OFFER',
    ).length,
    counterOffersMax: session.participants.length,
    repliesByPlayer,
    repliesMaxPerPlayer: 1,
    sessionsUsedByInitiator: 1,
    sessionsMaxPerTurn: 1,
  };
}

function normalizeResMap(raw: unknown): ResMap {
  const out = emptyRes();
  if (!raw || typeof raw !== 'object') return out;
  const obj = raw as Record<string, unknown>;
  for (const r of RESOURCES) {
    const n = obj[r];
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) out[r] = Math.floor(n);
  }
  return out;
}

function pushHumanTradeMessage(
  io: Server,
  roomId: string,
  trade: HumanTradeSession,
  speaker: number | null,
  decision: TradeDecisionEvent,
  message: string,
  offer?: TradeOfferEvent,
  meta?: { modelContext?: AiModelContextEvent; rawOutput?: string; provider?: string },
) {
  const session = getSession(roomId);
  const data: TradeChatMessageEvent = {
    sessionId: trade.sessionId,
    turn: trade.turn,
    speaker,
    decision,
    message,
    offer: offer ? cloneOffer(offer) : undefined,
    limits: humanLimits(trade),
    modelContext: meta?.modelContext,
    rawOutput: meta?.rawOutput,
    provider: meta?.provider,
    ts: Date.now(),
  };
  trade.messages.push(data);
  emitTradeEvent(io, roomId, session, { kind: 'message', data });
}

function closeHumanTrade(
  io: Server,
  roomId: string,
  status: TradeChatClosedEvent['status'],
  reason: string,
  finalTrade?: TradeOfferEvent,
) {
  const session = getSession(roomId);
  const trade = session.humanTrade;
  if (!trade || trade.status !== 'open') {
    emitHumanTradeState(io, roomId, session);
    return;
  }
  const data: TradeChatClosedEvent = {
    sessionId: trade.sessionId,
    turn: trade.turn,
    status,
    reason,
    finalTrade: finalTrade ? cloneOffer(finalTrade) : undefined,
    limits: humanLimits(trade),
    ts: Date.now(),
  };
  trade.status = 'closed';
  session.humanTrade = null;
  emitTradeEvent(io, roomId, session, { kind: 'closed', data });
  emitHumanTradeState(io, roomId, session);
}

function closeHumanTradeIfStale(io: Server, roomId: string, session = getSession(roomId)) {
  const trade = session.humanTrade;
  if (!trade || trade.status !== 'open') return;
  const { state } = session.game;
  if (state.phase === 'main' && state.current === trade.initiator) return;
  closeHumanTrade(io, roomId, 'rejected', '局面变化，真人谈判结束');
}

function rememberTradeReply(
  session: Session,
  player: number,
  decision: TradeDecisionEvent,
  message: string,
) {
  const agent = session.agents[player];
  if (!agent) return;
  rememberAgentDecision(agent, {
    phase: session.game.state.phase,
    actionSummary: `真人谈判回应：${decision}`,
    thought: message,
  });
}

async function runHumanTradeRound(io: Server, roomId: string, trade: HumanTradeSession) {
  const session = getSession(roomId);
  if (session.humanTrade !== trade || trade.status !== 'open') return;
  const startVersion = session.version;
  const { board } = session.game;

  for (const player of trade.participants) {
    const state = session.game.state;
    if (!state.players[player]?.isAI) continue;
    if (session.humanTrade !== trade || trade.status !== 'open') return;

    const agent = session.agents[player];
    const providerName = agent?.providerName ?? session.aiProvider;

    if (!trade.currentOffer) {
      const resp = await decideTradeChatResponse(
        {
          state,
          responderId: player,
          history: trade.messages,
          agent: agentPromptContextFor(session, player, state),
        },
        providerName,
      );
      if (session.version !== startVersion || session.humanTrade !== trade || trade.status !== 'open') {
        return;
      }
      pushHumanTradeMessage(
        io,
        roomId,
        trade,
        player,
        'CHAT',
        resp.message || '我听到了，先看看你具体想怎么换。',
        undefined,
        { modelContext: resp.modelContext, rawOutput: resp.rawOutput, provider: resp.provider },
      );
      rememberTradeReply(session, player, 'CHAT', resp.message);
      emitHumanTradeState(io, roomId, session);
      continue;
    }

    const directOffer: TradeOfferEvent = {
      from: trade.initiator,
      to: player,
      give: cloneRes(trade.currentOffer.give),
      receive: cloneRes(trade.currentOffer.receive),
    };
    const counterCandidates = buildCounterCandidates(state, directOffer);
    const resp = await decideTradeResponse(
      {
        board,
        state,
        responderId: player,
        offer: directOffer,
        history: trade.messages,
        counterCandidates,
        agent: agentPromptContextFor(session, player, state),
      },
      providerName,
    );

    if (session.version !== startVersion || session.humanTrade !== trade || trade.status !== 'open') {
      return;
    }

    let msgOffer: TradeOfferEvent | undefined;
    if (resp.decision === 'ACCEPT') {
      trade.stances[player] = { player, decision: 'ACCEPT' };
      msgOffer = cloneOffer(directOffer);
    } else if (resp.decision === 'COUNTER_OFFER') {
      const candidate = counterCandidates.find((c) => c.id === resp.counterId);
      if (candidate) {
        trade.stances[player] = {
          player,
          decision: 'COUNTER_OFFER',
          counter: {
            give: cloneRes(candidate.give),
            receive: cloneRes(candidate.receive),
            note: candidate.label,
          },
        };
        msgOffer = {
          from: player,
          to: trade.initiator,
          give: cloneRes(candidate.give),
          receive: cloneRes(candidate.receive),
        };
      } else {
        trade.stances[player] = { player, decision: 'REJECT' };
      }
    } else {
      trade.stances[player] = { player, decision: 'REJECT' };
    }

    pushHumanTradeMessage(
      io,
      roomId,
      trade,
      player,
      trade.stances[player].decision ?? 'REJECT',
      resp.message || '我暂时不接受这笔交易。',
      msgOffer,
      { modelContext: resp.modelContext, rawOutput: resp.rawOutput, provider: resp.provider },
    );
    rememberTradeReply(session, player, trade.stances[player].decision ?? 'REJECT', resp.message);
    emitHumanTradeState(io, roomId, session);
  }
}

function runHumanTradeRoundWithBusy(io: Server, roomId: string, trade: HumanTradeSession) {
  const session = getSession(roomId);
  if (session.humanTrade !== trade || trade.status !== 'open') {
    emitHumanTradeState(io, roomId, session);
    return;
  }
  trade.busy = true;
  emitHumanTradeState(io, roomId, session);
  void runHumanTradeRound(io, roomId, trade)
    .catch((err) => {
      console.warn('[catan-server] 真人谈判 AI 回应失败:', err);
      if (session.humanTrade === trade && trade.status === 'open') {
        pushHumanTradeMessage(
          io,
          roomId,
          trade,
          null,
          'SYSTEM',
          `AI 回应失败：${(err as Error).message}`,
        );
      }
    })
    .finally(() => {
      if (session.humanTrade !== trade || trade.status !== 'open') return;
      trade.busy = false;
      emitHumanTradeState(io, roomId, session);
    });
}


function rememberThought(session: Session, ev: AiThoughtEvent) {
  const agent = session.agents[ev.player];
  if (!agent) return;
  rememberAgentDecision(agent, {
    phase: ev.phase,
    thought: ev.thought,
    actionSummary: ev.actionSummary,
  });
  // 更新意图：LLM 给了新的 turnGoal/stance 就采纳；END_TURN 时清空 currentTurnGoal
  if (ev.turnGoal) agent.currentTurnGoal = ev.turnGoal;
  if (ev.stance) agent.stance = ev.stance;
  if (ev.action?.type === 'END_TURN') agent.currentTurnGoal = undefined;
  // 回写最新意图给前端展示（即便 LLM 没给，也能保留 server 端 agent 的当前态）
  ev.turnGoal = agent.currentTurnGoal;
  ev.stance = agent.stance;
  ev.agentMemorySize = agent.memory.length;
}

function withScheduleTiming<T extends { timing?: AiTimingEvent }>(
  ev: T,
  scheduledAt: number,
  stepStartedAt: number,
  commitMs: number,
): T {
  const finishedAt = Date.now();
  const queueMs = Math.max(0, stepStartedAt - scheduledAt);
  const serverTotalMs = Math.max(0, finishedAt - scheduledAt);
  const timing =
    ev.timing ??
    ({
      startedAt: stepStartedAt,
      finishedAt,
      totalMs: Math.max(0, finishedAt - stepStartedAt),
      decisionMs: Math.max(0, finishedAt - stepStartedAt),
      stages: [],
    } satisfies AiTimingEvent);

  timing.queueMs = queueMs;
  timing.commitMs = commitMs;
  timing.serverTotalMs = serverTotalMs;
  timing.totalMs = serverTotalMs;
  timing.finishedAt = finishedAt;
  timing.stages = [
    { key: 'queue', label: 'AI 调度等待', ms: queueMs },
    ...timing.stages.filter((s) => s.key !== 'queue' && s.key !== 'commit'),
    { key: 'commit', label: '状态提交 / sync_state 广播', ms: commitMs },
  ];
  ev.timing = timing;
  return ev;
}

function buildProvider(
  name: string,
  board: FullGame['board'],
  state: GameState,
  useHint: boolean,
): AiDecisionProvider {
  const key = resolveProviderKey(name);
  if (key === 'mock') return createMockProvider();
  if (key === 'rule') return createRuleProvider(board, state);

  // 其余一律是注册表里的 LLM 模型：按 api 形态分派到对应 adapter
  const spec = findModel(key);
  if (!spec) {
    console.warn(`[catan-server] 未知 AI_PROVIDER="${name}"，回退到 rule`);
    return createRuleProvider(board, state);
  }
  const apiKey = process.env[spec.apiKeyEnv];
  if (!apiKey) {
    console.warn(
      `[catan-server] ${spec.label} 缺 ${spec.apiKeyEnv}，本次回退到 rule（请在 .env 里填上）`,
    );
    return createRuleProvider(board, state);
  }
  if (spec.api === 'anthropic') {
    return createLlmProvider({ apiKey, host: spec.endpoint, model: spec.model, useHint });
  }
  return createQwenProvider({ apiKey, baseUrl: spec.endpoint, model: spec.model, useHint });
}

// 事件驱动的 AI 驱动循环：每次 dispatch 后调用；非 AI 回合 / gameOver 自然停。
function scheduleAI(
  io: Server,
  roomId: string,
  opts: { force?: boolean; singleStep?: boolean } = {},
) {
  const session = getSession(roomId);
  if (!opts.force && !session.aiAutoplay) {
    emitAiControl(io, roomId, session);
    return;
  }
  if (session.aiTimer || session.aiBusy) return; // 已在调度 / 正在等待 LLM
  if (!hasAiWork(session.game.state)) {
    session.stall = { sig: '', count: 0 };
    emitAiControl(io, roomId, session);
    return;
  }

  const scheduledAt = Date.now();
  session.aiTimer = setTimeout(async () => {
    const stepStartedAt = Date.now();
    session.aiTimer = null;
    const { game } = session;
    if (!hasAiWork(game.state)) {
      session.stall = { sig: '', count: 0 };
      emitAiControl(io, roomId, session);
      return;
    }

    const startVersion = session.version;

    const tradeDecide: TradeDecideFn = (responderId, board, state, offer, history, agent) => {
      const agentRuntime = session.agents[responderId];
      const providerName = agentRuntime?.providerName ?? session.aiProvider;
      return decideTradeResponse(
        { board, state, responderId, offer, history, counterCandidates: buildCounterCandidates(state, offer), agent },
        providerName,
      );
    };

    const tradeProposeMessage: TradeProposeMessageFn = (initiatorId, planLabel, offer, participants, fallback, agent) => {
      const agentRuntime = session.agents[initiatorId];
      const providerName = agentRuntime?.providerName ?? session.aiProvider;
      return generateProposeMessage({ state: game.state, initiatorId, planLabel, offer, participants, agent }, providerName, fallback);
    };

    const tradeInitiate: TradeInitiateFn = (initiatorId, board, state, sessionsRemaining, agent, feedback) => {
      const agentRuntime = session.agents[initiatorId];
      const providerName = agentRuntime?.providerName ?? session.aiProvider;
      return decideTradeInitiation({ board, state, initiatorId, sessionsRemaining, agent }, providerName, feedback);
    };

    const getAgent = (playerId: number) => agentPromptContextFor(session, playerId, game.state);

    const negotiation = await maybeRunAiNegotiation(
      game.board,
      game.state,
      session.tradeLedger,
      tradeDecide,
      tradeProposeMessage,
      tradeInitiate,
      getAgent,
      (entry) => emitTradeEvent(io, roomId, session, entry), // 实时推送，每条消息生成后立即 emit
    );
    if (negotiation) {
      // events 已在谈判过程中逐条 emit，此处只需处理成交后的状态更新
      if (negotiation.nextState) {
        const prevState = game.state;
        session.game = withStartedAt({ ...game, state: negotiation.nextState });
        session.version++;
        // 关系账本：先记成交（合意建立互信），再记跃迁里的其他敌意信号
        const t = negotiation.acceptedTrade;
        if (t && t.to != null) {
          applyTradeOutcome(session.relationships, prevState, t.from, t.to, t.give, t.receive);
        }
        const negoRelEvents = applyTransition(session.relationships, game.board, prevState, negotiation.nextState);
        broadcastState(io, roomId);
        saveSessionSoon(roomId, session);
        await runSocial(io, roomId, session, negoRelEvents);
      }
      emitAiControl(io, roomId, session);
      if (session.aiAutoplay && !opts.singleStep) scheduleAI(io, roomId);
      return;
    }

    const agent = getDecisionAgent(session, game.state);
    const provider = buildProvider(
      agent?.providerName ?? session.aiProvider,
      game.board,
      game.state,
      session.aiHint,
    );
    let outcome: Awaited<ReturnType<typeof decideAiStep>> | null = null;
    let decisionError: unknown = null;
    session.aiBusy = true;
    emitAiControl(io, roomId, session);
    try {
      outcome = await decideAiStep(
        game.board,
        game.state,
        provider,
        agent ? toAgentPromptContext(agent) : undefined,
        { promptUseHint: session.aiHint },
      );
    } catch (err) {
      decisionError = err;
    } finally {
      session.aiBusy = false;
    }

    // LLM 调用可能很慢；等待期间如果人类动作 / new_game 改了权威状态，
    // 旧决策必须丢弃，避免覆盖新盘面。之前被 busy 挡掉的调度在这里补一次。
    if (session.version !== startVersion || session.game !== game) {
      emitAiControl(io, roomId, session);
      if (session.aiAutoplay) scheduleAI(io, roomId);
      return;
    }

    if (decisionError) {
      // controller 已尽力不抛；这里是极端保护
      console.error('[catan-server] decideAiStep 抛异常:', decisionError);
      session.stall = { sig: '', count: 0 };
      emitAiControl(io, roomId, session);
      return;
    }

    if (!outcome) {
      emitAiControl(io, roomId, session);
      return;
    }

    if (outcome.kind === 'human-turn' || outcome.kind === 'game-over') {
      session.stall = { sig: '', count: 0 };
      emitAiControl(io, roomId, session);
      return;
    }

    // 指纹防卡死：state 没动就累加；多次没动则强制 END_TURN
    const sig = stateFingerprint(game.state);
    if (sig === session.stall.sig) session.stall.count++;
    else session.stall = { sig, count: 0 };

    if (session.stall.count >= STALL_LIMIT) {
      session.stall = { sig: '', count: 0 };
      if (game.state.phase === 'main') applyAction(io, roomId, { type: 'END_TURN' });
      emitAiControl(io, roomId, session);
      if (session.aiAutoplay && !opts.singleStep) scheduleAI(io, roomId);
      return;
    }

    // 应用新状态并广播
    const commitStartedAt = Date.now();
    const prevPhase = game.state.phase;
    const prevState = game.state;
    session.game = withStartedAt({ ...game, state: outcome.nextState });
    session.version++;
    // 关系账本：AI 单步可能移动强盗 / 拿下最长路最大军队 / 跨过逼近胜利线
    const stepRelEvents = applyTransition(session.relationships, game.board, prevState, outcome.nextState);
    broadcastState(io, roomId);
    saveSessionSoon(roomId, session);
    const commitMs = Math.max(0, Date.now() - commitStartedAt);
    // 中途收集的错误（重试 / fallback）先发；成功的 thought 后发
    for (const e of outcome.errors) {
      emitError(io, roomId, session, withScheduleTiming(e, scheduledAt, stepStartedAt, commitMs));
    }
    if (outcome.kind === 'applied') {
      emitThought(
        io,
        roomId,
        session,
        withScheduleTiming(outcome.thought, scheduledAt, stepStartedAt, commitMs),
      );
    }

    // 社交发言（旁路、受开关/预算约束）；在 AI 单线程循环内 await，无并发
    await runSocial(io, roomId, session, stepRelEvents);

    // 开局选点（setup1/setup2）全部完成、刚进入正式回合（roll）时，自动暂停 autoplay：
    // 让观察者先审视各家初始布局，再手动点继续。setup→非 setup 每局只发生一次，故只触发一次。
    const setupJustFinished =
      (prevPhase === 'setup1' || prevPhase === 'setup2') &&
      outcome.nextState.phase !== 'setup1' &&
      outcome.nextState.phase !== 'setup2';
    if (setupJustFinished && session.aiAutoplay) {
      session.aiAutoplay = false;
      saveSessionSoon(roomId, session);
      emitAiControl(io, roomId, session);
      return;
    }

    emitAiControl(io, roomId, session);
    if (session.aiAutoplay && !opts.singleStep) scheduleAI(io, roomId);
  }, opts.force && opts.singleStep ? 0 : AI_TICK_MS);
  emitAiControl(io, roomId, session);
}

function writeJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function parseLimit(raw: string | null, fallback: number): number {
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function recent<T>(items: T[], limit: number): T[] {
  return items.slice(Math.max(0, items.length - limit));
}

function sessionSummary(roomId: string, session: Session) {
  const { state, startedAt } = session.game;
  return {
    roomId,
    gameId: state.gameId,
    startedAt,
    turn: state.turn,
    phase: state.phase,
    current: state.current,
    provider: getDecisionAgent(session)?.providerName ?? session.aiProvider,
    version: session.version,
  };
}

function handleTraceHttp(req: IncomingMessage, res: ServerResponse): boolean {
  if (!req.url || req.method !== 'GET') return false;
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/health') {
    writeJson(res, 200, {
      ok: true,
      sessions: sessions.size,
      provider: AI_PROVIDER,
      playerMode: PLAYER_MODE,
      persist: persistEnabled(),
    });
    return true;
  }

  if (!traceHttpEnabled()) return false;

  if (url.pathname === '/api/sessions') {
    writeJson(
      res,
      200,
      [...sessions.entries()].map(([roomId, session]) => sessionSummary(roomId, session)),
    );
    return true;
  }

  const match = /^\/api\/traces\/(ai|trade|social)$/.exec(url.pathname);
  if (!match) return false;

  const roomId = url.searchParams.get('room') ?? DEFAULT_ROOM;
  const session = sessions.get(roomId);
  if (!session) {
    writeJson(res, 404, { ok: false, error: `unknown room: ${roomId}` });
    return true;
  }

  const kind = match[1];
  if (kind === 'ai') {
    writeJson(res, 200, recent(session.aiEvents, parseLimit(url.searchParams.get('limit'), session.aiEvents.length)));
    return true;
  }
  if (kind === 'trade') {
    writeJson(
      res,
      200,
      recent(session.tradeEvents, parseLimit(url.searchParams.get('limit'), session.tradeEvents.length)),
    );
    return true;
  }
  writeJson(
    res,
    200,
    recent(session.socialEvents, parseLimit(url.searchParams.get('limit'), session.socialEvents.length)),
  );
  return true;
}

const httpServer = createServer((req, res) => {
  if (handleTraceHttp(req, res)) return;
  res.writeHead(404);
  res.end();
});

const io = new Server(httpServer, {
  cors: { origin: '*' }, // MVP：允许任意来源；生产应收紧
  path: '/socket.io/',
});

io.on('connection', (socket: Socket) => {
  socket.join(DEFAULT_ROOM);

  const session = getSession(DEFAULT_ROOM);
  // 新连接：先下发当前盘面，再补拉最近的 AI 事件（顺序保持时间序）
  socket.emit('sync_state', session.game);
  socket.emit('ai_control_state', getAiControlState(session));
  for (const entry of session.aiEvents) {
    socket.emit(entry.kind === 'thought' ? 'ai_thought' : 'ai_error', entry.data);
  }
  for (const entry of session.tradeEvents) {
    socket.emit(
      entry.kind === 'started'
        ? 'trade_chat_started'
        : entry.kind === 'message'
          ? 'trade_chat_message'
          : 'trade_chat_closed',
      entry.data,
    );
  }
  for (const ev of session.socialEvents) {
    socket.emit('social_chat', ev);
  }
  socket.emit('relationship_state', relationshipSnapshotEvent(session));
  socket.emit(
    'human_trade_state',
    humanTradeStateEvent(session.game.board, session.game.state, session.humanTrade),
  );

  // 玩家动作：直接喂给 reducer
  // TODO（待身份层）：现阶段任何 socket 都能 dispatch 任意 action；
  // reducer 会按 state.current 归因，所以非当前玩家的动作不会"代签"，
  // 但可能干扰当前玩家的决策面。后期加 player binding。
  socket.on('dispatch', (action: Action) => {
    const s = getSession(DEFAULT_ROOM);
    applyAction(io, DEFAULT_ROOM, action);
    closeHumanTradeIfStale(io, DEFAULT_ROOM, s);
    scheduleAI(io, DEFAULT_ROOM);
  });

  // 人→AI 交易：服务端跑 aiAcceptsTrade，接受则 TRADE_EXECUTE
  socket.on(
    'propose_human_trade',
    (
      payload: { target: number; give: ResMap; receive: ResMap },
      ack?: (r: { accepted: boolean }) => void,
    ) => {
      const s = getSession(DEFAULT_ROOM);
      const { state } = s.game;
      if (state.phase !== 'main') {
        ack?.({ accepted: false });
        return;
      }
      const from = state.current;
      const accepted = aiAcceptsTrade(state, payload.target, payload.give, payload.receive);
      if (accepted) {
        applyTradeOutcome(s.relationships, state, from, payload.target, payload.give, payload.receive);
        applyAction(io, DEFAULT_ROOM, {
          type: 'TRADE_EXECUTE',
          from,
          to: payload.target,
          give: payload.give,
          receive: payload.receive,
        });
      }
      ack?.({ accepted });
      emitAiControl(io, DEFAULT_ROOM);
    },
  );

  socket.on(
    'set_ai_autoplay',
    (payload: { autoplay: boolean }, ack?: (r: { ok: boolean }) => void) => {
      const s = getSession(DEFAULT_ROOM);
      s.aiAutoplay = Boolean(payload.autoplay);
      if (!s.aiAutoplay && s.aiTimer) {
        clearTimeout(s.aiTimer);
        s.aiTimer = null;
      }
      // 如果 LLM 正在思考，暂停应让返回结果失效，而不是继续应用到棋局。
      if (!s.aiAutoplay && s.aiBusy) s.version++;
      emitAiControl(io, DEFAULT_ROOM, s);
      saveSessionSoon(DEFAULT_ROOM, s);
      if (s.aiAutoplay) scheduleAI(io, DEFAULT_ROOM);
      ack?.({ ok: true });
    },
  );

  socket.on(
    'set_ai_hint',
    (payload: { hint: boolean }, ack?: (r: { ok: boolean }) => void) => {
      const s = getSession(DEFAULT_ROOM);
      s.aiHint = Boolean(payload.hint);
      // 仅影响后续 LLM 决策；正在进行的 LLM 调用结果不作废（hint 不改变状态合法性）
      emitAiControl(io, DEFAULT_ROOM, s);
      saveSessionSoon(DEFAULT_ROOM, s);
      ack?.({ ok: true });
    },
  );

  // 自由社交聊天开关：默认关。关闭即实时刹车——maybeRunSocialChat 的 isEnabled() 回调
  // 每条发言前后都查 session.socialChatEnabled，生成中途被关则丢弃结果、不再 emit。
  socket.on(
    'set_social_chat',
    (payload: { enabled: boolean }, ack?: (r: { ok: boolean }) => void) => {
      const s = getSession(DEFAULT_ROOM);
      s.socialChatEnabled = Boolean(payload.enabled);
      emitAiControl(io, DEFAULT_ROOM, s);
      saveSessionSoon(DEFAULT_ROOM, s);
      ack?.({ ok: true });
    },
  );

  socket.on(
    'set_ai_provider',
    (
      payload: { player?: number; provider: string },
      ack?: (r: { ok: boolean }) => void,
    ) => {
      const s = getSession(DEFAULT_ROOM);
      if (payload.provider === 'human') {
        if (typeof payload.player !== 'number') {
          ack?.({ ok: false });
          return;
        }
        const player = s.game.state.players[payload.player];
        if (!player) {
          ack?.({ ok: false });
          return;
        }
        player.isAI = false;
        if (s.aiTimer && s.game.state.current === payload.player) {
          clearTimeout(s.aiTimer);
          s.aiTimer = null;
        }
        // 席位归属是权威状态的一部分；递增版本也会作废飞行中的旧 AI 决策。
        s.version++;
        broadcastState(io, DEFAULT_ROOM);
        emitAiControl(io, DEFAULT_ROOM, s);
        saveSessionSoon(DEFAULT_ROOM, s);
        scheduleAI(io, DEFAULT_ROOM);
        ack?.({ ok: true });
        return;
      }

      const next = normalizeProviderName(payload.provider);
      if (typeof payload.player === 'number') {
        const player = s.game.state.players[payload.player];
        if (!player) {
          ack?.({ ok: false });
          return;
        }
        const wasAI = player.isAI;
        player.isAI = true;
        if (!s.agents[payload.player]) {
          const created = createAgentRuntimes(s.game.state, next)[payload.player];
          if (created) s.agents[payload.player] = created;
        }
        const agent = s.agents[payload.player];
        if (!agent) {
          ack?.({ ok: false });
          return;
        }
        agent.providerName = next;
        // 仅当被切换的是当前正在思考的玩家时，作废飞行中的 LLM 决策；
        // 从真人切回 AI 还要同步权威状态。
        if (s.aiBusy && s.game.state.current === payload.player) s.version++;
        if (!wasAI) {
          if (s.humanTrade?.initiator === payload.player) {
            closeHumanTrade(io, DEFAULT_ROOM, 'rejected', '真人席位已切回 AI');
          }
          s.version++;
          broadcastState(io, DEFAULT_ROOM);
        }
      } else {
        s.aiProvider = next;
        for (const agent of Object.values(s.agents)) {
          agent.providerName = next;
        }
        if (s.aiBusy) s.version++;
      }
      emitAiControl(io, DEFAULT_ROOM, s);
      saveSessionSoon(DEFAULT_ROOM, s);
      scheduleAI(io, DEFAULT_ROOM);
      ack?.({ ok: true });
    },
  );

  socket.on(
    'human_trade_start',
    (
      payload: { give?: ResMap; receive?: ResMap; message?: string; participants?: number[] } = {},
      ack?: (r: { ok: boolean; reason?: string }) => void,
    ) => {
      const s = getSession(DEFAULT_ROOM);
      const { state } = s.game;
      const initiator = state.current;
      if (state.phase !== 'main' || state.players[initiator]?.isAI !== false) {
        ack?.({ ok: false, reason: '只有真人自己的主阶段可以发起谈判' });
        return;
      }

      const give = normalizeResMap(payload.give);
      const receive = normalizeResMap(payload.receive);
      const message = (payload.message ?? '').trim();
      const hasOffer = resTotal(give) + resTotal(receive) > 0;
      if (!hasOffer && !message) {
        ack?.({ ok: false, reason: '请填写喊话或设置一笔报价' });
        return;
      }
      if (hasOffer) {
        const reason = validateHumanOffer(state, initiator, give, receive);
        if (reason) {
          ack?.({ ok: false, reason });
          return;
        }
      }

      const requested = Array.isArray(payload.participants) ? payload.participants : [];
      const participants = [
        ...new Set(
          (requested.length > 0 ? requested : state.players.map((p) => p.id)).filter(
            (player) => player !== initiator && state.players[player]?.isAI,
          ),
        ),
      ];
      if (participants.length === 0) {
        ack?.({ ok: false, reason: '当前没有可参与谈判的 AI 席位' });
        return;
      }

      if (s.humanTrade?.status === 'open') {
        closeHumanTrade(io, DEFAULT_ROOM, 'rejected', '真人开始了新的谈判');
      }

      s.humanTradeSeq++;
      const currentOffer: TradeOfferEvent | null = hasOffer
        ? { from: initiator, to: null, give, receive }
        : null;
      const trade: HumanTradeSession = {
        sessionId: `human-trade-t${state.turn}-p${initiator}-${s.humanTradeSeq}`,
        turn: state.turn,
        initiator,
        participants,
        currentOffer,
        messages: [],
        stances: {},
        humanMessages: 1,
        status: 'open',
        busy: false,
      };
      s.humanTrade = trade;

      emitTradeEvent(io, DEFAULT_ROOM, s, {
        kind: 'started',
        data: {
          sessionId: trade.sessionId,
          turn: trade.turn,
          phase: state.phase,
          initiator,
          participants,
          proposedTrade: currentOffer
            ? cloneOffer(currentOffer)
            : { from: initiator, to: null, give: emptyRes(), receive: emptyRes() },
          limits: humanLimits(trade),
          ts: Date.now(),
        },
      });
      pushHumanTradeMessage(
        io,
        DEFAULT_ROOM,
        trade,
        initiator,
        'PROPOSE',
        message || '我想谈一笔资源交换。',
        currentOffer ?? undefined,
      );
      emitHumanTradeState(io, DEFAULT_ROOM, s);
      ack?.({ ok: true });
      runHumanTradeRoundWithBusy(io, DEFAULT_ROOM, trade);
    },
  );

  socket.on(
    'human_trade_say',
    (
      payload: { message?: string; give?: ResMap; receive?: ResMap } = {},
      ack?: (r: { ok: boolean; reason?: string }) => void,
    ) => {
      const s = getSession(DEFAULT_ROOM);
      const trade = s.humanTrade;
      const { state } = s.game;
      if (!trade || trade.status !== 'open') {
        ack?.({ ok: false, reason: '当前没有进行中的真人谈判' });
        return;
      }
      if (state.phase !== 'main' || state.current !== trade.initiator) {
        ack?.({ ok: false, reason: '当前局面已不能继续这轮谈判' });
        return;
      }
      if (trade.busy) {
        ack?.({ ok: false, reason: 'AI 正在回应上一轮喊话' });
        return;
      }
      if (trade.humanMessages >= HUMAN_TRADE_LIMITS.messagesPerSession) {
        ack?.({ ok: false, reason: '本轮谈判发言次数已用完' });
        return;
      }

      const message = (payload.message ?? '').trim();
      const hasNewOffer =
        Object.prototype.hasOwnProperty.call(payload, 'give') ||
        Object.prototype.hasOwnProperty.call(payload, 'receive');
      let msgOffer: TradeOfferEvent | undefined;
      if (hasNewOffer) {
        const give = normalizeResMap(payload.give);
        const receive = normalizeResMap(payload.receive);
        const reason = validateHumanOffer(state, trade.initiator, give, receive);
        if (reason) {
          ack?.({ ok: false, reason });
          return;
        }
        trade.currentOffer = { from: trade.initiator, to: null, give, receive };
        trade.stances = {};
        msgOffer = cloneOffer(trade.currentOffer);
      }
      if (!message && !hasNewOffer) {
        ack?.({ ok: false, reason: '请输入喊话或调整报价' });
        return;
      }

      trade.humanMessages++;
      pushHumanTradeMessage(
        io,
        DEFAULT_ROOM,
        trade,
        trade.initiator,
        'PROPOSE',
        message || '我调整一下报价。',
        msgOffer,
      );
      emitHumanTradeState(io, DEFAULT_ROOM, s);
      ack?.({ ok: true });
      runHumanTradeRoundWithBusy(io, DEFAULT_ROOM, trade);
    },
  );

  socket.on(
    'human_trade_finalize',
    (payload: { player?: number } = {}, ack?: (r: { ok: boolean; reason?: string }) => void) => {
      const s = getSession(DEFAULT_ROOM);
      const trade = s.humanTrade;
      if (!trade || trade.status !== 'open') {
        ack?.({ ok: false, reason: '当前没有可成交的真人谈判' });
        return;
      }
      if (trade.busy) {
        ack?.({ ok: false, reason: 'AI 正在回应，稍后再成交' });
        return;
      }
      const deal = deriveStandingDeals(s.game.board, s.game.state, trade).find(
        (d) => d.player === payload.player,
      );
      if (!deal) {
        ack?.({ ok: false, reason: '这名 AI 当前没有可执行的成交候选' });
        return;
      }
      const finalTrade: TradeOfferEvent = {
        from: trade.initiator,
        to: deal.player,
        give: cloneRes(deal.give),
        receive: cloneRes(deal.receive),
      };
      applyTradeOutcome(
        s.relationships,
        s.game.state,
        finalTrade.from,
        deal.player,
        finalTrade.give,
        finalTrade.receive,
      );
      applyAction(io, DEFAULT_ROOM, {
        type: 'TRADE_EXECUTE',
        from: finalTrade.from,
        to: deal.player,
        give: finalTrade.give,
        receive: finalTrade.receive,
      });
      closeHumanTrade(io, DEFAULT_ROOM, 'accepted', deal.note, finalTrade);
      emitAiControl(io, DEFAULT_ROOM);
      ack?.({ ok: true });
    },
  );

  socket.on('human_trade_end', (ack?: (r: { ok: boolean }) => void) => {
    closeHumanTrade(io, DEFAULT_ROOM, 'rejected', '真人结束谈判');
    ack?.({ ok: true });
  });

  socket.on('step_ai', (ack?: (r: { ok: boolean; reason?: string }) => void) => {
    const s = getSession(DEFAULT_ROOM);
    if (s.aiBusy || s.aiTimer) {
      ack?.({ ok: false, reason: 'AI 正在思考或已有调度' });
      emitAiControl(io, DEFAULT_ROOM, s);
      return;
    }
    if (!hasAiWork(s.game.state)) {
      ack?.({ ok: false, reason: '当前没有可推进的 AI 动作' });
      emitAiControl(io, DEFAULT_ROOM, s);
      return;
    }
    scheduleAI(io, DEFAULT_ROOM, { force: true, singleStep: true });
    ack?.({ ok: true });
  });

  // 重开新局：清状态、清 AI 事件 buffer、重启 AI 循环
  socket.on('new_game', () => {
    const s = getSession(DEFAULT_ROOM);
    if (s.aiTimer) {
      clearTimeout(s.aiTimer);
      s.aiTimer = null;
    }
    // 记住重开前各玩家单独选的 provider，重建 agents 后还原
    const savedProviders: Record<number, string> = {};
    for (const [id, agent] of Object.entries(s.agents)) {
      savedProviders[Number(id)] = agent.providerName;
    }
    const savedHumanSeats = s.game.state.players.filter((p) => !p.isAI).map((p) => p.id);
    s.game = createServerGame();
    for (const id of savedHumanSeats) {
      if (s.game.state.players[id]) s.game.state.players[id].isAI = false;
    }
    s.version++;
    s.stall = { sig: '', count: 0 };
    s.agents = createAgentRuntimes(s.game.state, s.aiProvider);
    for (const [id, agent] of Object.entries(s.agents)) {
      const saved = savedProviders[Number(id)];
      if (saved) agent.providerName = saved;
    }
    s.tradeLedger = createAiTradeLedger();
    s.relationships = createRelationshipLedger(s.game.state);
    s.socialBudget = createSocialBudget(); // 新局清空社交预算（开关沿用观察者设置）
    s.socialEvents = [];
    s.aiEvents = [];
    s.tradeEvents = [];
    s.humanTrade = null;
    s.humanTradeSeq = 0;
    broadcastState(io, DEFAULT_ROOM);
    emitHumanTradeState(io, DEFAULT_ROOM, s);
    emitAiControl(io, DEFAULT_ROOM, s);
    saveSessionSoon(DEFAULT_ROOM, s, true);
    scheduleAI(io, DEFAULT_ROOM);
  });
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[catan-server] 收到 ${signal}，保存快照后退出...`);
  const forceExit = setTimeout(() => process.exit(1), 5000);
  try {
    await flushAllSnapshots();
    httpServer.close(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
  } catch (err) {
    console.warn('[catan-server] 退出前保存快照失败:', err);
    clearTimeout(forceExit);
    process.exit(1);
  }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

httpServer.listen(PORT, () => {
  console.log(
    `[catan-server] 已启动 :${PORT}（AI tick=${AI_TICK_MS}ms, provider=${AI_PROVIDER}, players=${PLAYER_MODE}）`,
  );
  // 启动时若初始就是 AI 回合（setup1 第一个 AI），主动起 AI 循环
  scheduleAI(io, DEFAULT_ROOM);
});
