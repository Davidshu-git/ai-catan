import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Board, type BoardMode } from './components/Board';
import { createGame } from './game/state';
import { reduce, robberCandidates, type Action } from './game/reducer';
import { aiAcceptsTrade, aiNextAction } from './game/ai';
import {
  handSize,
  longestRoadLength,
  publicVP,
  totalVP,
  tradeRatio,
} from './game/rules';
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
} from './game/types';

const HUMAN = 0;

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
        <circle key={i} cx={9 + gx * 14} cy={9 + gy * 14} r={4.4} fill="#3a2f28" />
      ))}
    </svg>
  );
}

const CONFETTI_COLORS = ['#ff9f1c', '#2ec4b6', '#ef5d60', '#4aa3ff', '#9bd96f', '#f4c93c'];

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

export function App() {
  const [game, setGame] = useState<FullGame>(() => createGame());
  const [mode, setMode] = useState<BoardMode>(null);
  const [toast, setToast] = useState<string | null>(null);

  const { board, state } = game;

  const dispatch = useCallback((a: Action) => {
    setGame((g) => ({ board: g.board, state: reduce(g.board, g.state, a) }));
  }, []);

  const flash = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 2200);
  }, []);

  // AI 驱动循环（带无进展兜底，防止 AI 空转冻结）
  const stall = useRef({ sig: '', count: 0 });
  useEffect(() => {
    if (state.phase === 'gameOver') return;
    const next = aiNextAction(board, state);
    if (!next) {
      stall.current = { sig: '', count: 0 };
      return;
    }
    const sig = `${state.turn}|${state.phase}|${state.current}|${
      Object.keys(state.buildings).length
    }|${Object.keys(state.roads).length}|${state.players
      .map((p) => p.resources.wood + p.resources.brick + p.resources.sheep + p.resources.wheat + p.resources.ore)
      .join(',')}|${state.devDeck.length}`;
    if (sig === stall.current.sig) stall.current.count++;
    else stall.current = { sig, count: 0 };

    // 同一局面连续多次无进展：强制结束当前回合，避免界面冻结
    if (stall.current.count >= 8) {
      stall.current = { sig: '', count: 0 };
      if (state.phase === 'main') {
        const t = setTimeout(() => dispatch({ type: 'END_TURN' }), 200);
        return () => clearTimeout(t);
      }
      return;
    }
    const t = setTimeout(() => dispatch(next), 460);
    return () => clearTimeout(t);
  }, [game, board, state, dispatch]);

  const isHumanTurn = state.current === HUMAN;
  const isSetup = state.phase === 'setup1' || state.phase === 'setup2';

  const boardMode: BoardMode = useMemo(() => {
    if (state.phase === 'gameOver') return null;
    if (isSetup && isHumanTurn) return state.setupStep === 'settlement' ? 'settlement' : 'road';
    if (state.phase === 'moveRobber' && isHumanTurn) return 'robber';
    if (state.phase === 'main' && isHumanTurn) return mode;
    return null;
  }, [state.phase, state.setupStep, isSetup, isHumanTurn, mode]);

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
    setGame(createGame());
    setMode(null);
  };

  return (
    <div className="app">
      <div className="board-area">
        <div className="board-wrap">
          <Board
            board={board}
            state={state}
            mode={boardMode}
            onVertex={onVertex}
            onEdge={onEdge}
            onHex={onHex}
          />
        </div>
      </div>

      <aside className="sidebar">
        <h1>
          卡坦岛 · Catan
          <small>
            第 {Math.max(state.turn, 0)} 回合
            <button className="btn" style={{ marginLeft: 8, padding: '4px 10px' }} onClick={newGame}>
              新游戏
            </button>
          </small>
        </h1>

        <div className="sidebar-scroll">
          <Players game={game} />
          <Phase
            game={game}
            mode={mode}
            setMode={setMode}
            dispatch={dispatch}
            flash={flash}
          />
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

// ---------- 玩家面板 ----------

function Players({ game }: { game: FullGame }) {
  const { board, state } = game;
  return (
    <div className="card">
      <h2>玩家</h2>
      {state.players.map((pl) => {
        const vp = pl.id === HUMAN ? totalVP(state, pl.id) : publicVP(state, pl.id);
        const lr = longestRoadLength(board, state, pl.id);
        return (
          <div
            key={pl.id}
            className={`player-row${state.current === pl.id ? ' active' : ''}`}
            style={{ flexWrap: 'wrap' }}
          >
            <span className="player-dot" style={{ background: pl.color }} />
            <span className="player-name">
              {pl.name}
              {pl.id === HUMAN ? '' : ''}
            </span>
            <span className="player-vp">
              {vp}
              <span style={{ color: 'var(--muted)', fontWeight: 400 }}> 分</span>
            </span>
            <div className="player-meta">
              手牌 {handSize(pl)} · 发展卡 {pl.devCards.length + pl.newDevCards.length} · 路 {lr}
              {state.longestRoad.player === pl.id && <span className="badge">最长路 +2</span>}
              {state.largestArmy.player === pl.id && <span className="badge">最大军队 +2</span>}
              {pl.knightsPlayed > 0 && <span className="badge">骑士 {pl.knightsPlayed}</span>}
            </div>
          </div>
        );
      })}
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
  const me = state.players[HUMAN];
  const isHumanTurn = state.current === HUMAN;

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
    me.resources.wood,
    me.resources.brick,
    me.resources.sheep,
    me.resources.wheat,
    me.resources.ore,
  ]);

  // 等待 AI
  const aiActing =
    !isHumanTurn &&
    state.phase !== 'gameOver' &&
    !(state.phase === 'discard' && state.discardLeft[HUMAN] != null) &&
    !(state.pendingTrade && state.pendingTrade.to === HUMAN);

  return (
    <>
      {/* 自己的资源 */}
      <div className="card">
        <h2>我的资源</h2>
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

      {aiActing && <div className="hint">AI 正在行动中…</div>}

      {/* 弃牌（玩家） */}
      {state.phase === 'discard' && state.discardLeft[HUMAN] != null && (
        <DiscardPanel state={state} dispatch={dispatch} />
      )}

      {/* AI 向我提议交易 */}
      {state.pendingTrade && state.pendingTrade.to === HUMAN && (
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
            {me.devCards.includes('knight') && !state.devPlayed && (
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

      <PlayerTrade game={game} dispatch={dispatch} flash={flash} />

      <button className="btn warn" onClick={() => dispatch({ type: 'END_TURN' })}>
        结束回合
      </button>
    </>
  );
}

// ---------- 发展卡 ----------

function DevCards({ state, dispatch }: { state: FullGame['state']; dispatch: (a: Action) => void }) {
  const me = state.players[HUMAN];
  const [yop, setYop] = useState<[Resource, Resource]>(['wood', 'brick']);
  const [mono, setMono] = useState<Resource>('wood');

  const counts: Record<DevCard, number> = {
    knight: 0,
    victory: 0,
    roadBuilding: 0,
    yearOfPlenty: 0,
    monopoly: 0,
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
        <button className="btn" disabled={!can('knight')} onClick={() => dispatch({ type: 'PLAY_KNIGHT' })}>
          打出骑士（移动强盗）
        </button>
        <button
          className="btn"
          disabled={!can('roadBuilding')}
          onClick={() => dispatch({ type: 'PLAY_ROAD_BUILDING' })}
        >
          打出修路（免费 2 条路）
        </button>
        {counts.yearOfPlenty > 0 && (
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
                disabled={!can('yearOfPlenty')}
                onClick={() =>
                  dispatch({ type: 'PLAY_YEAR_OF_PLENTY', r1: yop[0], r2: yop[1] })
                }
              >
                打出丰收
              </button>
            </div>
          </div>
        )}
        {counts.monopoly > 0 && (
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
              disabled={!can('monopoly')}
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
  const [give, setGive] = useState<Resource>('wood');
  const [recv, setRecv] = useState<Resource>('ore');
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
  dispatch,
  flash,
}: {
  game: FullGame;
  dispatch: (a: Action) => void;
  flash: (m: string) => void;
}) {
  const { state } = game;
  const me = state.players[HUMAN];
  const [give, setGive] = useState<ResMap>(emptyRes());
  const [recv, setRecv] = useState<ResMap>(emptyRes());
  const [target, setTarget] = useState<number>(1);

  const propose = () => {
    const accepted = aiAcceptsTrade(state, target, give, recv);
    const gN = RESOURCES.reduce((t, r) => t + give[r], 0);
    const rN = RESOURCES.reduce((t, r) => t + recv[r], 0);
    if (gN === 0 && rN === 0) {
      flash('请先设置交易内容');
      return;
    }
    if (accepted) {
      dispatch({ type: 'TRADE_EXECUTE', from: HUMAN, to: target, give, receive: recv });
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
      <button className="btn" style={{ marginTop: 10, width: '100%' }} onClick={propose}>
        提议交易
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
