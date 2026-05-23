// ============================================================
// 多轮房间式谈判冒烟：注入假的 tradeDecide/tradeInitiate 驱动 maybeRunAiNegotiation，
// 断言①多轮反应 ②竞争择优只成交一笔 ③资源守恒。sim 触不到 server 谈判层，这里补上。
// 运行：docker run --rm -v "$PWD":/app -w /app node:20-alpine npx --yes tsx server/trading/negotiationSmoke.ts
// ============================================================

import { createGame } from '../../shared/state';
import { RESOURCES, type Board, type GameState, type ResMap } from '../../shared/types';
import {
  createAiTradeLedger,
  maybeRunAiNegotiation,
  type TradeDecideFn,
  type TradeEventEntry,
  type TradeInitiateFn,
  type TradeProposeMessageFn,
} from './negotiationManager';
import { buildCounterCandidates } from '../llm/tradeProvider';

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failures++;
}

function emptyRes(): ResMap {
  return { 木: 0, 砖: 0, 羊: 0, 麦: 0, 矿: 0 };
}

/** 全资源总量（所有玩家 + bank），逐种返回，用于守恒断言 */
function totals(state: GameState): ResMap {
  const t = emptyRes();
  for (const r of RESOURCES) {
    t[r] = state.bank[r] + state.players.reduce((s, p) => s + p.resources[r], 0);
  }
  return t;
}

function sameTotals(a: ResMap, b: ResMap): boolean {
  return RESOURCES.every((r) => a[r] === b[r]);
}

/** 4 AI、main 阶段、P0 持矿想换木；P1/P2/P3 各有木可成交 */
function makeScene(): { board: Board; state: GameState } {
  const { board, state } = createGame();
  state.phase = 'main';
  state.current = 0;
  state.players.forEach((p) => (p.isAI = true));
  // 从 bank 取资源给玩家，保持总量守恒
  const grant = (player: number, r: keyof ResMap, n: number) => {
    state.players[player].resources[r] += n;
    state.bank[r] -= n;
  };
  grant(0, '矿', 2); // 发起方有矿可给
  grant(1, '木', 2);
  grant(2, '木', 2);
  grant(3, '木', 2);
  return { board, state };
}

const initiate: TradeInitiateFn = async () => ({
  initiate: true,
  give: { ...emptyRes(), 矿: 1 },
  receive: { ...emptyRes(), 木: 1 },
  message: 'P0：我用矿换木，谁来？',
  provider: 'smoke',
});

const propose: TradeProposeMessageFn = async (_id, _plan, _offer, _parts, fallback) => ({
  message: fallback,
  provider: 'smoke',
});

const noAgent = () => undefined;
const collect = (events: TradeEventEntry[]) => (e: TradeEventEntry) => events.push(e);

function firstCounterId(state: GameState, offer: { from: number; to: number | null; give: ResMap; receive: ResMap }): string | undefined {
  const direct = { from: offer.from, to: 0, give: { ...offer.give }, receive: { ...offer.receive } };
  return buildCounterCandidates(state, direct)[0]?.id;
}

