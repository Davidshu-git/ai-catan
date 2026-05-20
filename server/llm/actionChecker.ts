// ============================================================
// Maker-Checker：三层校验 Provider 的决策输出
// ------------------------------------------------------------
//   1) JSON schema：必须有 thought:string + actionId:string
//   2) 白名单：actionId 必须存在于 legalActions
//   3) dry-run reducer：在副本上跑一次，状态指纹必须有变化
// 不让 reducer 抛异常、不改静默 no-op 契约；校验失败返回结构化错误
// 由 Controller 反馈给 Provider 重试。
// ============================================================

import type { Board, GameState } from '../../shared/types';
import { RESOURCES } from '../../shared/types';
import { reduce } from '../../shared/reducer';
import type { LegalAction, LlmDecisionOutput } from './types';

export type CheckResult =
  | { ok: true; action: LegalAction; nextState: GameState }
  | { ok: false; code: CheckErrorCode; message: string };

export type CheckErrorCode =
  | 'BAD_JSON'
  | 'UNKNOWN_ACTION_ID'
  | 'NO_STATE_CHANGE'
  | 'EMPTY_CATALOG';

// 单步级敏感指纹：必须能区分发展卡打出（哪怕没改资源）、freeRoads、devPlayed
// 等仅靠粗指纹会漏掉的"小变化"。否则像 PLAY_MONOPOLY(无人有)、PLAY_ROAD_BUILDING
// 这种合法但不改资源总数的动作会被误判为 NO_STATE_CHANGE。
function fingerprint(s: GameState): string {
  return [
    s.turn,
    s.phase,
    s.current,
    s.devPlayed ? 1 : 0,
    s.freeRoads,
    Object.keys(s.buildings).length,
    Object.keys(s.roads).length,
    s.players
      .map((p) =>
        [
          RESOURCES.reduce((t, r) => t + p.resources[r], 0),
          p.devCards.length,
          p.newDevCards.length,
          p.knightsPlayed,
          p.vpCards,
        ].join(':'),
      )
      .join(','),
    s.devDeck.length,
    s.robber,
    s.dice ? `${s.dice[0]}-${s.dice[1]}` : 'none',
    Object.keys(s.discardLeft).length,
    s.pendingTrade ? 'pt' : 'nopt',
    s.longestRoad.player ?? '-',
    s.longestRoad.len,
    s.largestArmy.player ?? '-',
    s.largestArmy.size,
  ].join('|');
}

/** 跑一次完整校验链路；通过则返回新状态供 applyAction 直接采用 */
export function checkDecision(
  board: Board,
  state: GameState,
  output: LlmDecisionOutput | null | undefined,
  legalActions: LegalAction[],
): CheckResult {
  // 0) 空目录：phase 不应该决策，由上层处理
  if (legalActions.length === 0) {
    return { ok: false, code: 'EMPTY_CATALOG', message: '当前阶段没有可选动作' };
  }
  // 1) JSON schema：缺字段 / 类型错
  if (
    !output ||
    typeof output !== 'object' ||
    typeof output.thought !== 'string' ||
    typeof output.actionId !== 'string' ||
    output.actionId.length === 0
  ) {
    return {
      ok: false,
      code: 'BAD_JSON',
      message: 'Provider 输出格式错误：必须含 thought:string + actionId:string',
    };
  }
  // 2) 白名单
  const la = legalActions.find((x) => x.id === output.actionId);
  if (!la) {
    return {
      ok: false,
      code: 'UNKNOWN_ACTION_ID',
      message: `actionId="${output.actionId}" 不在合法动作列表中`,
    };
  }
  // 3) dry-run reducer：状态必须变
  const beforeSig = fingerprint(state);
  const nextState = reduce(board, state, la.action);
  const afterSig = fingerprint(nextState);
  if (beforeSig === afterSig) {
    return {
      ok: false,
      code: 'NO_STATE_CHANGE',
      message: `动作 ${output.actionId} 被 reducer no-op（dry-run 状态未变）`,
    };
  }
  return { ok: true, action: la, nextState };
}
