// ============================================================
// 卡坦岛后端：socket.io WebSocket 服务
// ------------------------------------------------------------
// 职责：
//   1. 持有"上帝视角"游戏状态（单房间 MVP，Map 结构铺多房间路）
//   2. 接收客户端 dispatch(Action)，跑 reducer，广播新状态
//   3. AI 驱动循环（事件驱动 + 状态指纹防卡死）
//   4. 人→AI 交易的服务端自动应答（搬自原 App.tsx 同步逻辑）
//
// 不在本轮做：玩家身份认证、多房间匹配、断线续盘、持久化、LLM AI。
// ============================================================

import { createServer } from 'http';
import { Server, type Socket } from 'socket.io';

import { createGame } from '../shared/state';
import { reduce, type Action } from '../shared/reducer';
import { aiAcceptsTrade, aiNextAction } from '../shared/ai';
import { RESOURCES, type FullGame, type GameState, type ResMap } from '../shared/types';

const PORT = Number(process.env.PORT ?? 3001);
const AI_TICK_MS = Number(process.env.AI_TICK_MS ?? 460); // 与原 App.tsx 节奏一致
const STALL_LIMIT = 8; // 与原 App.tsx 一致
const DEFAULT_ROOM = 'default'; // MVP：单房间

interface Session {
  game: FullGame;
  stall: { sig: string; count: number };
  aiTimer: NodeJS.Timeout | null;
}

const sessions = new Map<string, Session>();

function getSession(roomId: string): Session {
  let s = sessions.get(roomId);
  if (!s) {
    s = { game: createGame(), stall: { sig: '', count: 0 }, aiTimer: null };
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

// 事件驱动的 AI 驱动循环：每次 dispatch 后调用；非 AI 回合 / gameOver 自然停。
function scheduleAI(io: Server, roomId: string) {
  const session = getSession(roomId);
  if (session.aiTimer) return; // 已在调度
  if (session.game.state.phase === 'gameOver') return;

  session.aiTimer = setTimeout(() => {
    session.aiTimer = null;
    const { game } = session;
    if (game.state.phase === 'gameOver') return;

    const next = aiNextAction(game.board, game.state);
    if (!next) {
      // 轮到人类（含 discard 阶段等待 / pendingTrade 待人类应答）
      session.stall = { sig: '', count: 0 };
      return;
    }

    const sig = stateFingerprint(game.state);
    if (sig === session.stall.sig) session.stall.count++;
    else session.stall = { sig, count: 0 };

    if (session.stall.count >= STALL_LIMIT) {
      // 连续 STALL_LIMIT 次同状态：强制结束当前回合，避免冻结
      session.stall = { sig: '', count: 0 };
      if (game.state.phase === 'main') {
        applyAction(io, roomId, { type: 'END_TURN' });
      }
      scheduleAI(io, roomId);
      return;
    }

    applyAction(io, roomId, next);
    scheduleAI(io, roomId);
  }, AI_TICK_MS);
}

const httpServer = createServer((req, res) => {
  // 简单健康检查端点，方便 docker HEALTHCHECK
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
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

  // 新连接立刻下发当前盘面
  socket.emit('sync_state', getSession(DEFAULT_ROOM).game);

  // 玩家动作：直接喂给 reducer
  // TODO（待身份层）：现阶段任何 socket 都能 dispatch 任意 action；
  // reducer 会按 state.current 归因，所以非当前玩家的动作不会"代签"，
  // 但可能干扰当前玩家的决策面。后期加 player binding。
  socket.on('dispatch', (action: Action) => {
    applyAction(io, DEFAULT_ROOM, action);
    scheduleAI(io, DEFAULT_ROOM);
  });

  // 人→AI 交易：服务端跑 aiAcceptsTrade，接受则 TRADE_EXECUTE
  // 用 socket.io 的 ack 回调把结果返给提议方做 toast
  socket.on(
    'propose_human_trade',
    (
      payload: { target: number; give: ResMap; receive: ResMap },
      ack?: (r: { accepted: boolean }) => void,
    ) => {
      const session = getSession(DEFAULT_ROOM);
      const { state } = session.game;
      // 仅在主回合且当前玩家是人类时受理
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

  // 重开新局
  socket.on('new_game', () => {
    const session = getSession(DEFAULT_ROOM);
    if (session.aiTimer) {
      clearTimeout(session.aiTimer);
      session.aiTimer = null;
    }
    session.game = createGame();
    session.stall = { sig: '', count: 0 };
    broadcastState(io, DEFAULT_ROOM);
    scheduleAI(io, DEFAULT_ROOM);
  });
});

httpServer.listen(PORT, () => {
  console.log(`[catan-server] 已启动 :${PORT}（AI tick=${AI_TICK_MS}ms）`);
  // 启动时若初始就是 AI 回合（setup1 第一个 AI），主动起 AI 循环
  scheduleAI(io, DEFAULT_ROOM);
});
