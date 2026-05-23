// ============================================================
// 交易房间共享原语（Phase B.2）
// ------------------------------------------------------------
// AI↔AI（negotiationManager，同步多轮）与 人↔AI（humanTrade，交互式异步）
// 两个驱动共用同一套"资源 + 成交校验"原语，避免各写一份导致漂移——
// 尤其 dryRunTrade 的"资源守恒不变量"必须只有一份实现。
// 两个驱动的控制流不同（同步 vs 等人输入），故仍各自保留；这里只统一原语。
// ============================================================

import { reduce, type Action } from '../../shared/reducer';
import {
  RESOURCES,
  RESOURCE_LABEL,
  emptyRes,
  type Board,
  type GameState,
  type ResMap,
} from '../../shared/types';
import type { TradeOfferEvent } from '../../shared/protocol';

export { emptyRes };

export function cloneRes(res: ResMap): ResMap {
  return { ...res };
}

export function cloneOffer(offer: TradeOfferEvent): TradeOfferEvent {
  return {
    from: offer.from,
    to: offer.to,
    give: cloneRes(offer.give),
    receive: cloneRes(offer.receive),
  };
}

export function resTotal(res: ResMap): number {
  return RESOURCES.reduce((s, r) => s + (res[r] ?? 0), 0);
}

export function resStr(m: ResMap): string {
  return (
    RESOURCES.filter((r) => m[r] > 0)
      .map((r) => `${RESOURCE_LABEL[r]}×${m[r]}`)
      .join(' ') || '无'
  );
}

export function hasResources(state: GameState, player: number, res: ResMap): boolean {
  return RESOURCES.every((r) => state.players[player].resources[r] >= (res[r] ?? 0));
}

/** 全玩家资源指纹，用于判断一笔交易是否真的改变了状态 */
export function resourceSignature(state: GameState): string {
  return state.players
    .map((p) => RESOURCES.map((r) => p.resources[r]).join(','))
    .join('|');
}

/**
 * 统一的成交 dry-run：to 为空 / 任一方资源不足 / 状态指纹无变化 → null；
 * 否则返回经 reducer 成交后的新状态。守住"每种资源 bank+玩家恒 19"的唯一实现入口。
 */
export function dryRunTrade(
  board: Board,
  state: GameState,
  trade: TradeOfferEvent,
): GameState | null {
  if (trade.to == null) return null;
  if (!hasResources(state, trade.from, trade.give)) return null;
  if (!hasResources(state, trade.to, trade.receive)) return null;
  const action: Action = {
    type: 'TRADE_EXECUTE',
    from: trade.from,
    to: trade.to,
    give: cloneRes(trade.give),
    receive: cloneRes(trade.receive),
  };
  const before = resourceSignature(state);
  const next = reduce(board, state, action);
  return resourceSignature(next) === before ? null : next;
}
