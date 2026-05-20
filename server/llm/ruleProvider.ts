// ============================================================
// 规则 Provider：把 shared/ai.ts 的 aiNextAction 包成统一接口
// ------------------------------------------------------------
// 用作：① 默认 Provider（不接 LLM 时）  ② LLM 失败时的兜底
// ============================================================

import type { Board, GameState } from '../../shared/types';
import type { Action } from '../../shared/reducer';
import { aiNextAction } from '../../shared/ai';
import type {
  AiDecisionProvider,
  LegalAction,
  LlmDecisionInput,
  LlmDecisionOutput,
} from './types';

/** 深比较两个 Action 是否在语义上等同 */
function actionEquals(a: Action, b: Action): boolean {
  if (a.type !== b.type) return false;
  // 所有字段（除 type）按字符串序列化比较，足够覆盖现有 Action shape
  const keysA = Object.keys(a).filter((k) => k !== 'type').sort();
  const keysB = Object.keys(b).filter((k) => k !== 'type').sort();
  if (keysA.join(',') !== keysB.join(',')) return false;
  for (const k of keysA) {
    if (JSON.stringify((a as Record<string, unknown>)[k]) !== JSON.stringify((b as Record<string, unknown>)[k])) {
      return false;
    }
  }
  return true;
}

export function findLegalActionFor(
  action: Action,
  legalActions: LegalAction[],
): LegalAction | null {
  for (const la of legalActions) {
    if (actionEquals(la.action, action)) return la;
  }
  return null;
}

/**
 * 把 board + state 喂给现有 aiNextAction 拿到动作，再在 legalActions
 * 里反查 actionId。供 Controller 在 setup/main 等阶段使用。
 */
export function decideWithRules(
  board: Board,
  state: GameState,
  legalActions: LegalAction[],
): LlmDecisionOutput | null {
  const action = aiNextAction(board, state);
  if (!action) return null;
  const la = findLegalActionFor(action, legalActions);
  if (!la) return null;
  return {
    thought: `规则 AI：${la.label}`,
    actionId: la.id,
  };
}

/**
 * Provider 形式：使用闭包持有 board+state 引用。
 * Controller 每次决策时新建 Provider 实例并调用 .decide()，
 * 而非全局单例（保持无状态、便于测试与替换）。
 */
export function createRuleProvider(board: Board, state: GameState): AiDecisionProvider {
  return {
    name: 'rule',
    async decide(input: LlmDecisionInput): Promise<LlmDecisionOutput> {
      const out = decideWithRules(board, state, input.legalActions);
      if (out) return out;
      // 兜底：选 END_TURN 或第一个合法动作
      const end = input.legalActions.find((la) => la.id === 'end-turn');
      const fallback = end ?? input.legalActions[0];
      if (!fallback) {
        throw new Error('rule provider: no legal action available');
      }
      return {
        thought: `规则 AI 兜底（无可选动作时取首项）：${fallback.label}`,
        actionId: fallback.id,
      };
    },
  };
}
