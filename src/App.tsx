import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { Board, type BoardMode } from './components/Board';
import { playerDisplayName } from '../shared/state';
import { robberCandidates, type Action } from '../shared/reducer';
import type {
  AiControlState,
  AiErrorEvent,
  AiModelContextEvent,
  AiModelOutputEvent,
  AiTimingEvent,
  AiThoughtEvent,
  HumanTradeStateEvent,
  TradeChatClosedEvent,
  TradeChatMessageEvent,
  TradeChatStartedEvent,
  TradeOfferEvent,
} from '../shared/protocol';
import {
  handSize,
  longestRoadLength,
  publicVP,
  totalVP,
  tradeRatio,
} from '../shared/rules';
import {
  COSTS,
  DEV_LABEL,
  RESOURCES,
  RESOURCE_COLOR,
  RESOURCE_LABEL,
  emptyRes,
  type DevCard,
  type FullGame,
  type Resource,
  type ResMap,
} from '../shared/types';

// 服务端地址：构建时由 Vite 注入 VITE_SERVER_URL；为空字符串则同源（生产 nginx 反代场景）
const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? '';

// 模块级单例：避免 React StrictMode 双重 mount 时重复建连
const socket: Socket = io(SERVER_URL, {
  path: '/socket.io/',
  transports: ['websocket', 'polling'],
});

function resTotal(res: ResMap): number {
  return RESOURCES.reduce((sum, r) => sum + res[r], 0);
}

function resSummary(res: ResMap): string {
  return (
    RESOURCES.filter((r) => res[r] > 0)
      .map((r) => `${RESOURCE_LABEL[r]}×${res[r]}`)
      .join(' ') || '无'
  );
}

function clampNumberInput(value: string, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(max, Math.floor(n)));
}

function ResIcon({ r, size = 14 }: { r: Resource; size?: number }) {
  return (
    <span
      className="res-ico"
      style={{ background: RESOURCE_COLOR[r], width: size, height: size }}
      title={RESOURCE_LABEL[r]}
    />
  );
}

const DIE_DOTS: Record<number, [number, number][]> = {
  1: [[1, 1]],
  2: [[0, 0], [2, 2]],
  3: [[0, 0], [1, 1], [2, 2]],
  4: [[0, 0], [2, 0], [0, 2], [2, 2]],
  5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]],
  6: [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]],
};

function Die({ v }: { v: number }) {
  return (
    <svg className="die rolling" viewBox="0 0 46 46" width={46} height={46}>
      {(DIE_DOTS[v] ?? []).map(([gx, gy], i) => (
        <circle key={i} cx={9 + gx * 14} cy={9 + gy * 14} r={4.4} fill="#241d1a" />
      ))}
    </svg>
  );
}

function DiceHud({ dice, turn }: { dice: [number, number] | null; turn: number }) {
  return (
    <div className="dice-hud" aria-label={dice ? `骰子 ${dice[0]} 和 ${dice[1]}` : '尚未掷骰'}>
      <div className="dice">
        {dice ? (
          <>
            <Die key={`d1-${turn}-${dice[0]}-${dice[1]}`} v={dice[0]} />
            <Die key={`d2-${turn}-${dice[0]}-${dice[1]}`} v={dice[1]} />
            <span className="dice-sum">= {dice[0] + dice[1]}</span>
          </>
        ) : (
          <>
            <div className="die die-empty">?</div>
            <div className="die die-empty">?</div>
            <span className="dice-sum">= --</span>
          </>
        )}
      </div>
    </div>
  );
}

const CONFETTI_COLORS = ['#9b3f34', '#526b3b', '#b59645', '#3e668f', '#874638', '#efe3c8'];

function Confetti() {
  return (
    <>
      {Array.from({ length: 70 }).map((_, i) => (
        <div
          key={i}
          className="confetti-piece"
          style={{
            left: `${Math.random() * 100}%`,
            background: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
            animationDuration: `${2.4 + Math.random() * 2.2}s`,
            animationDelay: `${Math.random() * 1.5}s`,
            transform: `rotate(${Math.random() * 360}deg)`,
          }}
        />
      ))}
    </>
  );
}

function Stepper({
  value,
  max,
  onChange,
}: {
  value: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="stepper">
      <button onClick={() => onChange(Math.max(0, value - 1))} disabled={value <= 0}>
        −
      </button>
      <span>{value}</span>
      <button onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max}>
        +
      </button>
    </div>
  );
}

type ThoughtLogItem =
  | { kind: 'thought'; data: AiThoughtEvent }
  | { kind: 'error'; data: AiErrorEvent };
type TradeLogItem =
  | { kind: 'started'; data: TradeChatStartedEvent }
  | { kind: 'message'; data: TradeChatMessageEvent }
  | { kind: 'closed'; data: TradeChatClosedEvent };

type AiBoardFocus = { player: number; action: Action; ts: number };
type SocketAck = { ok: boolean; reason?: string };
type AiStepTimer = {
  running: boolean;
  startedAt: number | null;
  elapsedMs: number;
  lastMs: number | null;
  lastOk: boolean | null;
};
type SidebarEventTab = 'human' | 'thoughts' | 'trades' | 'log';

const THOUGHT_LOG_MAX = 80;
const TRADE_LOG_MAX = 120;
const DEFAULT_AI_CONTROL: AiControlState = {
  autoplay: false,
  queued: false,
  busy: false,
  canStep: false,
  hintEnabled: true,
  provider: 'unknown',
  providerOptions: [],
  agentProviders: {},
  agentPersonalities: {},
};

const EMPTY_HUMAN_TRADE_STATE: HumanTradeStateEvent = { active: false };

const EMPTY_AI_STEP_TIMER: AiStepTimer = {
  running: false,
  startedAt: null,
  elapsedMs: 0,
  lastMs: null,
  lastOk: null,
};

// 左右分隔条：侧栏宽度上下限与持久化
const SIDEBAR_DEFAULT = 372;
const SIDEBAR_MIN = 280;
const SIDEBAR_MAX_RATIO = 0.7;
const SIDEBAR_STORAGE_KEY = 'catan-sidebar-width';

