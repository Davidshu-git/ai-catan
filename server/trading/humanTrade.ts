// ============================================================
// 真人交互谈判：会话状态与无副作用推导
// ------------------------------------------------------------
// 编排（调用 LLM、emit socket、真正成交）放在 server/index.ts；
// 本模块只负责会话结构、报价校验和 standing deals 推导。
// ============================================================

import { reduce } from '../../shared/reducer';
import { playerDisplayName } from '../../shared/state';
import { RESOURCES, type Board, type GameState, type ResMap } from '../../shared/types';
import type {
  HumanStandingDeal,
  HumanTradeStateEvent,
  TradeChatMessageEvent,
  TradeOfferEvent,
} from '../../shared/protocol';

export const HUMAN_TRADE_LIMITS = {
  messagesPerSession: 8,
  maxGiveCards: 4,
};

/** 某 AI 参与方在本次谈判里的最新姿态，用于推导 standing deals */
export interface ParticipantStance {
  player: number;
  decision: 'ACCEPT' | 'REJECT' | 'COUNTER_OFFER' | null;
  /** COUNTER_OFFER 时：AI 视角的还价（AI 给 give、要 receive） */
  counter?: { give: ResMap; receive: ResMap; note: string };
}

export interface HumanTradeSession {
  sessionId: string;
  turn: number;
  initiator: number;
  participants: number[];
  /** 真人桌面报价：from=initiator, to=null；null 表示仅喊话 */
  currentOffer: TradeOfferEvent | null;
  messages: TradeChatMessageEvent[];
  stances: Record<number, ParticipantStance>;
  humanMessages: number;
  status: 'open' | 'closed';
  busy: boolean;
}

export function emptyRes(): ResMap {
  return { 木: 0, 砖: 0, 羊: 0, 麦: 0, 矿: 0 };
}

export function cloneRes(res: ResMap): ResMap {
  return { ...res };
}

export function cloneOffer(o: TradeOfferEvent): TradeOfferEvent {
  return { from: o.from, to: o.to, give: cloneRes(o.give), receive: cloneRes(o.receive) };
}

export function resTotal(res: ResMap): number {
  return RESOURCES.reduce((sum, r) => sum + (res[r] ?? 0), 0);
}

export function resStr(res: ResMap): string {
  return (
    RESOURCES.filter((r) => (res[r] ?? 0) > 0)
      .map((r) => `${r}×${res[r]}`)
      .join(' ') || '无'
  );
}

function has(state: GameState, player: number, res: ResMap): boolean {
  return RESOURCES.every((r) => state.players[player].resources[r] >= (res[r] ?? 0));
}

/** 校验真人报价；ok 返回 null，否则返回错误原因 */
export function validateHumanOffer(
  state: GameState,
  initiator: number,
  give: ResMap,
  receive: ResMap,
): string | null {
  const giveCount = resTotal(give);
  const receiveCount = resTotal(receive);
  if (giveCount === 0 && receiveCount === 0) return '报价不能为空：至少给出或索要 1 张资源。';
  if (giveCount > HUMAN_TRADE_LIMITS.maxGiveCards) {
    return `给出 ${giveCount} 张超过上限 ${HUMAN_TRADE_LIMITS.maxGiveCards} 张。`;
  }
  if (!has(state, initiator, give)) return '你没有足够的资源给出这笔报价。';
  return null;
}

function resourceSig(state: GameState): string {
  return state.players
    .map((p) => RESOURCES.map((r) => p.resources[r]).join(','))
    .join('|');
}

/** dry-run 一笔成交：双方资源足够且确实改变状态才算可成交 */
export function dryRunExecutable(
  board: Board,
  state: GameState,
  from: number,
  to: number,
  give: ResMap,
  receive: ResMap,
): boolean {
  if (resTotal(give) === 0 && resTotal(receive) === 0) return false;
  if (!has(state, from, give) || !has(state, to, receive)) return false;
  const next = reduce(board, state, {
    type: 'TRADE_EXECUTE',
    from,
    to,
    give: cloneRes(give),
    receive: cloneRes(receive),
  });
  return resourceSig(next) !== resourceSig(state);
}

/** 各 AI 姿态 → 真人可一键成交候选（真人视角） */
export function deriveStandingDeals(
  board: Board,
  state: GameState,
  session: HumanTradeSession,
): HumanStandingDeal[] {
  const deals: HumanStandingDeal[] = [];
  for (const player of session.participants) {
    if (!state.players[player]?.isAI) continue;
    const stance = session.stances[player];
    if (!stance) continue;
    if (stance.decision === 'ACCEPT' && session.currentOffer) {
      const give = cloneRes(session.currentOffer.give);
      const receive = cloneRes(session.currentOffer.receive);
      if (dryRunExecutable(board, state, session.initiator, player, give, receive)) {
        deals.push({
          player,
          give,
          receive,
          source: 'accept',
          note: `${nameOf(state, player)} 接受你的报价`,
        });
      }
      continue;
    }
    if (stance.decision === 'COUNTER_OFFER' && stance.counter) {
      // AI 还价是 AI 视角，转成真人视角时 give/receive 对调。
      const give = cloneRes(stance.counter.receive);
      const receive = cloneRes(stance.counter.give);
      if (dryRunExecutable(board, state, session.initiator, player, give, receive)) {
        deals.push({
          player,
          give,
          receive,
          source: 'counter',
          note: `${nameOf(state, player)} 还价：${stance.counter.note}`,
        });
      }
    }
  }
  return deals;
}

export function humanTradeStateEvent(
  board: Board,
  state: GameState,
  session: HumanTradeSession | null,
): HumanTradeStateEvent {
  if (!session || session.status !== 'open') return { active: false };
  return {
    active: true,
    sessionId: session.sessionId,
    turn: session.turn,
    initiator: session.initiator,
    participants: [...session.participants],
    currentOffer: session.currentOffer ? cloneOffer(session.currentOffer) : null,
    standingDeals: deriveStandingDeals(board, state, session),
    messagesUsed: session.humanMessages,
    messagesMax: HUMAN_TRADE_LIMITS.messagesPerSession,
    busy: session.busy,
  };
}

function nameOf(state: GameState, player: number): string {
  return playerDisplayName(state.players, player);
}
