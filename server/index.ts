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
//
// 不在本轮做：玩家身份认证、多房间匹配、断线续盘、持久化、人类加入谈判室。
// ============================================================

import { createServer } from 'http';
import { Server, type Socket } from 'socket.io';

import { createGame } from '../shared/state';
import { reduce, type Action } from '../shared/reducer';
import { aiAcceptsTrade } from '../shared/ai';
import { RESOURCES, type FullGame, type GameState, type ResMap } from '../shared/types';
import type {
  AiControlState,
  TradeChatClosedEvent,
  TradeChatMessageEvent,
  TradeChatStartedEvent,
} from '../shared/protocol';

import type { AiDecisionProvider, AiErrorEvent, AiThoughtEvent, AiTimingEvent } from './llm/types';
import { createRuleProvider } from './llm/ruleProvider';
import { createMockProvider } from './llm/mockProvider';
import { createLlmProvider } from './llm/llmProvider';
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
} from './trading/negotiationManager';

const PORT = Number(process.env.PORT ?? 3001);
const AI_TICK_MS = Number(process.env.AI_TICK_MS ?? 460); // 每步 AI 之间的节奏
const STALL_LIMIT = 8; // 状态指纹连续重复阈值
const AI_EVENT_BUFFER = 60; // 每房间缓存最近 N 条 AI 事件，用于断线后补拉
const TRADE_EVENT_BUFFER = 80; // 每房间缓存最近 N 条交易谈判事件
const DEFAULT_ROOM = 'default'; // MVP：单房间
const AI_PROVIDER = (process.env.AI_PROVIDER ?? 'llm').toLowerCase(); // rule | mock | llm
const DEFAULT_AI_AUTOPLAY = process.env.AI_AUTOPLAY === '1'; // 默认手动，便于观察 AI 单步决策
const DEFAULT_AI_HINT = process.env.LLM_HINT !== '0'; // LLM prompt 默认带空间动作 hint；=0 关闭
const PLAYER_MODE = (process.env.PLAYER_MODE ?? 'all-ai').toLowerCase(); // all-ai | human0

interface AiEventLogEntry {
  kind: 'thought' | 'error';
  data: AiThoughtEvent | AiErrorEvent;
}

interface TradeEventLogEntry {
  kind: 'started' | 'message' | 'closed';
  data: TradeChatStartedEvent | TradeChatMessageEvent | TradeChatClosedEvent;
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
  /** 环形 buffer：最近的 AI 决策事件，便于晚来的客户端补齐上下文 */
  aiEvents: AiEventLogEntry[];
  /** 环形 buffer：最近的交易谈判事件，便于晚来的客户端补齐上下文 */
  tradeEvents: TradeEventLogEntry[];
}

const sessions = new Map<string, Session>();

function getSession(roomId: string): Session {
  let s = sessions.get(roomId);
  if (!s) {
    const game = createServerGame();
    s = {
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
      aiEvents: [],
      tradeEvents: [],
    };
    sessions.set(roomId, s);
  }
  return s;
}

