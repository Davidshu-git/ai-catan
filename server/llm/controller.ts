// ============================================================
// AI 决策控制器：决定一步 AI 该做什么、并把广播事件准备好
// ------------------------------------------------------------
// 编排顺序：
//   gameOver / 人类回合 → 不动
//   discard 阶段 → rule AI 兜底（不喂 LLM，避免组合爆炸）
//   其他阶段 → catalog + view + provider + checker，失败重试，再失败 fallback 到 rule
// 永远不抛异常给上层（scheduleAI 期望同步可控）；
// 极端兜底：连续失败时返回 END_TURN（仅 main 可用），否则返回 human-turn
// ============================================================

import type { Board, GameState } from '../../shared/types';
import { reduce } from '../../shared/reducer';
import { aiNextAction } from '../../shared/ai';
import { buildActionCatalog } from './actionCatalog';
import { buildPlayerView } from './stateTranslator';
import { checkDecision } from './actionChecker';
import { createRuleProvider, findLegalActionFor } from './ruleProvider';
import type {
  AiDecisionProvider,
  AiErrorEvent,
  AiThoughtEvent,
  LegalAction,
  LlmDecisionOutput,
  RetryFeedback,
} from './types';

const MAX_PROVIDER_RETRIES = 2;

export type StepOutcome =
  | { kind: 'human-turn' }
  | { kind: 'game-over' }
  | {
      kind: 'applied';
      nextState: GameState;
      thought: AiThoughtEvent;
      errors: AiErrorEvent[]; // 重试过程中收集的错误，仍可广播给前端
    }
  | {
      kind: 'forced-end-turn';
      nextState: GameState;
      errors: AiErrorEvent[];
    };

/**
 * 决定下一步 AI 动作并应用到副本。reducer 在 dry-run 时已经跑过，
 * 这里直接拿 dry-run 的 nextState（reducer 是纯函数，等价）。
 */
export async function decideAiStep(
  board: Board,
  state: GameState,
  provider: AiDecisionProvider,
): Promise<StepOutcome> {
  if (state.phase === 'gameOver') return { kind: 'game-over' };

  // discard 阶段：组合爆炸，直接走规则 AI（aiNextAction 内部已遍历 discardLeft）
  if (state.phase === 'discard') {
    const action = aiNextAction(board, state);
    if (!action) return { kind: 'human-turn' };
    const nextState = reduce(board, state, action);
    const owner = action.type === 'DISCARD' ? action.player : state.current;
    return {
      kind: 'applied',
      nextState,
      thought: {
        player: owner,
        phase: state.phase,
        thought: '弃牌阶段由规则 AI 兜底（组合爆炸不喂 LLM）',
        actionId: `discard-fallback-p${owner}`,
        actionSummary: '自动弃牌',
        provider: `rule(discard-fallback)+${provider.name}`,
        retries: 0,
        status: 'success',
        ts: Date.now(),
      },
      errors: [],
    };
  }

  // 非 AI 玩家：交回 UI
  if (!state.players[state.current].isAI) return { kind: 'human-turn' };

  const legalActions = buildActionCatalog(board, state);
  if (legalActions.length === 0) {
    // 极端：当前阶段没有动作枚举（不应出现），强制 END_TURN 兜底
    return forceEndTurn(board, state, provider.name, 'EMPTY_CATALOG: 当前阶段无可选动作');
  }

  const view = buildPlayerView(board, state, state.current);
  const errors: AiErrorEvent[] = [];

  for (let attempt = 0; attempt <= MAX_PROVIDER_RETRIES; attempt++) {
    const retryFeedback: RetryFeedback[] = errors.map((e) => ({
      error: e.message,
      rawOutput: e.rawOutput,
    }));
    let output: LlmDecisionOutput;
    try {
      output = await provider.decide({ view, legalActions, retryFeedback });
    } catch (err) {
      errors.push({
        player: state.current,
        phase: state.phase,
        provider: provider.name,
        message: `Provider 调用抛异常：${(err as Error).message}`,
        retries: attempt,
        ts: Date.now(),
      });
      continue;
    }
    const result = checkDecision(board, state, output, legalActions);
    if (result.ok) {
      return {
        kind: 'applied',
        nextState: result.nextState,
        thought: {
          player: state.current,
          phase: state.phase,
          thought: output.thought,
          actionId: result.action.id,
          actionSummary: result.action.label,
          provider: provider.name,
          retries: attempt,
          status: 'success',
          ts: Date.now(),
        },
        errors,
      };
    }
    errors.push({
      player: state.current,
      phase: state.phase,
      provider: provider.name,
      message: result.message,
      rawOutput: JSON.stringify(output),
      retries: attempt,
      ts: Date.now(),
    });
  }

  // Provider 反复失败：fallback 到规则 Provider
  const ruleProvider = createRuleProvider(board, state);
  try {
    const ruleOutput = await ruleProvider.decide({ view, legalActions });
    const ruleCheck = checkDecision(board, state, ruleOutput, legalActions);
    if (ruleCheck.ok) {
      return {
        kind: 'applied',
        nextState: ruleCheck.nextState,
        thought: {
          player: state.current,
          phase: state.phase,
          thought: `[Fallback] ${ruleOutput.thought}`,
          actionId: ruleCheck.action.id,
          actionSummary: ruleCheck.action.label,
          provider: `${provider.name}→rule`,
          retries: MAX_PROVIDER_RETRIES + 1,
          status: 'fallback',
          ts: Date.now(),
        },
        errors,
      };
    }
  } catch {
    /* fall through */
  }

  return forceEndTurn(board, state, provider.name, 'Provider 与 rule fallback 均失败', errors);
}

function forceEndTurn(
  board: Board,
  state: GameState,
  providerName: string,
  reason: string,
  errors: AiErrorEvent[] = [],
): StepOutcome {
  // 只在 main 阶段可强制 END_TURN；其他阶段强制结束没语义，让 scheduleAI 的指纹兜底处理
  const end: LegalAction = { id: 'end-turn', label: '结束回合', action: { type: 'END_TURN' } };
  const result = checkDecision(board, state, { thought: reason, actionId: end.id }, [end]);
  if (!result.ok) {
    // 连 END_TURN 都拒绝：返回 human-turn 让 scheduleAI 的指纹兜底兜
    return { kind: 'human-turn' };
  }
  return {
    kind: 'forced-end-turn',
    nextState: result.nextState,
    errors: [
      ...errors,
      {
        player: state.current,
        phase: state.phase,
        provider: providerName,
        message: `强制 END_TURN：${reason}`,
        retries: MAX_PROVIDER_RETRIES + 1,
        ts: Date.now(),
      },
    ],
  };
}

// 占位导出避免单文件无导出被 tree-shake
export type { AiThoughtEvent, AiErrorEvent } from './types';
// 供 sim.ts / 单元调用：从 action 反查 actionId（便于测试 ruleProvider 行为）
export { findLegalActionFor };