function nowMs(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function readStoredSidebarWidth(): number {
  if (typeof window === 'undefined') return SIDEBAR_DEFAULT;
  const raw = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : SIDEBAR_DEFAULT;
}

function normalizeProviderKey(provider: string | undefined): string {
  const p = (provider ?? '').toLowerCase();
  if (p === 'llm' || p.startsWith('llm(') || p === 'minimax') return 'minimax';
  if (p === 'qwen' || p === 'qwen36' || p.startsWith('qwen(')) return 'qwen36';
  if (p === 'mock') return 'mock';
  if (p === 'rule') return 'rule';
  return p || 'rule';
}

function providerShortLabel(provider: string | undefined): string {
  switch (normalizeProviderKey(provider)) {
    case 'human':
      return '真人';
    case 'minimax':
      return 'mini';
    case 'qwen36':
      return 'qwen';
    case 'mock':
      return 'Mock';
    case 'rule':
      return '规则';
    default:
      return 'AI';
  }
}

function emitAck(event: string, payload?: unknown, timeout = 2500): Promise<SocketAck> {
  return new Promise((resolve) => {
    const done = (err: Error | null, res?: SocketAck) => {
      if (err || !res) resolve({ ok: false, reason: '服务端暂未响应' });
      else resolve(res);
    };
    if (payload === undefined) socket.timeout(timeout).emit(event, done);
    else socket.timeout(timeout).emit(event, payload, done);
  });
}

function humanActionSeat(state: FullGame['state'] | undefined): number | null {
  if (!state) return null;
  if (state.phase === 'discard') {
    const p = state.players.find((pl) => !pl.isAI && state.discardLeft[pl.id] != null);
    if (p) return p.id;
  }
  if (state.pendingTrade) {
    const target = state.players[state.pendingTrade.to];
    if (target && !target.isAI) return target.id;
  }
  const current = state.players[state.current];
  return current && !current.isAI ? current.id : null;
}

function humanAttentionKey(
  state: FullGame['state'] | undefined,
  humanTradeState: HumanTradeStateEvent,
): string {
  if (!state) return '';
  const seat = humanActionSeat(state);
  if (seat != null) {
    const discardLeft = state.discardLeft[seat] ?? 0;
    const pending = state.pendingTrade?.to === seat ? state.pendingTrade.from : '';
    return `${state.gameId}:${state.turn}:${state.phase}:${state.current}:${seat}:${state.setupStep}:${discardLeft}:${pending}`;
  }
  const deals = humanTradeState.standingDeals ?? [];
  if (humanTradeState.active && deals.length > 0) {
    return `${humanTradeState.sessionId}:${deals
      .map((d) => `${d.player}-${d.source}-${resSummary(d.give)}-${resSummary(d.receive)}`)
      .join('|')}`;
  }
  return '';
}

export function App() {
  // 初始 null：等待服务端 sync_state；AI 驱动循环全部在服务端
  const [game, setGame] = useState<FullGame | null>(null);
  const [connected, setConnected] = useState(socket.connected);
  const [mode, setMode] = useState<BoardMode>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [thoughtLog, setThoughtLog] = useState<ThoughtLogItem[]>([]);
  const [tradeLog, setTradeLog] = useState<TradeLogItem[]>([]);
  const [humanTradeState, setHumanTradeState] =
    useState<HumanTradeStateEvent>(EMPTY_HUMAN_TRADE_STATE);
  const [aiFocus, setAiFocus] = useState<AiBoardFocus | null>(null);
  const [aiControl, setAiControl] = useState<AiControlState>(DEFAULT_AI_CONTROL);
  const [aiStepTimer, setAiStepTimer] = useState<AiStepTimer>(EMPTY_AI_STEP_TIMER);
  const [aiAutoTimer, setAiAutoTimer] = useState<AiStepTimer>(EMPTY_AI_STEP_TIMER);
  const [sidebarWidth, setSidebarWidth] = useState<number>(readStoredSidebarWidth);
  const [sidebarEventTab, setSidebarEventTab] = useState<SidebarEventTab>('thoughts');
  const draggingRef = useRef(false);
  const aiStepAckedRef = useRef(false);
  const aiStepSawWorkRef = useRef(false);
  const aiAutoActiveRef = useRef(false);

  // 防抖：拖拽时高频更新，停手 200ms 后才落盘
  useEffect(() => {
    const t = setTimeout(() => {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(Math.round(sidebarWidth)));
    }, 200);
    return () => clearTimeout(t);
  }, [sidebarWidth]);

  // 窗口缩小时把宽度夹回合法范围
  useEffect(() => {
    const onResize = () => {
      const max = window.innerWidth * SIDEBAR_MAX_RATIO;
      setSidebarWidth((w) => Math.max(SIDEBAR_MIN, Math.min(max, w)));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onSplitterDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current) return;
      const next = window.innerWidth - ev.clientX;
      const max = window.innerWidth * SIDEBAR_MAX_RATIO;
      setSidebarWidth(Math.max(SIDEBAR_MIN, Math.min(max, next)));
    };
    const onUp = () => {
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  const resetSidebarWidth = useCallback(() => setSidebarWidth(SIDEBAR_DEFAULT), []);

  const dispatch = useCallback((a: Action) => {
    socket.emit('dispatch', a);
  }, []);

  const setAiAutoplay = useCallback((autoplay: boolean) => {
    socket.emit('set_ai_autoplay', { autoplay });
  }, []);

  const setAiHint = useCallback((hint: boolean) => {
    socket.emit('set_ai_hint', { hint });
  }, []);

  const setAiProvider = useCallback((playerId: number, provider: string) => {
    socket.emit('set_ai_provider', { player: playerId, provider });
  }, []);

  const finishAiStepTimer = useCallback((ok: boolean) => {
    setAiStepTimer((timer) => {
      if (!timer.running || timer.startedAt == null) return timer;
      const elapsedMs = Math.max(0, nowMs() - timer.startedAt);
      return {
        running: false,
        startedAt: null,
        elapsedMs,
        lastMs: elapsedMs,
        lastOk: ok,
      };
    });
  }, []);

  const startAiAutoTimer = useCallback(() => {
    aiAutoActiveRef.current = true;
    setAiAutoTimer((timer) => {
      if (timer.running) return timer;
      return {
        running: true,
        startedAt: nowMs(),
        elapsedMs: 0,
        lastMs: timer.lastMs,
        lastOk: timer.lastOk,
      };
    });
  }, []);

  const finishAiAutoTimer = useCallback((ok: boolean) => {
    aiAutoActiveRef.current = false;
    setAiAutoTimer((timer) => {
      if (!timer.running || timer.startedAt == null) return timer;
      const elapsedMs = Math.max(0, nowMs() - timer.startedAt);
      return {
        running: false,
        startedAt: null,
        elapsedMs,
        lastMs: elapsedMs,
        lastOk: ok,
      };
    });
  }, []);

  const stepAi = useCallback(() => {
    // 乐观置位：服务端 step_ai 是「先广播 ai_control_state(queued=true) 再回 ack」。
    // 若等 ack 回调才置 acked，那条先到的 queued=true 控制事件会被 onAiControl 的
    // `if (!aiStepAckedRef.current) return` 漏掉 → aiStepSawWorkRef 永不置上。
    // 普通动作步靠 ai_thought 兜底结束计时，但纯交易谈判步只发 trade_chat_*、不发 ai_thought，
    // 于是计时永不结束、单步按钮一直 disabled。提前置 acked 即可让 queued=true 被正确捕获。
    aiStepAckedRef.current = true;
    aiStepSawWorkRef.current = false;
    setAiStepTimer((timer) => ({
      running: true,
      startedAt: nowMs(),
      elapsedMs: 0,
      lastMs: timer.lastMs,
      lastOk: timer.lastOk,
    }));
    socket
      .timeout(2000)
      .emit('step_ai', (err: Error | null, res?: { ok: boolean; reason?: string }) => {
        if (err || !res || !res.ok) {
          aiStepAckedRef.current = false;
          aiStepSawWorkRef.current = false;
          finishAiStepTimer(false);
          setToast(res?.reason ?? 'AI 暂时无法推进');
          setTimeout(() => setToast(null), 2200);
          return;
        }
        // 成功：acked 已乐观置位，无需再动
      });
  }, [finishAiStepTimer]);

  useEffect(() => {
    if (!aiStepTimer.running || aiStepTimer.startedAt == null) return;
    const tick = () => {
      setAiStepTimer((timer) =>
        timer.running && timer.startedAt != null
          ? { ...timer, elapsedMs: Math.max(0, nowMs() - timer.startedAt) }
          : timer,
      );
    };
    tick();
    const id = window.setInterval(tick, 100);
    return () => window.clearInterval(id);
  }, [aiStepTimer.running, aiStepTimer.startedAt]);

  useEffect(() => {
    if (!aiAutoTimer.running || aiAutoTimer.startedAt == null) return;
    const tick = () => {
      setAiAutoTimer((timer) =>
        timer.running && timer.startedAt != null
          ? { ...timer, elapsedMs: Math.max(0, nowMs() - timer.startedAt) }
          : timer,
      );
    };
    tick();
    const id = window.setInterval(tick, 100);
    return () => window.clearInterval(id);
  }, [aiAutoTimer.running, aiAutoTimer.startedAt]);

  const flash = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 2200);
  }, []);

  useEffect(() => {
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onSync = (g: FullGame) => setGame(g);
    const append = (item: ThoughtLogItem) =>
      setThoughtLog((arr) => {
        const next = [...arr, item];
        return next.length > THOUGHT_LOG_MAX ? next.slice(-THOUGHT_LOG_MAX) : next;
      });
    const appendTrade = (item: TradeLogItem) =>
      setTradeLog((arr) => {
        const next = [...arr, item];
        return next.length > TRADE_LOG_MAX ? next.slice(-TRADE_LOG_MAX) : next;
      });
    const onThought = (ev: AiThoughtEvent) => {
      append({ kind: 'thought', data: ev });
      if (ev.action) setAiFocus({ player: ev.player, action: ev.action, ts: ev.ts });
      if (aiStepAckedRef.current) {
        aiStepAckedRef.current = false;
        aiStepSawWorkRef.current = false;
        finishAiStepTimer(true);
      } else if (aiAutoActiveRef.current) {
        finishAiAutoTimer(true);
      }
    };
    const onError = (ev: AiErrorEvent) => append({ kind: 'error', data: ev });
    const onTradeStarted = (ev: TradeChatStartedEvent) =>
      appendTrade({ kind: 'started', data: ev });
    const onTradeMessage = (ev: TradeChatMessageEvent) =>
      appendTrade({ kind: 'message', data: ev });
    const onTradeClosed = (ev: TradeChatClosedEvent) =>
      appendTrade({ kind: 'closed', data: ev });
    const onHumanTradeState = (ev: HumanTradeStateEvent) => setHumanTradeState(ev);
    const onAiControl = (ev: AiControlState) => {
      setAiControl(ev);
      const hasWork = ev.queued || ev.busy;
      if (!aiStepAckedRef.current && ev.autoplay && hasWork) {
        startAiAutoTimer();
      } else if (aiAutoActiveRef.current && !hasWork) {
        finishAiAutoTimer(ev.autoplay);
      }
      if (!aiStepAckedRef.current) return;
      if (hasWork) {
        aiStepSawWorkRef.current = true;
        return;
      }
      if (aiStepSawWorkRef.current) {
        aiStepAckedRef.current = false;
        aiStepSawWorkRef.current = false;
        finishAiStepTimer(true);
      }
    };
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('sync_state', onSync);
    socket.on('ai_thought', onThought);
    socket.on('ai_error', onError);
    socket.on('trade_chat_started', onTradeStarted);
    socket.on('trade_chat_message', onTradeMessage);
    socket.on('trade_chat_closed', onTradeClosed);
    socket.on('human_trade_state', onHumanTradeState);
    socket.on('ai_control_state', onAiControl);
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('sync_state', onSync);
      socket.off('ai_thought', onThought);
      socket.off('ai_error', onError);
      socket.off('trade_chat_started', onTradeStarted);
      socket.off('trade_chat_message', onTradeMessage);
      socket.off('trade_chat_closed', onTradeClosed);
      socket.off('human_trade_state', onHumanTradeState);
      socket.off('ai_control_state', onAiControl);
    };
  }, [finishAiAutoTimer, finishAiStepTimer, startAiAutoTimer]);

  // 识别"新局"：以 gameId 变化为准清空思考流 / 谈判流。
  // 比"turn/phase/setupIndex 归零"的旧启发更稳——对所有客户端一致，
  // 也能覆盖"从开局相同局面重开"这种状态特征不变的情况。
  const prevGameIdRef = useRef<string | null>(null);
  useEffect(() => {
    const gid = game?.state.gameId ?? null;
    if (gid == null) return;
    if (prevGameIdRef.current == null) {
      // 首次拿到状态：记基线、不清空（保留服务端连接时补拉的历史 buffer）
      prevGameIdRef.current = gid;
      return;
    }
    if (prevGameIdRef.current !== gid) {
      prevGameIdRef.current = gid;
      setThoughtLog([]);
      setTradeLog([]);
      setHumanTradeState(EMPTY_HUMAN_TRADE_STATE);
      setAiFocus(null);
      aiStepAckedRef.current = false;
      aiStepSawWorkRef.current = false;
      aiAutoActiveRef.current = false;
      setAiStepTimer(EMPTY_AI_STEP_TIMER);
      setAiAutoTimer(EMPTY_AI_STEP_TIMER);
    }
  }, [game?.state.gameId]);

  // AI 动作高亮只短暂停留，避免遮挡后续人工操作。
  useEffect(() => {
    if (!aiFocus) return;
    const t = setTimeout(() => setAiFocus(null), 1800);
    return () => clearTimeout(t);
  }, [aiFocus?.ts]);

  // ⚠️ 所有 hook 必须在 early return 之前调用（Rules of Hooks）
  const state = game?.state;
  const activeHumanSeat = useMemo(() => humanActionSeat(state), [state]);
  const humanTabAttentionKey = useMemo(
    () => humanAttentionKey(state, humanTradeState),
    [state, humanTradeState],
  );
  useEffect(() => {
    if (humanTabAttentionKey) setSidebarEventTab('human');
  }, [humanTabAttentionKey]);
  const isHumanTurn = state ? state.players[state.current]?.isAI === false : false;
  const isSetup = state?.phase === 'setup1' || state?.phase === 'setup2';
  const boardMode: BoardMode = useMemo(() => {
    if (!state) return null;
    if (state.phase === 'gameOver') return null;
    if (isSetup && isHumanTurn) return state.setupStep === 'settlement' ? 'settlement' : 'road';
    if (state.phase === 'moveRobber' && isHumanTurn) return 'robber';
    if (state.phase === 'main' && isHumanTurn) return mode;
    return null;
  }, [state, isSetup, isHumanTurn, mode]);

  if (!game || !state) {
    return (
      <div className="app">
        <div className="hint" style={{ margin: 'auto', padding: 24 }}>
          {connected ? '正在加载棋盘…' : '正在连接服务器…'}
        </div>
      </div>
    );
  }

  const { board } = game;

  // 棋盘点击
  const onVertex = (v: number) => {
    if (isSetup) dispatch({ type: 'PLACE_SETTLEMENT', v });
    else if (mode === 'settlement') {
      dispatch({ type: 'BUILD_SETTLEMENT', v });
      setMode(null);
    } else if (mode === 'city') {
      dispatch({ type: 'BUILD_CITY', v });
      setMode(null);
    }
  };
  const onEdge = (e: number) => {
    if (isSetup) dispatch({ type: 'PLACE_ROAD', e });
    else if (mode === 'road') {
      dispatch({ type: 'BUILD_ROAD', e });
      if (state.freeRoads <= 1) setMode(null);
    }
  };
  const onHex = (h: number) => {
    if (state.phase === 'moveRobber') dispatch({ type: 'MOVE_ROBBER', hex: h });
  };

  const newGame = () => {
    socket.emit('new_game');
    setMode(null);
  };

  return (
    <div
      className="app"
      style={{ ['--sidebar-width' as string]: `${Math.round(sidebarWidth)}px` }}
    >
      <div className="board-area">
        <img
          className="game-title-mark"
          src="/assets/title-ai-catan.png"
          alt="AI 大战：卡坦岛"
          draggable={false}
        />
        <div className="board-wrap">
          <Board
            board={board}
            state={state}
            mode={boardMode}
            onVertex={onVertex}
            onEdge={onEdge}
            onHex={onHex}
            highlightAction={aiFocus?.action ?? null}
            highlightPlayer={aiFocus?.player ?? null}
          />
        </div>
        <DiceHud dice={state.dice} turn={state.turn} />
        <button className="new-game-fab" onClick={newGame} title="重开一局">
          ↺
        </button>
      </div>

      <div
        className="splitter"
        role="separator"
        aria-orientation="vertical"
        title="拖拽调整左右占比（双击重置）"
        onPointerDown={onSplitterDown}
        onDoubleClick={resetSidebarWidth}
      >
        <span className="splitter-grip" aria-hidden="true" />
      </div>

      <aside className="sidebar">
        <div className="sidebar-scroll">
          <Players
            game={game}
            processingMs={
              aiStepTimer.running
                ? aiStepTimer.elapsedMs
                : aiAutoTimer.running
                  ? aiAutoTimer.elapsedMs
                  : null
            }
            agentProviders={aiControl.agentProviders}
            agentPersonalities={aiControl.agentPersonalities}
            providerOptions={aiControl.providerOptions}
            connected={connected}
            onSetProvider={setAiProvider}
          />
        </div>
        <SidebarEventPanel
          activeTab={sidebarEventTab}
          onTabChange={setSidebarEventTab}
          thoughtItems={thoughtLog}
          tradeItems={tradeLog}
          game={game}
          mode={mode}
          setMode={setMode}
          dispatch={dispatch}
          flash={flash}
          humanSeat={activeHumanSeat}
          humanTradeState={humanTradeState}
          connected={connected}
          hasHumanAttention={Boolean(humanTabAttentionKey)}
        />
        <div className="sidebar-fixed-controls">
          <AiControls
            control={aiControl}
            connected={connected}
            stepTimer={aiStepTimer}
            onAutoplay={setAiAutoplay}
            onStep={stepAi}
            onToggleHint={setAiHint}
          />
        </div>
      </aside>

      {toast && <div className="toast">{toast}</div>}

      {state.phase === 'gameOver' && state.winner != null && (
        <div className="modal-bg">
          <Confetti />
          <div className="modal">
            <h2>🏆 {playerDisplayName(state.players, state.winner)} 获胜</h2>
            <p>
              {playerDisplayName(state.players, state.winner)} 率先达到 10 分。
              <br />
              再来一局？
            </p>
            <button className="btn primary" onClick={newGame}>
              开始新游戏
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- AI 控制 ----------

function AiControls({
  control,
  connected,
  stepTimer,
  onAutoplay,
  onStep,
  onToggleHint,
}: {
  control: AiControlState;
  connected: boolean;
  stepTimer: AiStepTimer;
  onAutoplay: (autoplay: boolean) => void;
  onStep: () => void;
  onToggleHint: (hint: boolean) => void;
}) {
  const waiting = control.queued || control.busy;
  const stepDisabled = stepTimer.running || !connected || control.autoplay || waiting || !control.canStep;

  return (
    <div className="card card-plain">
      <div className="btn-grid btn-grid-3">
        <button
          type="button"
          className={`btn${control.hintEnabled ? ' primary' : ''}`}
          disabled={!connected}
          onClick={() => onToggleHint(!control.hintEnabled)}
          title="切换是否在 LLM prompt 里塞空间动作 hint；A/B 实验用，仅影响后续决策"
        >
          hint
        </button>
        <button
          className={`btn${control.autoplay ? ' primary' : ''}`}
          disabled={!connected}
          onClick={() => onAutoplay(!control.autoplay)}
        >
          {control.autoplay ? '暂停' : '自动'}
        </button>
        <button className="btn" disabled={stepDisabled} onClick={onStep}>
          单步
        </button>
      </div>
    </div>
  );
}

// ---------- 玩家面板 ----------

function Players({
  game,
  processingMs,
  agentProviders,
  agentPersonalities,
  providerOptions,
  connected,
  onSetProvider,
}: {
  game: FullGame;
  processingMs: number | null;
  agentProviders: Record<number, string>;
  agentPersonalities: Record<number, string>;
  providerOptions: AiControlState['providerOptions'];
  connected: boolean;
  onSetProvider: (playerId: number, provider: string) => void;
}) {
  const { board, state } = game;
  const prevResourcesRef = useRef<Record<number, ResMap>>(
    Object.fromEntries(state.players.map((p) => [p.id, { ...p.resources }])) as Record<
      number,
      ResMap
    >,
  );
  const [resourceGlow, setResourceGlow] = useState<Record<number, Resource[]>>({});

  useEffect(() => {
    const nextGlow: Record<number, Resource[]> = {};
    for (const p of state.players) {
      const prev = prevResourcesRef.current[p.id];
      const gained = prev ? RESOURCES.filter((r) => p.resources[r] > prev[r]) : [];
      if (gained.length > 0) nextGlow[p.id] = gained;
      prevResourcesRef.current[p.id] = { ...p.resources };
    }
    if (Object.keys(nextGlow).length === 0) return;
    setResourceGlow(nextGlow);
    const t = setTimeout(() => setResourceGlow({}), 650);
    return () => clearTimeout(t);
  }, [state.players]);

  return (
    <div className="card card-plain">
      <div className="players-grid">
        {state.players.map((pl) => {
          const vp = pl.isAI ? publicVP(state, pl.id) : totalVP(state, pl.id);
          const lr = longestRoadLength(board, state, pl.id);
          const provider = pl.isAI ? normalizeProviderKey(agentProviders[pl.id]) : 'human';
          return (
            <div
              key={pl.id}
              className={`player-row${state.current === pl.id ? ' active' : ''}`}
              title={pl.isAI ? agentPersonalities[pl.id] : undefined}
            >
              <div className="player-head">
                <span className="player-dot" style={{ background: pl.color }} />
                <span className="player-name">{playerDisplayName(state.players, pl.id)}</span>
                <select
                  className="player-ai-select"
                  value={provider}
                  disabled={!connected}
                  onChange={(e) => onSetProvider(pl.id, e.target.value)}
                  title="切换这个席位由真人或后端 AI 模型控制"
                >
                  <option value="human">真人</option>
                  {(providerOptions.length > 0
                    ? providerOptions
                    : [{ key: 'rule', label: '规则 AI', available: true }]
                  ).map((option) => (
                    <option key={option.key} value={option.key} disabled={!option.available}>
                      {providerShortLabel(option.key)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="player-stats">
                <span className="player-stat-vp">
                  <b>{vp}</b>
                  分
                </span>
                <span>
                  <b>{handSize(pl)}</b>
                  牌
                </span>
                <span>
                  <b>{pl.devCards.length + pl.newDevCards.length}</b>
                  卡
                </span>
                <span>
                  <b>{lr}</b>
                  路
                </span>
                <span>
                  <b>{pl.knightsPlayed}</b>
                  骑
                </span>
              </div>
              <div className="player-resources">
                {RESOURCES.map((r) => (
                  <span
                    key={r}
                    className={`player-res${resourceGlow[pl.id]?.includes(r) ? ' gain' : ''}`}
                    title={`${RESOURCE_LABEL[r]} ${pl.resources[r]}`}
                  >
                    <span className="player-res-key">{r}</span>
                    <b>{pl.resources[r]}</b>
                  </span>
                ))}
              </div>
              <div className="player-badges">
                {state.current === pl.id && processingMs != null && (
                  <span className="player-time">
                    {(processingMs / 1000).toFixed(1)}秒
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- 阶段交互区 ----------

function Phase({
  game,
  mode,
  setMode,
  dispatch,
  flash,
  seat,
  humanTradeState,
  connected,
}: {
  game: FullGame;
  mode: BoardMode;
  setMode: (m: BoardMode) => void;
  dispatch: (a: Action) => void;
  flash: (m: string) => void;
  seat: number | null;
  humanTradeState: HumanTradeStateEvent;
  connected: boolean;
}) {
  const { board, state } = game;
  if (seat == null) {
    return <div className="hint">当前没有需要真人处理的动作。轮到 AI 时可用底部控制区推进。</div>;
  }

  const me = state.players[seat];
  const isHumanTurn = state.current === seat && me?.isAI === false;

  return (
    <>
      {/* 弃牌（玩家） */}
      {state.phase === 'discard' && state.discardLeft[seat] != null && (
        <DiscardPanel state={state} seat={seat} dispatch={dispatch} />
      )}

      {/* AI 向我提议交易 */}
      {state.pendingTrade && state.pendingTrade.to === seat && (
        <PendingTrade game={game} dispatch={dispatch} />
      )}

      {/* setup 提示 */}
      {(state.phase === 'setup1' || state.phase === 'setup2') && isHumanTurn && (
        <div className="hint">
          初始布置：{state.setupStep === 'settlement' ? '点击高亮顶点放置房屋' : '点击房屋旁的高亮道路放置道路'}
          {state.phase === 'setup2' ? '（第二个房屋会立即获得相邻资源）' : ''}
        </div>
      )}

      {/* 掷骰阶段 */}
      {state.phase === 'roll' && isHumanTurn && (
        <div className="card">
          <h2>你的回合</h2>
          <div className="btn-col">
            <button className="btn primary" onClick={() => dispatch({ type: 'ROLL' })}>
              🎲 掷骰子
            </button>
            {me.devCards.includes('骑士') && !state.devPlayed && (
              <button className="btn" onClick={() => dispatch({ type: 'PLAY_KNIGHT' })}>
                先打出骑士卡
              </button>
            )}
          </div>
        </div>
      )}

      {/* 移动强盗 */}
      {state.phase === 'moveRobber' && isHumanTurn && (
        <div className="hint">点击任意地块，把强盗移过去。</div>
      )}

      {/* 偷牌 */}
      {state.phase === 'steal' && isHumanTurn && (
        <div className="card">
          <h2>选择偷牌对象</h2>
          <div className="btn-col">
            {robberCandidates(board, state).map((c) => (
              <button
                key={c}
                className="btn"
                onClick={() => dispatch({ type: 'STEAL', target: c })}
              >
                偷 {playerDisplayName(state.players, c)}（{handSize(state.players[c])} 张）
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 主阶段操作 */}
      {state.phase === 'main' && isHumanTurn && (
        <MainActions
          game={game}
          seat={seat}
          mode={mode}
          setMode={setMode}
          dispatch={dispatch}
          flash={flash}
          humanTradeState={humanTradeState}
          connected={connected}
        />
      )}
    </>
  );
}

// ---------- 主阶段操作 ----------

function MainActions({
  game,
  seat,
  mode,
  setMode,
  dispatch,
  flash,
  humanTradeState,
  connected,
}: {
  game: FullGame;
  seat: number;
  mode: BoardMode;
  setMode: (m: BoardMode) => void;
  dispatch: (a: Action) => void;
  flash: (m: string) => void;
  humanTradeState: HumanTradeStateEvent;
  connected: boolean;
}) {
  const { state } = game;
  const me = state.players[seat];
  const afford = (c: Partial<ResMap>) => RESOURCES.every((r) => me.resources[r] >= (c[r] ?? 0));

  return (
    <>
      <div className="card">
        <div className="btn-grid build-actions">
          <button
            className={`btn${mode === 'road' ? ' primary' : ''}`}
            disabled={state.freeRoads === 0 && !afford(COSTS.road)}
            onClick={() => setMode(mode === 'road' ? null : 'road')}
          >
            修路
          </button>
          <button
            className={`btn${mode === 'settlement' ? ' primary' : ''}`}
            disabled={!afford(COSTS.settlement)}
            onClick={() => setMode(mode === 'settlement' ? null : 'settlement')}
          >
            建村
          </button>
          <button
            className={`btn${mode === 'city' ? ' primary' : ''}`}
            disabled={!afford(COSTS.city)}
            onClick={() => setMode(mode === 'city' ? null : 'city')}
          >
            升级
          </button>
          <button
            className="btn"
            disabled={!afford(COSTS.dev) || state.devDeck.length === 0}
            onClick={() => dispatch({ type: 'BUY_DEV' })}
          >
            发展
          </button>
        </div>
        {mode && (
          <p className="cost" style={{ marginTop: 8 }}>
            已进入「{mode === 'road' ? '修路' : mode === 'settlement' ? '建房屋' : '升级城市'}」模式，点击棋盘上的高亮位置。再次点击按钮取消。
          </p>
        )}
      </div>

      <DevCards state={state} seat={seat} dispatch={dispatch} />

      <BankTrade game={game} seat={seat} dispatch={dispatch} />

      <HumanNegotiation
        game={game}
        seat={seat}
        humanTradeState={humanTradeState}
        connected={connected}
        flash={flash}
      />

      <button className="btn warn" onClick={() => dispatch({ type: 'END_TURN' })}>
        结束回合
      </button>
    </>
  );
}

// ---------- 发展卡 ----------

function DevCards({
  state,
  seat,
  dispatch,
}: {
  state: FullGame['state'];
  seat: number;
  dispatch: (a: Action) => void;
}) {
  const me = state.players[seat];
  const [yop, setYop] = useState<[Resource, Resource]>(['木', '砖']);
  const [mono, setMono] = useState<Resource>('木');

  const counts: Record<DevCard, number> = {
    骑士: 0,
    胜利点: 0,
    修路: 0,
    丰收: 0,
    垄断: 0,
  };
  me.devCards.forEach((c) => counts[c]++);
  const newCount = me.newDevCards.length;
  const can = (c: DevCard) => counts[c] > 0 && !state.devPlayed;

  if (
    me.devCards.length === 0 &&
    me.newDevCards.length === 0 &&
    me.vpCards === 0
  )
    return null;

  return (
    <div className="card">
      <h2>发展卡</h2>
      <div className="tag-row" style={{ marginBottom: 8 }}>
        {(Object.keys(counts) as DevCard[])
          .filter((c) => counts[c] > 0)
          .map((c) => (
            <span key={c} className="tag">
              {DEV_LABEL[c]} ×{counts[c]}
            </span>
          ))}
        {me.vpCards > 0 && <span className="tag">胜利点 ×{me.vpCards}</span>}
        {newCount > 0 && <span className="tag">本回合新购 ×{newCount}（下回合可用）</span>}
      </div>
      <div className="btn-col">
        <button className="btn" disabled={!can('骑士')} onClick={() => dispatch({ type: 'PLAY_KNIGHT' })}>
          打出骑士（移动强盗）
        </button>
        <button
          className="btn"
          disabled={!can('修路')}
          onClick={() => dispatch({ type: 'PLAY_ROAD_BUILDING' })}
        >
          打出修路（免费 2 条路）
        </button>
        {counts.丰收 > 0 && (
          <div className="btn-col">
            <div className="tag-row">
              {([0, 1] as const).map((i) => (
                <select
                  key={i}
                  value={yop[i]}
                  onChange={(e) => {
                    const v = e.target.value as Resource;
                    setYop((p) => (i === 0 ? [v, p[1]] : [p[0], v]));
                  }}
                >
                  {RESOURCES.map((r) => (
                    <option key={r} value={r}>
                      {RESOURCE_LABEL[r]}
                    </option>
                  ))}
                </select>
              ))}
              <button
                className="btn"
                disabled={!can('丰收')}
                onClick={() =>
                  dispatch({ type: 'PLAY_YEAR_OF_PLENTY', r1: yop[0], r2: yop[1] })
                }
              >
                打出丰收
              </button>
            </div>
          </div>
        )}
        {counts.垄断 > 0 && (
          <div className="tag-row">
            <select value={mono} onChange={(e) => setMono(e.target.value as Resource)}>
              {RESOURCES.map((r) => (
                <option key={r} value={r}>
                  {RESOURCE_LABEL[r]}
                </option>
              ))}
            </select>
            <button
              className="btn"
              disabled={!can('垄断')}
              onClick={() => dispatch({ type: 'PLAY_MONOPOLY', r: mono })}
            >
              打出垄断
            </button>
          </div>
        )}
      </div>
      {state.devPlayed && <p className="cost">本回合已打出过发展卡。</p>}
    </div>
  );
}

// ---------- 银行交易 ----------

function BankTrade({
  game,
  seat,
  dispatch,
}: {
  game: FullGame;
  seat: number;
  dispatch: (a: Action) => void;
}) {
  const { board, state } = game;
  const [give, setGive] = useState<Resource>('木');
  const [recv, setRecv] = useState<Resource>('矿');
  const ratio = tradeRatio(board, state, seat, give);
  const me = state.players[seat];
  const ok = give !== recv && me.resources[give] >= ratio && state.bank[recv] > 0;

  return (
    <div className="card">
      <div className="tag-row" style={{ alignItems: 'center' }}>
        <select value={give} onChange={(e) => setGive(e.target.value as Resource)}>
          {RESOURCES.map((r) => (
            <option key={r} value={r}>
              {RESOURCE_LABEL[r]}
            </option>
          ))}
        </select>
        <span>×{ratio} →</span>
        <select value={recv} onChange={(e) => setRecv(e.target.value as Resource)}>
          {RESOURCES.map((r) => (
            <option key={r} value={r}>
              {RESOURCE_LABEL[r]}
            </option>
          ))}
        </select>
        <button
          className="btn"
          disabled={!ok}
          onClick={() => dispatch({ type: 'BANK_TRADE', give, receive: recv })}
        >
          兑换
        </button>
      </div>
    </div>
  );
}

// ---------- 真人交互谈判 ----------

function HumanNegotiation({
  game,
  seat,
  humanTradeState,
  connected,
  flash,
  dock = false,
}: {
  game: FullGame;
  seat: number;
  humanTradeState: HumanTradeStateEvent;
  connected: boolean;
  flash: (m: string) => void;
  dock?: boolean;
}) {
  const { state } = game;
  const me = state.players[seat];
  const aiPlayers = state.players.filter((p) => p.id !== seat && p.isAI);
  const [give, setGive] = useState<ResMap>(emptyRes());
  const [recv, setRecv] = useState<ResMap>(emptyRes());
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!humanTradeState.active || humanTradeState.initiator !== seat) return;
    const offer = humanTradeState.currentOffer;
    if (!offer) return;
    setGive({ ...offer.give });
    setRecv({ ...offer.receive });
  }, [humanTradeState.active, humanTradeState.sessionId, humanTradeState.initiator, seat]);

  const submit = async (kind: 'start' | 'say') => {
    const hasOffer = resTotal(give) + resTotal(recv) > 0;
    if (kind === 'start' && !hasOffer && !message.trim()) {
      flash('请填写喊话或设置一笔报价');
      return;
    }
    const participants = aiPlayers.map((p) => p.id);
    if (kind === 'start' && participants.length === 0) {
      flash('至少选择一个 AI 参与谈判');
      return;
    }
    setPending(true);
    const payload =
      kind === 'start'
        ? { give, receive: recv, message, participants }
        : resTotal(give) + resTotal(recv) > 0
          ? { give, receive: recv, message }
          : { message };
    const res = await emitAck(
      kind === 'start' ? 'human_trade_start' : 'human_trade_say',
      payload,
    );
    setPending(false);
    if (!res.ok) {
      flash(res.reason ?? '谈判请求失败');
      return;
    }
    setMessage('');
    if (kind === 'start') {
      flash('谈判已发起');
    }
  };

  const finalize = async (player: number) => {
    setPending(true);
    const res = await emitAck('human_trade_finalize', { player });
    setPending(false);
    if (!res.ok) flash(res.reason ?? '这笔交易暂时无法成交');
  };

  const endTrade = async () => {
    setPending(true);
    const res = await emitAck('human_trade_end', undefined);
    setPending(false);
    if (!res.ok) flash(res.reason ?? '结束谈判失败');
    else flash('谈判已结束');
  };

  const busy = pending || humanTradeState.busy === true;
  const activeMine = humanTradeState.active && humanTradeState.initiator === seat;
  const maxed =
    activeMine &&
    humanTradeState.messagesUsed != null &&
    humanTradeState.messagesMax != null &&
    humanTradeState.messagesUsed >= humanTradeState.messagesMax;

  return (
    <div className={`card human-negotiation${dock ? ' trade-chat-dock' : ''}`}>
      {activeMine ? (
        <>
          <div className="trade-limits human-trade-limits">
            <span>
              发言 {humanTradeState.messagesUsed ?? 0}/{humanTradeState.messagesMax ?? 0}
            </span>
            {humanTradeState.busy && <span>AI 思考中</span>}
          </div>
          {(humanTradeState.standingDeals ?? []).length > 0 && (
            <div className="human-deals">
              {(humanTradeState.standingDeals ?? []).map((deal) => (
                <div key={`${deal.player}-${deal.source}`} className="human-deal">
                  <div>
                    <b>{deal.note}</b>
                    <span>
                      你给 {resSummary(deal.give)}，收到 {resSummary(deal.receive)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn good"
                    disabled={busy || !connected}
                    onClick={() => finalize(deal.player)}
                  >
                    成交
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      ) : null}

      <details className="trade-quote-details">
        <summary>
          <span>报价</span>
          <span>给 {resSummary(give)}</span>
          <span>收 {resSummary(recv)}</span>
        </summary>
        <p className="cost">我给出：</p>
        <div className="trade-grid">
          {RESOURCES.map((r) => (
            <div key={r} className="trade-cell">
              <span className="trade-res-key" title={RESOURCE_LABEL[r]}>
                {r}
              </span>
              <input
                className="trade-number-input"
                type="number"
                min={0}
                max={me.resources[r]}
                value={give[r]}
                onChange={(e) =>
                  setGive((g) => ({
                    ...g,
                    [r]: clampNumberInput(e.currentTarget.value, me.resources[r]),
                  }))
                }
              />
            </div>
          ))}
        </div>
        <p className="cost" style={{ marginTop: 8 }}>
          我想要：
        </p>
        <div className="trade-grid">
          {RESOURCES.map((r) => (
            <div key={r} className="trade-cell">
              <span className="trade-res-key" title={RESOURCE_LABEL[r]}>
                {r}
              </span>
              <input
                className="trade-number-input"
                type="number"
                min={0}
                max={19}
                value={recv[r]}
                onChange={(e) =>
                  setRecv((g) => ({
                    ...g,
                    [r]: clampNumberInput(e.currentTarget.value, 19),
                  }))
                }
              />
            </div>
          ))}
        </div>
      </details>
      <textarea
        className="human-trade-text"
        value={message}
        disabled={busy || !connected || Boolean(maxed)}
        placeholder={activeMine ? '继续喊话或改价' : '发起喊话或报价'}
        onChange={(e) => setMessage(e.target.value)}
      />
      <div className="human-trade-actions">
        <button
          className="btn"
          disabled={busy || !connected || Boolean(maxed)}
          onClick={() => submit(activeMine ? 'say' : 'start')}
        >
          {busy ? '等待回应…' : activeMine ? '发送' : '发起'}
        </button>
        {activeMine ? (
          <button className="btn warn" disabled={pending || !connected} onClick={endTrade}>
            结束谈判
          </button>
        ) : (
          <button
            className="btn"
            disabled={busy}
            onClick={() => {
              setGive(emptyRes());
              setRecv(emptyRes());
              setMessage('');
            }}
          >
            清空
          </button>
        )}
      </div>
      {maxed && <p className="cost">本轮谈判发言次数已用完，可以成交或结束谈判。</p>}
    </div>
  );
}

// ---------- 弃牌面板 ----------

function DiscardPanel({
  state,
  seat,
  dispatch,
}: {
  state: FullGame['state'];
  seat: number;
  dispatch: (a: Action) => void;
}) {
  const me = state.players[seat];
  const need = state.discardLeft[seat];
  const [sel, setSel] = useState<ResMap>(emptyRes());
  const picked = RESOURCES.reduce((t, r) => t + sel[r], 0);

  return (
    <div className="card">
      <h2>弃牌（需弃 {need} 张，已选 {picked}）</h2>
      <div className="trade-grid">
        {RESOURCES.map((r) => (
          <div key={r} className="trade-cell">
            <ResIcon r={r} size={18} />
            <Stepper
              value={sel[r]}
              max={Math.min(me.resources[r], sel[r] + (need - picked))}
              onChange={(v) => setSel((g) => ({ ...g, [r]: v }))}
            />
          </div>
        ))}
      </div>
      <button
        className="btn warn"
        style={{ marginTop: 10, width: '100%' }}
        disabled={picked !== need}
        onClick={() => dispatch({ type: 'DISCARD', player: seat, cards: sel })}
      >
        确认弃牌
      </button>
    </div>
  );
}

// ---------- 应答 AI 交易 ----------

function PendingTrade({ game, dispatch }: { game: FullGame; dispatch: (a: Action) => void }) {
  const { state } = game;
  const t = state.pendingTrade!;
  const fmt = (m: ResMap) =>
    RESOURCES.filter((r) => m[r] > 0)
      .map((r) => `${RESOURCE_LABEL[r]}×${m[r]}`)
      .join(' ') || '无';
  return (
    <div className="card">
      <h2>{playerDisplayName(state.players, t.from)} 的交易提议</h2>
      <p className="cost">
        对方给你：{fmt(t.give)}
        <br />
        想换走你的：{fmt(t.receive)}
      </p>
      <div className="btn-grid" style={{ marginTop: 8 }}>
        <button className="btn good" onClick={() => dispatch({ type: 'RESPOND_TRADE', accept: true })}>
          接受
        </button>
        <button className="btn" onClick={() => dispatch({ type: 'RESPOND_TRADE', accept: false })}>
          拒绝
        </button>
      </div>
    </div>
  );
}

// ---------- AI 思考流 ----------

function countText(n: number | undefined): string {
  return n == null ? '0' : n.toLocaleString('zh-CN');
}

function msText(ms: number | undefined): string {
  if (ms == null) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

function stageTotal(timing: AiTimingEvent, key: string): number {
  return timing.stages
    .filter((s) => s.key === key || s.key.startsWith(`${key}-`))
    .reduce((sum, s) => sum + s.ms, 0);
}

function TimingPanel({ timing }: { timing: AiTimingEvent }) {
  const providerMs = stageTotal(timing, 'provider') + stageTotal(timing, 'fallback-provider');
  return (
    <details className="thought-timing">
      <summary>
        <span>时延</span>
        <span>总 {msText(timing.serverTotalMs ?? timing.totalMs)}</span>
        <span>模型 {msText(providerMs)}</span>
        {timing.queueMs != null && <span>排队 {msText(timing.queueMs)}</span>}
      </summary>
      <div className="thought-timing-grid">
        {timing.decisionMs != null && <span>决策 {msText(timing.decisionMs)}</span>}
        {timing.commitMs != null && <span>提交 {msText(timing.commitMs)}</span>}
        <span>阶段 {timing.stages.length}</span>
      </div>
      <div className="thought-timing-stages">
        {timing.stages.map((s, idx) => (
          <div key={`${s.key}-${idx}`} className="thought-timing-stage">
            <span>{s.label}</span>
            <strong>{msText(s.ms)}</strong>
            {s.detail && <em>{s.detail}</em>}
          </div>
        ))}
      </div>
    </details>
  );
}

function ModelContextBlock({ title, text }: { title: string; text?: string }) {
  if (!text) return null;
  return (
    <div className="thought-context-block">
      <div className="thought-context-title">{title}</div>
      <pre>{text}</pre>
    </div>
  );
}

function ModelContextPanel({ context }: { context: AiModelContextEvent }) {
  const label = context.format === 'llm-prompt' ? '模型输入' : 'Provider 输入';
  return (
    <details className="thought-context">
      <summary>
        <span>{label}</span>
        <span>{countText(context.chars.total)} 字</span>
        <span>{context.legalActionCount} 动作</span>
        {context.retryFeedbackCount > 0 && <span>{context.retryFeedbackCount} 次反馈</span>}
      </summary>
      <div className="thought-context-stats">
        {context.chars.view != null && <span>view {countText(context.chars.view)}</span>}
        {context.chars.legalActions != null && <span>actions {countText(context.chars.legalActions)}</span>}
        {context.chars.system != null && <span>system {countText(context.chars.system)}</span>}
        {context.chars.user != null && <span>user {countText(context.chars.user)}</span>}
      </div>
      <ModelContextBlock title="system" text={context.systemPrompt} />
      <ModelContextBlock title="user" text={context.userPrompt} />
      <ModelContextBlock title="provider input" text={context.providerInputJson} />
    </details>
  );
}

function ModelOutputPanel({ output }: { output: AiModelOutputEvent }) {
  const label = output.format === 'llm-raw' ? '模型输出' : 'Provider 输出';
  return (
    <details className="thought-context">
      <summary>
        <span>{label}</span>
        <span>{countText(output.chars.total)} 字</span>
        {output.format === 'llm-raw' && output.chars.raw != null && (
          <span>原始 {countText(output.chars.raw)}</span>
        )}
      </summary>
      <ModelContextBlock title="raw" text={output.rawOutput} />
      <ModelContextBlock title="parsed" text={output.parsedJson} />
    </details>
  );
}

function TradeMessageDebug({
  modelContext,
  rawOutput,
  provider,
}: {
  modelContext?: AiModelContextEvent;
  rawOutput?: string;
  provider?: string;
}) {
  if (!modelContext && !rawOutput) return null;
  return (
    <div className="trade-message-debug">
      {modelContext && <ModelContextPanel context={modelContext} />}
      {rawOutput && (
        <details className="thought-context">
          <summary>
            <span>模型原始输出</span>
            {provider && <span>{provider}</span>}
            <span>{countText(rawOutput.length)} 字</span>
          </summary>
          <div className="thought-context-block">
            <pre>{rawOutput}</pre>
          </div>
        </details>
      )}
    </div>
  );
}

function SidebarEventPanel({
  activeTab,
  onTabChange,
  thoughtItems,
  tradeItems,
  game,
  mode,
  setMode,
  dispatch,
  flash,
  humanSeat,
  humanTradeState,
  connected,
  hasHumanAttention,
}: {
  activeTab: SidebarEventTab;
  onTabChange: (tab: SidebarEventTab) => void;
  thoughtItems: ThoughtLogItem[];
  tradeItems: TradeLogItem[];
  game: FullGame;
  mode: BoardMode;
  setMode: (mode: BoardMode) => void;
  dispatch: (a: Action) => void;
  flash: (m: string) => void;
  humanSeat: number | null;
  humanTradeState: HumanTradeStateEvent;
  connected: boolean;
  hasHumanAttention: boolean;
}) {
  const { state } = game;
  const players = state.players;
  return (
    <div className="card card-plain sidebar-event-panel">
      <div className="sidebar-tabs" role="tablist" aria-label="AI 思考流与对局日志">
        <button
          type="button"
          className={activeTab === 'human' ? 'active' : ''}
          role="tab"
          aria-selected={activeTab === 'human'}
          onClick={() => onTabChange('human')}
        >
          我的操作
          {hasHumanAttention && <span className="tab-dot" />}
        </button>
        <button
          type="button"
          className={activeTab === 'thoughts' ? 'active' : ''}
          role="tab"
          aria-selected={activeTab === 'thoughts'}
          onClick={() => onTabChange('thoughts')}
        >
          AI 思考流
        </button>
        <button
          type="button"
          className={activeTab === 'trades' ? 'active' : ''}
          role="tab"
          aria-selected={activeTab === 'trades'}
          onClick={() => onTabChange('trades')}
        >
          交易谈判
        </button>
        <button
          type="button"
          className={activeTab === 'log' ? 'active' : ''}
          role="tab"
          aria-selected={activeTab === 'log'}
          onClick={() => onTabChange('log')}
        >
          对局日志
        </button>
      </div>
      <div className="sidebar-tab-body">
        {activeTab === 'human' && (
          <div className="human-actions">
            <Phase
              game={game}
              mode={mode}
              setMode={setMode}
              dispatch={dispatch}
              flash={flash}
              seat={humanSeat}
              humanTradeState={humanTradeState}
              connected={connected}
            />
          </div>
        )}
        {activeTab === 'thoughts' && (
          <ThoughtLogContent items={thoughtItems} players={players} />
        )}
        {activeTab === 'trades' && (
          <div className="trade-tab-layout">
            <TradeLogContent items={tradeItems} players={players} />
            {humanSeat != null && (
              <HumanNegotiation
                game={game}
                seat={humanSeat}
                humanTradeState={humanTradeState}
                connected={connected}
                flash={flash}
                dock
              />
            )}
          </div>
        )}
        {activeTab === 'log' && (
          <LogContent state={state} />
        )}
      </div>
    </div>
  );
}

function ThoughtLogContent({
  items,
  players,
}: {
  items: ThoughtLogItem[];
  players: FullGame['state']['players'];
}) {
  const reversed = [...items].slice(-50).reverse();
  return (
    <>
      {reversed.length === 0 ? (
        <p className="cost">等待 AI 行动…</p>
      ) : (
        <div className="thought-log">
          {reversed.map((it, i) => {
            const p = players[it.data.player];
            if (it.kind === 'thought') {
              const t = it.data;
              return (
                <div key={`${t.ts}-${i}`} className={`thought-row${t.status === 'fallback' ? ' is-fallback' : ''}`}>
                  <div className="thought-head">
                    <span className="player-dot" style={{ background: p?.color }} />
                    <span className="thought-who">{t.agentName ?? p?.name ?? `玩家${t.player}`}</span>
                    <span className="thought-tag">{t.phase}</span>
                    <span className="thought-tag thought-tag-prov">{t.provider}</span>
                    {t.agentMemorySize != null && (
                      <span className="thought-tag">记忆 {t.agentMemorySize}</span>
                    )}
                    {t.retries > 0 && (
                      <span className="thought-tag thought-tag-warn">重试 ×{t.retries}</span>
                    )}
                  </div>
                  <div className="thought-text">{t.thought}</div>
                  {t.turnGoal && (
                    <div className="thought-goal" title="LLM 声明的本回合目标">
                      ▸ 本回合：{t.turnGoal}
                    </div>
                  )}
                  {t.stance && (
                    <div className="thought-stance" title="LLM 声明的长期策略阶段">
                      ◈ 策略：{t.stance}
                    </div>
                  )}
                  <div className="thought-action">→ {t.actionSummary}</div>
                  {t.actionHint && (
                    <div className="thought-hint" title="该动作的语义化情报（喂给 LLM 的 hint）">
                      ◇ {t.actionHint}
                    </div>
                  )}
                  {t.timing && <TimingPanel timing={t.timing} />}
                  {t.modelContext && <ModelContextPanel context={t.modelContext} />}
                  {t.modelOutput && <ModelOutputPanel output={t.modelOutput} />}
                </div>
              );
            }
            const e = it.data;
            return (
              <div key={`${e.ts}-${i}`} className="thought-row is-error">
                <div className="thought-head">
                  <span className="player-dot" style={{ background: p?.color }} />
                  <span className="thought-who">{e.agentName ?? p?.name ?? `玩家${e.player}`}</span>
                  <span className="thought-tag">{e.phase}</span>
                  <span className="thought-tag thought-tag-prov">{e.provider}</span>
                  <span className="thought-tag thought-tag-err">错误</span>
                </div>
                <div className="thought-text">{e.message}</div>
                {e.timing && <TimingPanel timing={e.timing} />}
                {e.modelContext && <ModelContextPanel context={e.modelContext} />}
                {e.rawOutput && (
                  <details className="thought-context">
                    <summary>
                      <span>模型输出</span>
                      <span>{countText(e.rawOutput.length)} 字</span>
                    </summary>
                    <ModelContextBlock title="raw" text={e.rawOutput} />
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ---------- 交易谈判 ----------

function decisionLabel(decision: TradeChatMessageEvent['decision']): string {
  switch (decision) {
    case 'PROPOSE':
      return '报价';
    case 'CHAT':
      return '喊话';
    case 'ACCEPT':
      return '接受';
    case 'REJECT':
      return '拒绝';
    case 'COUNTER_OFFER':
      return '还价';
    case 'SYSTEM':
      return '系统';
  }
}

function tradeStatusLabel(status: TradeChatClosedEvent['status']): string {
  switch (status) {
    case 'accepted':
      return '成交';
    case 'rejected':
      return '流局';
    case 'expired':
      return '超时';
    case 'invalid':
      return '无效';
  }
}

function playerLabel(players: FullGame['state']['players'], id: number | null): string {
  if (id == null) return '所有参与者';
  // AI 玩家 name 为空串，回退到颜色字样（红蓝绿橙）；逻辑收敛在 shared 的 playerDisplayName
  return playerDisplayName(players, id);
}

function ResList({ res }: { res: ResMap }) {
  const entries = RESOURCES.filter((r) => res[r] > 0);
  if (entries.length === 0) return <span className="trade-res-empty">无</span>;
  return (
    <span className="trade-res-list">
      {entries.map((r) => (
        <span key={r} className="trade-res-pill">
          {r}×{res[r]}
        </span>
      ))}
    </span>
  );
}

function TradeOfferLine({
  offer,
  players,
}: {
  offer: TradeOfferEvent;
  players: FullGame['state']['players'];
}) {
  return (
    <div className="trade-offer-line">
      <div className="trade-route">
        {playerLabel(players, offer.from)} → {playerLabel(players, offer.to)}
      </div>
      <div className="trade-ledger">
        <span>给出</span>
        <ResList res={offer.give} />
        <span>换得</span>
        <ResList res={offer.receive} />
      </div>
    </div>
  );
}

function TradeLimitsLine({ limits }: { limits: TradeChatStartedEvent['limits'] }) {
  return (
    <div className="trade-limits">
      <span>发言 {limits.messagesUsed}/{limits.messagesMax}</span>
      <span>报价 {limits.offersUsed}/{limits.offersMax}</span>
      <span>还价 {limits.counterOffersUsed}/{limits.counterOffersMax}</span>
      <span>本回合 {limits.sessionsUsedByInitiator}/{limits.sessionsMaxPerTurn}</span>
    </div>
  );
}

function TradeLogContent({
  items,
  players,
}: {
  items: TradeLogItem[];
  players: FullGame['state']['players'];
}) {
  const sessions = useMemo(() => {
    const map = new Map<
      string,
      {
        sessionId: string;
        started?: TradeChatStartedEvent;
        messages: TradeChatMessageEvent[];
        closed?: TradeChatClosedEvent;
        ts: number;
      }
    >();
    for (const item of items) {
      const sessionId = item.data.sessionId;
      const session =
        map.get(sessionId) ??
        ({
          sessionId,
          messages: [],
          ts: item.data.ts,
        } as {
          sessionId: string;
          started?: TradeChatStartedEvent;
          messages: TradeChatMessageEvent[];
          closed?: TradeChatClosedEvent;
          ts: number;
        });
      session.ts = Math.max(session.ts, item.data.ts);
      if (item.kind === 'started') session.started = item.data;
      else if (item.kind === 'message') session.messages.push(item.data);
      else session.closed = item.data;
      map.set(sessionId, session);
    }
    return [...map.values()].sort((a, b) => b.ts - a.ts).slice(0, 20);
  }, [items]);

  if (sessions.length === 0) {
    return (
      <div className="trade-log trade-log-empty">
        <p className="cost">等待交易谈判…</p>
      </div>
    );
  }

  return (
    <div className="trade-log">
      {sessions.map((session) => {
        const started = session.started;
        const closed = session.closed;
        const statusClass = closed ? ` is-${closed.status}` : ' is-open';
        const lastLimits =
          closed?.limits ?? session.messages[session.messages.length - 1]?.limits ?? started?.limits;
        // 左侧竖线用本回合发起交易玩家（initiator）的颜色；缺 started 时回退到首位发言玩家
        const initiatorId =
          started?.initiator ?? session.messages.find((m) => m.speaker != null)?.speaker ?? null;
        const initiatorColor = initiatorId != null ? players[initiatorId]?.color : undefined;
        return (
          <div
            key={session.sessionId}
            className={`trade-session${statusClass}`}
            style={initiatorColor ? { borderLeftColor: initiatorColor } : undefined}
          >
            <div className="trade-session-head">
              <span className="trade-session-title">
                第 {started?.turn ?? closed?.turn ?? '?'} 回合
              </span>
              <span className="thought-tag thought-tag-prov">
                {closed ? tradeStatusLabel(closed.status) : '进行中'}
              </span>
              {started && (
                <span className="thought-tag">
                  {playerLabel(players, started.initiator)}
                </span>
              )}
            </div>
            {started && (
              <>
                <div className="trade-participants">
                  {started.participants.map((p) => playerLabel(players, p)).join(' / ')}
                </div>
                <TradeOfferLine offer={started.proposedTrade} players={players} />
              </>
            )}
            <div className="trade-messages">
              {session.messages.map((msg, idx) => (
                <div
                  key={`${msg.ts}-${idx}`}
                  className={`trade-message is-${msg.decision.toLowerCase().replace('_', '-')}`}
                >
                  <div className="trade-message-head">
                    <span className="player-dot" style={{ background: msg.speaker == null ? '#66513e' : players[msg.speaker]?.color }} />
                    <b>{playerLabel(players, msg.speaker)}</b>
                    <span>{decisionLabel(msg.decision)}</span>
                  </div>
                  <div className="trade-message-text">{msg.message}</div>
                  {msg.offer && <TradeOfferLine offer={msg.offer} players={players} />}
                  {(msg.modelContext || msg.rawOutput) && (
                    <TradeMessageDebug
                      modelContext={msg.modelContext}
                      rawOutput={msg.rawOutput}
                      provider={msg.provider}
                    />
                  )}
                </div>
              ))}
            </div>
            {closed && (
              <div className="trade-result">
                <b>{tradeStatusLabel(closed.status)}</b>
                <span>{closed.reason}</span>
                {closed.finalTrade && <TradeOfferLine offer={closed.finalTrade} players={players} />}
              </div>
            )}
            {lastLimits && <TradeLimitsLine limits={lastLimits} />}
          </div>
        );
      })}
    </div>
  );
}

// ---------- 日志 ----------

function LogContent({ state }: { state: FullGame['state'] }) {
  return (
    <div className="log">
      {state.log
        .slice(-60)
        .reverse()
        .map((l, i) => (
          <div key={i} className={l.turnMark ? 'turn-mark' : undefined}>
            {l.text}
          </div>
        ))}
    </div>
  );
}