function createServerGame(): FullGame {
  const game = createGame();
  if (PLAYER_MODE !== 'human0') {
    for (const p of game.state.players) {
      p.isAI = true;
      if (p.id === 0) p.name = '红';
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
    provider: currentAgent?.providerName ?? session.aiProvider,
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
  session.game = {
    board: session.game.board,
    state: reduce(session.game.board, session.game.state, action),
  };
  session.version++;
  broadcastState(io, roomId);
}

function pushAiEvent(session: Session, entry: AiEventLogEntry) {
  session.aiEvents.push(entry);
  if (session.aiEvents.length > AI_EVENT_BUFFER) {
    session.aiEvents.splice(0, session.aiEvents.length - AI_EVENT_BUFFER);
  }
}

function pushTradeEvent(session: Session, entry: TradeEventLogEntry) {
  session.tradeEvents.push(entry);
  if (session.tradeEvents.length > TRADE_EVENT_BUFFER) {
    session.tradeEvents.splice(0, session.tradeEvents.length - TRADE_EVENT_BUFFER);
  }
}

function emitThought(io: Server, roomId: string, session: Session, ev: AiThoughtEvent) {
  rememberThought(session, ev);
  pushAiEvent(session, { kind: 'thought', data: ev });
  io.to(roomId).emit('ai_thought', ev);
}

function emitError(io: Server, roomId: string, session: Session, ev: AiErrorEvent) {
  pushAiEvent(session, { kind: 'error', data: ev });
  io.to(roomId).emit('ai_error', ev);
}

function emitTradeEvent(io: Server, roomId: string, session: Session, entry: TradeEventEntry) {
  pushTradeEvent(session, entry);
  const eventName =
    entry.kind === 'started'
      ? 'trade_chat_started'
      : entry.kind === 'message'
        ? 'trade_chat_message'
        : 'trade_chat_closed';
  io.to(roomId).emit(eventName, entry.data);
}

function emitTradeEvents(io: Server, roomId: string, session: Session, events: TradeEventEntry[]) {
  for (const entry of events) emitTradeEvent(io, roomId, session, entry);
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
  switch (name) {
    case 'mock':
      return createMockProvider();
    case 'rule':
      return createRuleProvider(board, state);
    case 'llm': {
      const apiKey = process.env.MINIMAX_API_KEY;
      if (!apiKey) {
        console.warn(
          '[catan-server] AI_PROVIDER=llm 但缺 MINIMAX_API_KEY，本次回退到 rule（请在 .env 里填上）',
        );
        return createRuleProvider(board, state);
      }
      return createLlmProvider({ apiKey, useHint });
    }
    default:
      console.warn(`[catan-server] 未知 AI_PROVIDER="${name}"，回退到 rule`);
      return createRuleProvider(board, state);
  }
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
    const negotiation = maybeRunAiNegotiation(game.board, game.state, session.tradeLedger);
    if (negotiation) {
      emitTradeEvents(io, roomId, session, negotiation.events);
      if (negotiation.nextState) {
        session.game = { board: game.board, state: negotiation.nextState };
        session.version++;
        broadcastState(io, roomId);
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
    session.game = { board: game.board, state: outcome.nextState };
    session.version++;
    broadcastState(io, roomId);
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

    emitAiControl(io, roomId, session);
    if (session.aiAutoplay && !opts.singleStep) scheduleAI(io, roomId);
  }, opts.force && opts.singleStep ? 0 : AI_TICK_MS);
  emitAiControl(io, roomId, session);
}

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        sessions: sessions.size,
        provider: AI_PROVIDER,
        playerMode: PLAYER_MODE,
      }),
    );
    return;
  }
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

  // 玩家动作：直接喂给 reducer
  // TODO（待身份层）：现阶段任何 socket 都能 dispatch 任意 action；
  // reducer 会按 state.current 归因，所以非当前玩家的动作不会"代签"，
  // 但可能干扰当前玩家的决策面。后期加 player binding。
  socket.on('dispatch', (action: Action) => {
    applyAction(io, DEFAULT_ROOM, action);
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
      const next = String(payload.provider ?? '').toLowerCase() === 'llm' ? 'llm' : 'rule';
      if (typeof payload.player === 'number') {
        const agent = s.agents[payload.player];
        if (!agent) {
          ack?.({ ok: false });
          return;
        }
        agent.providerName = next;
        // 仅当被切换的是当前正在思考的玩家时，作废飞行中的 LLM 决策
        if (s.aiBusy && s.game.state.current === payload.player) s.version++;
      } else {
        s.aiProvider = next;
        for (const agent of Object.values(s.agents)) {
          agent.providerName = next;
        }
        if (s.aiBusy) s.version++;
      }
      emitAiControl(io, DEFAULT_ROOM, s);
      ack?.({ ok: true });
    },
  );

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
    s.game = createServerGame();
    s.version++;
    s.stall = { sig: '', count: 0 };
    s.agents = createAgentRuntimes(s.game.state, s.aiProvider);
    s.tradeLedger = createAiTradeLedger();
    s.aiEvents = [];
    s.tradeEvents = [];
    broadcastState(io, DEFAULT_ROOM);
    emitAiControl(io, DEFAULT_ROOM, s);
    scheduleAI(io, DEFAULT_ROOM);
  });
});

httpServer.listen(PORT, () => {
  console.log(
    `[catan-server] 已启动 :${PORT}（AI tick=${AI_TICK_MS}ms, provider=${AI_PROVIDER}, players=${PLAYER_MODE}）`,
  );
  // 启动时若初始就是 AI 回合（setup1 第一个 AI），主动起 AI 循环
  scheduleAI(io, DEFAULT_ROOM);
});
