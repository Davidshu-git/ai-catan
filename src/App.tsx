import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { Board, type BoardMode } from './components/Board';
import { robberCandidates, type Action } from '../shared/reducer';
import type {
  AiControlState,
  AiErrorEvent,
  AiModelContextEvent,
  AiTimingEvent,
  AiThoughtEvent,
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

const HUMAN = 0;

// 服务端地址：构建时由 Vite 注入 VITE_SERVER_URL；为空字符串则同源（生产 nginx 反代场景）
const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? '';

// 模块级单例：避免 React StrictMode 双重 mount 时重复建连
const socket: Socket = io(SERVER_URL, {
  path: '/socket.io/',
  transports: ['websocket', 'polling'],
});

// 人→AI 交易：服务端跑 aiAcceptsTrade，通过 ack 回调返回是否接受
function proposeHumanTrade(
  target: number,
  give: ResMap,
  receive: ResMap,
): Promise<boolean> {
  return new Promise((resolve) => {
    socket
      .timeout(2000)
      .emit(
        'propose_human_trade',
        { target, give, receive },
        (err: Error | null, res?: { accepted: boolean }) => {
          if (err || !res) resolve(false);
          else resolve(res.accepted);
        },
      );
  });
}

function costText(c: Partial<ResMap>): string {
  return RESOURCES.filter((r) => (c[r] ?? 0) > 0)
    .map((r) => `${RESOURCE_LABEL[r]}${c[r]! > 1 ? '×' + c[r] : ''}`)
    .join(' ');
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

type AiBoardFocus = { player: number; action: Action; ts: number };

const THOUGHT_LOG_MAX = 80;
const DEFAULT_AI_CONTROL: AiControlState = {
  autoplay: false,
  queued: false,
  busy: false,
  canStep: false,
  hintEnabled: true,
  provider: 'unknown',
};

// 左右分隔条：侧栏宽度上下限与持久化
const SIDEBAR_DEFAULT = 372;
const SIDEBAR_MIN = 280;
const SIDEBAR_MAX_RATIO = 0.7;
const SIDEBAR_STORAGE_KEY = 'catan-sidebar-width';

function readStoredSidebarWidth(): number {
  if (typeof window === 'undefined') return SIDEBAR_DEFAULT;
  const raw = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : SIDEBAR_DEFAULT;
}

export function App() {
  // 初始 null：等待服务端 sync_state；AI 驱动循环全部在服务端
  const [game, setGame] = useState<FullGame | null>(null);
  const [connected, setConnected] = useState(socket.connected);
  const [mode, setMode] = useState<BoardMode>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [thoughtLog, setThoughtLog] = useState<ThoughtLogItem[]>([]);
  const [aiFocus, setAiFocus] = useState<AiBoardFocus | null>(null);
  const [aiControl, setAiControl] = useState<AiControlState>(DEFAULT_AI_CONTROL);
  const [sidebarWidth, setSidebarWidth] = useState<number>(readStoredSidebarWidth);
  const draggingRef = useRef(false);

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

  const stepAi = useCallback(() => {
    socket
      .timeout(2000)
      .emit('step_ai', (err: Error | null, res?: { ok: boolean; reason?: string }) => {
        if (err || !res || !res.ok) {
          setToast(res?.reason ?? 'AI 暂时无法推进');
          setTimeout(() => setToast(null), 2200);
        }
      });
  }, []);

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
    const onThought = (ev: AiThoughtEvent) => {
      append({ kind: 'thought', data: ev });
      if (ev.action) setAiFocus({ player: ev.player, action: ev.action, ts: ev.ts });
    };
    const onError = (ev: AiErrorEvent) => append({ kind: 'error', data: ev });
    const onAiControl = (ev: AiControlState) => setAiControl(ev);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('sync_state', onSync);
    socket.on('ai_thought', onThought);
    socket.on('ai_error', onError);
    socket.on('ai_control_state', onAiControl);
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('sync_state', onSync);
      socket.off('ai_thought', onThought);
      socket.off('ai_error', onError);
      socket.off('ai_control_state', onAiControl);
    };
  }, []);

  // new_game 时本地也清掉历史思考日志（server 同步会再补当前 buffer）
  useEffect(() => {
    if (game && game.state.turn === 0 && game.state.phase === 'setup1' && game.state.setupIndex === 0) {
      setThoughtLog([]);
      setAiFocus(null);
    }
  }, [game?.state.turn, game?.state.phase, game?.state.setupIndex]);

  // AI 动作高亮只短暂停留，避免遮挡后续人工操作。
  useEffect(() => {
    if (!aiFocus) return;
    const t = setTimeout(() => setAiFocus(null), 1800);
    return () => clearTimeout(t);
  }, [aiFocus?.ts]);

  // ⚠️ 所有 hook 必须在 early return 之前调用（Rules of Hooks）
  const state = game?.state;
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
          <Players game={game} />
          <AiControls
            control={aiControl}
            connected={connected}
            onAutoplay={setAiAutoplay}
            onStep={stepAi}
            onToggleHint={setAiHint}
          />
          <Phase
            game={game}
            mode={mode}
            setMode={setMode}
            dispatch={dispatch}
            flash={flash}
          />
          <ThoughtLog items={thoughtLog} players={state.players} />
          <Log state={state} />
        </div>
      </aside>

      {toast && <div className="toast">{toast}</div>}

      {state.phase === 'gameOver' && state.winner != null && (
        <div className="modal-bg">
          <Confetti />
          <div className="modal">
            <h2>🏆 {state.players[state.winner].name} 获胜</h2>
            <p>
              {state.players[state.winner].name} 率先达到 10 分。
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
  onAutoplay,
  onStep,
  onToggleHint,
}: {
  control: AiControlState;
  connected: boolean;
  onAutoplay: (autoplay: boolean) => void;
  onStep: () => void;
  onToggleHint: (hint: boolean) => void;
}) {
  const waiting = control.queued || control.busy;
  const stepDisabled = !connected || control.autoplay || waiting || !control.canStep;
  const status = control.busy
    ? '思考中'
    : control.queued
      ? '已排队'
      : control.canStep
        ? '可推进'
        : '等待玩家';

  return (
    <div className="card">
      <h2>AI 控制</h2>
      <div className="ai-control-head">
        <span className={`tag${control.autoplay ? ' tag-on' : ''}`}>
          {control.autoplay ? '自动' : '手动'}
        </span>
        <span className="tag">{status}</span>
        <span className="tag">{control.provider}</span>
        <button
          type="button"
          className={`tag tag-btn${control.hintEnabled ? ' tag-on' : ''}`}
          disabled={!connected}
          onClick={() => onToggleHint(!control.hintEnabled)}
          title="切换是否在 LLM prompt 里塞空间动作 hint；A/B 实验用，仅影响后续决策"
        >
          hint {control.hintEnabled ? 'ON' : 'OFF'}
        </button>
        {control.currentAgent && (
          <span className="tag">
            {control.currentAgent.name} · 记忆 {control.currentAgent.memorySize}
          </span>
        )}
      </div>
      <div className="btn-grid">
        <button
          className={`btn${control.autoplay ? '' : ' primary'}`}
          disabled={!connected}
          onClick={() => onAutoplay(!control.autoplay)}
        >
          {control.autoplay ? '暂停' : '自动推进'}
        </button>
        <button className="btn" disabled={stepDisabled} onClick={onStep}>
          推进一步
        </button>
      </div>
    </div>
  );
}

