// ============================================================
// 卡坦岛后端：socket.io WebSocket 服务
// ------------------------------------------------------------
// 职责：
//   1. 持有"上帝视角"游戏状态（单房间 MVP，Map 结构铺多房间路）
//   2. 接收客户端 dispatch(Action)，跑 reducer，广播新状态
//   3. AI 驱动循环：通过 AiDecisionProvider 抽象，rule/mock/llm 可切换
//      事件驱动 + 状态指纹防卡死 + Maker-Checker 三层校验
//   4. 人→AI 交易的服务端自动应答（搬自原 App.tsx 同步逻辑）
//   5. 广播 ai_thought / ai_error 供前端做决策可视化
//
// 不在本轮做：玩家身份认证、多房间匹配、断线续盘、持久化、真实 LLM 接入。
// ============================================================

import { createServer } from 'http';
import { Server, type Socket } from 'socket.io';

import { createGame } from '../shared/state';
import { reduce, type Action } from '../shared/reducer';
import { aiAcceptsTrade } from '../shared/ai';
import { RESOURCES, type FullGame, type GameState, type ResMap } from '../shared/types';

import type { AiDecisionProvider, AiErrorEvent, AiThoughtEvent } from './llm/types';
import { createRuleProvider } from './llm/ruleProvider';
import { createMockProvider } from './llm/mockProvider';
import { createLlmProvider } from './llm/llmProvider';
import { decideAiStep } from './llm/controller';

const PORT = Number(process.env.PORT ?? 3001);
const AI_TICK_MS = Number(process.env.AI_TICK_MS ?? 460); // 每步 AI 之间的节奏
const STALL_LIMIT = 8; // 状态指纹连续重复阈值
const AI_EVENT_BUFFER = 60; // 每房间缓存最近 N 条 AI 事件，用于断线后补拉
const DEFAULT_ROOM = 'default'; // MVP：单房间
const AI_PROVIDER = (process.env.AI_PROVIDER ?? 'llm').toLowerCase(); // rule | mock | llm

interface AiEventLogEntry {
  kind: 'thought' | 'error';
  data: AiThoughtEvent | AiErrorEvent;
}

interface Session {
  game: FullGame;
  stall: { sig: string; count: number };
  aiTimer: NodeJS.Timeout | null;
  /** 环形 buffer：最近的 AI 决策事件，便于晚来的客户端补齐上下文 */
  aiEvents: AiEventLogEntry[];
}

const sessions = new Map<string, Session>();

function getSession(roomId: string): Session {
  let s = sessions.get(roomId);
  if (!s) {
    s = {
      game: createGame(),
      stall: { sig: '', count: 0 },
      aiTimer: null,
      aiEvents: [],
    };
    sessions.set(roomId, s);
  }
  return s;
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

function applyAction(io: Server, roomId: string, action: Action) {
  const session = getSession(roomId);
  session.game = {
    board: session.game.board,
    state: reduce(session.game.board, session.game.state, action),
  };
  broadcastState(io, roomId);
}

function pushAiEvent(session: Session, entry: AiEventLogEntry) {
  session.aiEvents.push(entry);
  if (session.aiEvents.length > AI_EVENT_BUFFER) {
    session.aiEvents.splice(0, session.aiEvents.length - AI_EVENT_BUFFER);
  }
}

function emitThought(io: Server, roomId: string, session: Session, ev: AiThoughtEvent) {
  pushAiEvent(session, { kind: 'thought', data: ev });
  io.to(roomId).emit('ai_thought', ev);
}

function emitError(io: Server, roomId: string, session: Session, ev: AiErrorEvent) {
  pushAiEvent(session, { kind: 'error', data: ev });
  io.to(roomId).emit('ai_error', ev);
}

function buildProvider(name: string, board: FullGame['board'], state: GameState): AiDecisionProvider {
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
      return createLlmProvider({ apiKey });
    }
    default:
      console.warn(`[catan-server] 未知 AI_PROVIDER="${name}"，回退到 rule`);
      return createRuleProvider(board, state);
  }
}

// 事件驱动的 AI 驱动循环：每次 dispatch 后调用；非 AI 回合 / gameOver 自然停。
function scheduleAI(io: Server, roomId: string) {
  const session = getSession(roomId);
  if (session.aiTimer) return; // 已在调度
  if (session.game.state.phase === 'gameOver') return;

  session.aiTimer = setTimeout(async () => {
    session.aiTimer = null;
    const { game } = session;
    if (game.state.phase === 'gameOver') return;

    const provider = buildProvider(AI_PROVIDER, game.board, game.state);
    let outcome;
    try {
      outcome = await decideAiStep(game.board, game.state, provider);
    } catch (err) {
      // controller 已尽力不抛；这里是极端保护
      console.error('[catan-server] decideAiStep 抛异常:', err);
      session.stall = { sig: '', count: 0 };
      return;
    }

    if (outcome.kind === 'human-turn' || outcome.kind === 'game-over') {
      session.stall = { sig: '', count: 0 };
      return;
    }

    // 指纹防卡死：state 没动就累加；多次没动则强制 END_TURN
    const sig = stateFingerprint(game.state);
    if (sig === session.stall.sig) session.stall.count++;
    else session.stall = { sig, count: 0 };

    if (session.stall.count >= STALL_LIMIT) {
      session.stall = { sig: '', count: 0 };
      if (game.state.phase === 'main') applyAction(io, roomId, { type: 'END_TURN' });
      scheduleAI(io, roomId);
      return;
    }

    // 应用新状态并广播
    session.game = { board: game.board, state: outcome.nextState };
    broadcastState(io, roomId);
    // 中途收集的错误（重试 / fallback）先发；成功的 thought 后发
    for (const e of outcome.errors) emitError(io, roomId, session, e);
    if (outcome.kind === 'applied') emitThought(io, roomId, session, outcome.thought);

    scheduleAI(io, roomId);
  }, AI_TICK_MS);
}

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        sessions: sessions.size,
        provider: AI_PROVIDER,
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
  for (const entry of session.aiEvents) {
    socket.emit(entry.kind === 'thought' ? 'ai_thought' : 'ai_error', entry.data);
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
    },
  );

  // 重开新局：清状态、清 AI 事件 buffer、重启 AI 循环
  socket.on('new_game', () => {
    const s = getSession(DEFAULT_ROOM);
    if (s.aiTimer) {
      clearTimeout(s.aiTimer);
      s.aiTimer = null;
    }
    s.game = createGame();
    s.stall = { sig: '', count: 0 };
    s.aiEvents = [];
    broadcastState(io, DEFAULT_ROOM);
    scheduleAI(io, DEFAULT_ROOM);
  });
});

httpServer.listen(PORT, () => {
  console.log(
    `[catan-server] 已启动 :${PORT}（AI tick=${AI_TICK_MS}ms, provider=${AI_PROVIDER}）`,
  );
  // 启动时若初始就是 AI 回合（setup1 第一个 AI），主动起 AI 循环
  scheduleAI(io, DEFAULT_ROOM);
});