async function run() {
  // ── 场景 1：竞争性接受 —— P1、P2 都接受底价，只能成交一笔，资源守恒 ──
  {
    const { board, state } = makeScene();
    const before = totals(state);
    const ledger = createAiTradeLedger();
    const events: TradeEventEntry[] = [];
    const decide: TradeDecideFn = async (responderId) => {
      if (responderId === 1 || responderId === 2) {
        return { decision: 'ACCEPT', message: `P${responderId} 接受`, provider: 'smoke' };
      }
      return { decision: 'REJECT', message: `P${responderId} 拒绝`, provider: 'smoke' };
    };
    const result = await maybeRunAiNegotiation(board, state, ledger, decide, propose, initiate, noAgent, collect(events));
    const closed = events.find((e) => e.kind === 'closed');
    const accepts = events.filter((e) => e.kind === 'message' && e.data.decision === 'ACCEPT');
    check('场景1：达成成交（nextState 非空）', Boolean(result && result.nextState));
    check('场景1：closed 状态为 accepted', closed?.kind === 'closed' && closed.data.status === 'accepted');
    check('场景1：只成交一笔（acceptedTrade 唯一）', Boolean(result?.acceptedTrade));
    check('场景1：至少一方接受、但不超过两条 ACCEPT 消息', accepts.length >= 1 && accepts.length <= 2);
    if (result?.nextState) {
      check('场景1：资源守恒（玩家+bank 各资源总量不变）', sameTotals(before, totals(result.nextState)));
      // 只有发起方 + 一个参与方的资源变化
      const changed = result.nextState.players.filter(
        (p) => RESOURCES.some((r) => p.resources[r] !== state.players[p.id].resources[r]),
      );
      check('场景1：恰好两名玩家资源变化', changed.length === 2);
    }
  }

  // ── 场景 2：还价 → 发起方接受 ──
  {
    const { board, state } = makeScene();
    const before = totals(state);
    const ledger = createAiTradeLedger();
    const events: TradeEventEntry[] = [];
    const decide: TradeDecideFn = async (responderId, _b, st, offer) => {
      if (responderId === 0) return { decision: 'ACCEPT', message: 'P0 接受还价', provider: 'smoke' };
      if (responderId === 1) {
        const cid = firstCounterId(st, offer);
        if (cid) return { decision: 'COUNTER_OFFER', counterId: cid, message: 'P1 还价', provider: 'smoke' };
      }
      return { decision: 'REJECT', message: `P${responderId} 拒绝`, provider: 'smoke' };
    };
    const result = await maybeRunAiNegotiation(board, state, ledger, decide, propose, initiate, noAgent, collect(events));
    const counters = events.filter((e) => e.kind === 'message' && e.data.decision === 'COUNTER_OFFER');
    check('场景2：发起方接受还价、成交', Boolean(result && result.nextState));
    check('场景2：出现过 COUNTER_OFFER 消息', counters.length >= 1);
    if (result?.nextState) {
      check('场景2：资源守恒', sameTotals(before, totals(result.nextState)));
    }
  }

  // ── 场景 3：多轮 —— P1/P2 还价被发起方拒，P2 第二轮改为接受底价 ──
  {
    const { board, state } = makeScene();
    const ledger = createAiTradeLedger();
    const events: TradeEventEntry[] = [];
    const p2Calls: number[] = [];
    const decide: TradeDecideFn = async (responderId, _b, st, offer, history) => {
      if (responderId === 0) {
        // 发起方对任何还价都拒绝
        return { decision: 'REJECT', message: 'P0 拒绝还价', provider: 'smoke' };
      }
      if (responderId === 2) {
        p2Calls.push(history.length);
        // 第一次还价，第二次（被叫到时已是第 2 轮）接受底价
        if (p2Calls.length === 1) {
          const cid = firstCounterId(st, offer);
          if (cid) return { decision: 'COUNTER_OFFER', counterId: cid, message: 'P2 还价', provider: 'smoke' };
        }
        return { decision: 'ACCEPT', message: 'P2 第二轮接受底价', provider: 'smoke' };
      }
      if (responderId === 1) {
        const cid = firstCounterId(st, offer);
        if (cid) return { decision: 'COUNTER_OFFER', counterId: cid, message: 'P1 还价', provider: 'smoke' };
      }
      return { decision: 'REJECT', message: `P${responderId} 拒绝`, provider: 'smoke' };
    };
    const result = await maybeRunAiNegotiation(board, state, ledger, decide, propose, initiate, noAgent, collect(events));
    check('场景3：P2 被叫到至少两轮（多轮反应生效）', p2Calls.length >= 2);
    check('场景3：最终在第二轮接受底价成交', Boolean(result && result.nextState));
  }

  console.log(failures === 0 ? '\n✅ 多轮谈判冒烟全部通过' : `\n❌ ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