// ---------- 玩家面板 ----------

function Players({ game }: { game: FullGame }) {
  const { board, state } = game;
  return (
    <div className="card">
      <h2>玩家</h2>
      <div className="players-grid">
        {state.players.map((pl) => {
          const vp = pl.isAI ? publicVP(state, pl.id) : totalVP(state, pl.id);
          const lr = longestRoadLength(board, state, pl.id);
          return (
            <div
              key={pl.id}
              className={`player-row${state.current === pl.id ? ' active' : ''}`}
            >
              <div className="player-head">
                <span className="player-dot" style={{ background: pl.color }} />
                <span className="player-name">{pl.name}</span>
                <span className="player-vp">
                  {vp}
                  <span>分</span>
                </span>
              </div>
              <div className="player-stats">
                <span>
                  <b>{handSize(pl)}</b>
                  手牌
                </span>
                <span>
                  <b>{pl.devCards.length + pl.newDevCards.length}</b>
                  卡
                </span>
                <span>
                  <b>{lr}</b>
                  路
                </span>
              </div>
              <div className="player-badges">
                {state.longestRoad.player === pl.id && <span className="badge">最长路</span>}
                {state.largestArmy.player === pl.id && <span className="badge">最大军队</span>}
                {pl.knightsPlayed > 0 && <span className="badge">骑士 {pl.knightsPlayed}</span>}
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
}: {
  game: FullGame;
  mode: BoardMode;
  setMode: (m: BoardMode) => void;
  dispatch: (a: Action) => void;
  flash: (m: string) => void;
}) {
  const { board, state } = game;
  const human = state.players.find((p) => !p.isAI) ?? null;
  const me = human ?? state.players[HUMAN];
  const isHumanTurn = state.players[state.current]?.isAI === false;

  // 资源增加时脉冲高亮
  const prevRes = useRef<ResMap>({ ...me.resources });
  const [glow, setGlow] = useState<Resource[]>([]);
  useEffect(() => {
    const gained = RESOURCES.filter((r) => me.resources[r] > prevRes.current[r]);
    prevRes.current = { ...me.resources };
    if (gained.length === 0) return;
    setGlow(gained);
    const t = setTimeout(() => setGlow([]), 650);
    return () => clearTimeout(t);
  }, [
    me.resources.木,
    me.resources.砖,
    me.resources.羊,
    me.resources.麦,
    me.resources.矿,
  ]);

  // 等待 AI
  const aiActing =
    !isHumanTurn &&
    state.phase !== 'gameOver' &&
    !(human && state.phase === 'discard' && state.discardLeft[human.id] != null) &&
    !(human && state.pendingTrade && state.pendingTrade.to === human.id);

  return (
    <>
      {/* 自己的资源 */}
      <div className="card">
        <h2>{human ? '我的资源' : `${me.name} 资源`}</h2>
        <div className="res-bar">
          {RESOURCES.map((r) => (
            <span key={r} className={`res-pill${glow.includes(r) ? ' gain' : ''}`}>
              <ResIcon r={r} />
              {me.resources[r]}
            </span>
          ))}
        </div>
      </div>

      {state.dice && (
        <div className="card">
          <h2>骰子</h2>
          <div className="dice">
            <Die key={`d1-${state.turn}-${state.dice[0]}-${state.dice[1]}`} v={state.dice[0]} />
            <Die key={`d2-${state.turn}-${state.dice[0]}-${state.dice[1]}`} v={state.dice[1]} />
            <span className="dice-sum">= {state.dice[0] + state.dice[1]}</span>
          </div>
        </div>
      )}

      {aiActing && (
        <div className="hint">
          {human ? 'AI 正在行动中…' : `${state.players[state.current].name} 等待控制面板推进…`}
        </div>
      )}

      {/* 弃牌（玩家） */}
      {human && state.phase === 'discard' && state.discardLeft[human.id] != null && (
        <DiscardPanel state={state} dispatch={dispatch} />
      )}

      {/* AI 向我提议交易 */}
      {human && state.pendingTrade && state.pendingTrade.to === human.id && (
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
                偷 {state.players[c].name}（{handSize(state.players[c])} 张）
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 主阶段操作 */}
      {state.phase === 'main' && isHumanTurn && (
        <MainActions
          game={game}
          mode={mode}
          setMode={setMode}
          dispatch={dispatch}
          flash={flash}
        />
      )}
    </>
  );
}

// ---------- 主阶段操作 ----------

function MainActions({
  game,
  mode,
  setMode,
  dispatch,
  flash,
}: {
  game: FullGame;
  mode: BoardMode;
  setMode: (m: BoardMode) => void;
  dispatch: (a: Action) => void;
  flash: (m: string) => void;
}) {
  const { state } = game;
  const me = state.players[HUMAN];
  const afford = (c: Partial<ResMap>) => RESOURCES.every((r) => me.resources[r] >= (c[r] ?? 0));

  return (
    <>
      <div className="card">
        <h2>建造{state.freeRoads > 0 ? ` · 免费路 ×${state.freeRoads}` : ''}</h2>
        <div className="btn-grid">
          <button
            className={`btn${mode === 'road' ? ' primary' : ''}`}
            disabled={state.freeRoads === 0 && !afford(COSTS.road)}
            onClick={() => setMode(mode === 'road' ? null : 'road')}
          >
            修路<span className="cost">{costText(COSTS.road)}</span>
          </button>
          <button
            className={`btn${mode === 'settlement' ? ' primary' : ''}`}
            disabled={!afford(COSTS.settlement)}
            onClick={() => setMode(mode === 'settlement' ? null : 'settlement')}
          >
            建房屋<span className="cost">{costText(COSTS.settlement)}</span>
          </button>
          <button
            className={`btn${mode === 'city' ? ' primary' : ''}`}
            disabled={!afford(COSTS.city)}
            onClick={() => setMode(mode === 'city' ? null : 'city')}
          >
            升级城市<span className="cost">{costText(COSTS.city)}</span>
          </button>
          <button
            className="btn"
            disabled={!afford(COSTS.dev) || state.devDeck.length === 0}
            onClick={() => dispatch({ type: 'BUY_DEV' })}
          >
            买发展卡<span className="cost">{costText(COSTS.dev)}</span>
          </button>
        </div>
        {mode && (
          <p className="cost" style={{ marginTop: 8 }}>
            已进入「{mode === 'road' ? '修路' : mode === 'settlement' ? '建房屋' : '升级城市'}」模式，点击棋盘上的高亮位置。再次点击按钮取消。
          </p>
        )}
      </div>

      <DevCards state={state} dispatch={dispatch} />

      <BankTrade game={game} dispatch={dispatch} />

      <PlayerTrade game={game} flash={flash} />

      <button className="btn warn" onClick={() => dispatch({ type: 'END_TURN' })}>
        结束回合
      </button>
    </>
  );
}

// ---------- 发展卡 ----------

function DevCards({ state, dispatch }: { state: FullGame['state']; dispatch: (a: Action) => void }) {
  const me = state.players[HUMAN];
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

function BankTrade({ game, dispatch }: { game: FullGame; dispatch: (a: Action) => void }) {
  const { board, state } = game;
  const [give, setGive] = useState<Resource>('木');
  const [recv, setRecv] = useState<Resource>('矿');
  const ratio = tradeRatio(board, state, HUMAN, give);
  const me = state.players[HUMAN];
  const ok = give !== recv && me.resources[give] >= ratio && state.bank[recv] > 0;

  return (
    <div className="card">
      <h2>银行 / 港口交易</h2>
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
      <p className="cost">当前 {RESOURCE_LABEL[give]} 兑换比率 {ratio}:1（港口可降低）</p>
    </div>
  );
}

// ---------- 玩家交易 ----------

function PlayerTrade({
  game,
  flash,
}: {
  game: FullGame;
  flash: (m: string) => void;
}) {
  const { state } = game;
  const me = state.players[HUMAN];
  const [give, setGive] = useState<ResMap>(emptyRes());
  const [recv, setRecv] = useState<ResMap>(emptyRes());
  const [target, setTarget] = useState<number>(1);
  const [pending, setPending] = useState(false);

  const propose = async () => {
    const gN = RESOURCES.reduce((t, r) => t + give[r], 0);
    const rN = RESOURCES.reduce((t, r) => t + recv[r], 0);
    if (gN === 0 && rN === 0) {
      flash('请先设置交易内容');
      return;
    }
    setPending(true);
    const accepted = await proposeHumanTrade(target, give, recv);
    setPending(false);
    if (accepted) {
      flash(`${state.players[target].name} 接受了交易`);
      setGive(emptyRes());
      setRecv(emptyRes());
    } else {
      flash(`${state.players[target].name} 拒绝了交易`);
    }
  };

  return (
    <div className="card">
      <h2>与 AI 玩家交易</h2>
      <div className="tag-row" style={{ marginBottom: 8 }}>
        {state.players
          .filter((p) => p.id !== HUMAN)
          .map((p) => (
            <button
              key={p.id}
              className={`btn${target === p.id ? ' primary' : ''}`}
              style={{ padding: '5px 10px' }}
              onClick={() => setTarget(p.id)}
            >
              {p.name}
            </button>
          ))}
      </div>
      <p className="cost">我给出：</p>
      <div className="trade-grid">
        {RESOURCES.map((r) => (
          <div key={r} className="trade-cell">
            <ResIcon r={r} size={18} />
            <Stepper
              value={give[r]}
              max={me.resources[r]}
              onChange={(v) => setGive((g) => ({ ...g, [r]: v }))}
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
            <ResIcon r={r} size={18} />
            <Stepper
              value={recv[r]}
              max={19}
              onChange={(v) => setRecv((g) => ({ ...g, [r]: v }))}
            />
          </div>
        ))}
      </div>
      <button
        className="btn"
        style={{ marginTop: 10, width: '100%' }}
        onClick={propose}
        disabled={pending}
      >
        {pending ? '等待对方应答…' : '提议交易'}
      </button>
    </div>
  );
}

// ---------- 弃牌面板 ----------

function DiscardPanel({
  state,
  dispatch,
}: {
  state: FullGame['state'];
  dispatch: (a: Action) => void;
}) {
  const me = state.players[HUMAN];
  const need = state.discardLeft[HUMAN];
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
        onClick={() => dispatch({ type: 'DISCARD', player: HUMAN, cards: sel })}
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
      <h2>{state.players[t.from].name} 的交易提议</h2>
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
        <span>view {countText(context.chars.view)}</span>
        <span>actions {countText(context.chars.legalActions)}</span>
        {context.chars.system != null && <span>system {countText(context.chars.system)}</span>}
        {context.chars.user != null && <span>user {countText(context.chars.user)}</span>}
      </div>
      <ModelContextBlock title="system" text={context.systemPrompt} />
      <ModelContextBlock title="user" text={context.userPrompt} />
      <ModelContextBlock title="provider input" text={context.providerInputJson} />
    </details>
  );
}

function ThoughtLog({
  items,
  players,
}: {
  items: ThoughtLogItem[];
  players: FullGame['state']['players'];
}) {
  const reversed = [...items].slice(-50).reverse();
  return (
    <div className="card">
      <h2>AI 思考流</h2>
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
                  <div className="thought-action">→ {t.actionSummary}</div>
                  {t.actionHint && (
                    <div className="thought-hint" title="该动作的语义化情报（喂给 LLM 的 hint）">
                      ◇ {t.actionHint}
                    </div>
                  )}
                  {t.timing && <TimingPanel timing={t.timing} />}
                  {t.modelContext && <ModelContextPanel context={t.modelContext} />}
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
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------- 日志 ----------

function Log({ state }: { state: FullGame['state'] }) {
  return (
    <div className="card">
      <h2>对局日志</h2>
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
    </div>
  );
}
