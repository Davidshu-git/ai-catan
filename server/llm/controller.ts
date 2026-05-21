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
import {
  buildLlmUserMessage,
  formatLegalActions,
  formatView,
  LLM_SYSTEM_PROMPT,
} from './llmProvider';
import type {
  AiDecisionProvider,
  AiErrorEvent,
  AiModelContextEvent,
  AiTimingEvent,
  AiTimingStage,
  AiThoughtEvent,
  AgentPromptContext,
  LegalAction,
  LlmDecisionInput,
  LlmDecisionOutput,
  RetryFeedback,
} from './types';

const MAX_PROVIDER_RETRIES = 2;

interface DecideAiStepOptions {
  /** 当前 LLM prompt 是否包含空间动作 hint；用于前端还原真实 user prompt */
  promptUseHint?: boolean;
}

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
  agent?: AgentPromptContext,
  options: DecideAiStepOptions = {},
): Promise<StepOutcome> {
  const decisionStartedAt = Date.now();
  const timingStages: AiTimingStage[] = [];
  const markStage = (key: string, label: string, startedAt: number, detail?: string) => {
    timingStages.push({
      key,
      label,
      ms: elapsedMs(startedAt),
      ...(detail ? { detail } : {}),
    });
  };
  const currentTiming = () => buildTimingSnapshot(decisionStartedAt, timingStages);

  if (state.phase === 'gameOver') return { kind: 'game-over' };

  // discard 阶段：组合爆炸，直接走规则 AI（aiNextAction 内部已遍历 discardLeft）
  if (state.phase === 'discard') {
    const ruleStartedAt = Date.now();
    const action = aiNextAction(board, state);
    markStage('discard-rule', '弃牌规则决策', ruleStartedAt);
    if (!action) return { kind: 'human-turn' };
    const reduceStartedAt = Date.now();
    const nextState = reduce(board, state, action);
    markStage('reduce', '应用 reducer', reduceStartedAt);
    const owner = action.type === 'DISCARD' ? action.player : state.current;
    return {
      kind: 'applied',
      nextState,
      thought: {
        player: owner,
        ...agentEventFields(agent),
        phase: state.phase,
        thought: '弃牌阶段由规则 AI 兜底（组合爆炸不喂 LLM）',
        actionId: `discard-fallback-p${owner}`,
        actionSummary: '自动弃牌',
        action,
        timing: currentTiming(),
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

  const catalogStartedAt = Date.now();
  const legalActions = buildActionCatalog(board, state);
  markStage('catalog', '枚举合法动作', catalogStartedAt, `${legalActions.length} 个动作`);
  if (legalActions.length === 0) {
    // 极端：当前阶段没有动作枚举（不应出现），强制 END_TURN 兜底
    return forceEndTurn(board, state, provider.name, 'EMPTY_CATALOG: 当前阶段无可选动作', [], agent);
  }

  const viewStartedAt = Date.now();
  const view = buildPlayerView(board, state, state.current);
  markStage('view', '构建玩家视角', viewStartedAt);
  const errors: AiErrorEvent[] = [];

  for (let attempt = 0; attempt <= MAX_PROVIDER_RETRIES; attempt++) {
    const retryFeedback: RetryFeedback[] = errors.map((e) => ({
      error: e.message,
      rawOutput: e.rawOutput,
    }));
    const input: LlmDecisionInput = { view, legalActions, agent, retryFeedback };
    const contextStartedAt = Date.now();
    const modelContext = buildModelContext(provider.name, input, options.promptUseHint);
    markStage(
      'context',
      '构建模型输入',
      contextStartedAt,
      `第 ${attempt + 1} 次，${modelContext.chars.total} 字`,
    );
    let output: LlmDecisionOutput;
    const providerStartedAt = Date.now();
    try {
      output = await provider.decide(input);
      markStage('provider', 'Provider/模型调用', providerStartedAt, `第 ${attempt + 1} 次`);
    } catch (err) {
      markStage(
        'provider',
        'Provider/模型调用',
        providerStartedAt,
        `第 ${attempt + 1} 次抛异常：${(err as Error).message}`,
      );
      errors.push({
        player: state.current,
        ...agentErrorFields(agent),
        phase: state.phase,
        provider: provider.name,
        message: `Provider 调用抛异常：${(err as Error).message}`,
        modelContext,
        timing: currentTiming(),
        retries: attempt,
        ts: Date.now(),
      });
      continue;
    }
    const checkerStartedAt = Date.now();
    const result = checkDecision(board, state, output, legalActions);
    markStage(
      'checker',
      'Maker-Checker 校验',
      checkerStartedAt,
      result.ok ? `通过 ${result.action.id}` : result.message,
    );
    if (result.ok) {
      return {
        kind: 'applied',
        nextState: result.nextState,
        thought: {
          player: state.current,
          ...agentEventFields(agent),
          phase: state.phase,
          thought: output.thought,
          actionId: result.action.id,
          actionSummary: result.action.label,
          actionHint: result.action.hint,
          action: result.action.action,
          modelContext,
          timing: currentTiming(),
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
      ...agentErrorFields(agent),
      phase: state.phase,
      provider: provider.name,
      message: result.message,
      rawOutput: JSON.stringify(output),
      modelContext,
      timing: currentTiming(),
      retries: attempt,
      ts: Date.now(),
    });
  }

  // Provider 反复失败：fallback 到规则 Provider
  const ruleProvider = createRuleProvider(board, state);
  try {
    const ruleInput: LlmDecisionInput = { view, legalActions, agent };
    const ruleContextStartedAt = Date.now();
    const ruleContext = buildModelContext(ruleProvider.name, ruleInput, options.promptUseHint);
    markStage(
      'fallback-context',
      '构建 fallback 输入',
      ruleContextStartedAt,
      `${ruleContext.chars.total} 字`,
    );
    const ruleProviderStartedAt = Date.now();
    const ruleOutput = await ruleProvider.decide(ruleInput);
    markStage('fallback-provider', 'Rule fallback 调用', ruleProviderStartedAt);
    const ruleCheckerStartedAt = Date.now();
    const ruleCheck = checkDecision(board, state, ruleOutput, legalActions);
    markStage(
      'fallback-checker',
      'Fallback 校验',
      ruleCheckerStartedAt,
      ruleCheck.ok ? `通过 ${ruleCheck.action.id}` : ruleCheck.message,
    );
    if (ruleCheck.ok) {
      return {
        kind: 'applied',
        nextState: ruleCheck.nextState,
        thought: {
          player: state.current,
          ...agentEventFields(agent),
          phase: state.phase,
          thought: `[Fallback] ${ruleOutput.thought}`,
          actionId: ruleCheck.action.id,
          actionSummary: ruleCheck.action.label,
          actionHint: ruleCheck.action.hint,
          action: ruleCheck.action.action,
          modelContext: ruleContext,
          timing: currentTiming(),
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

  return forceEndTurn(board, state, provider.name, 'Provider 与 rule fallback 均失败', errors, agent);
}

function agentEventFields(agent?: AgentPromptContext) {
  return agent
    ? {
        agentName: agent.name,
        agentPersonality: agent.personality,
        agentMemorySize: agent.memory.length,
      }
    : {};
}

function agentErrorFields(agent?: AgentPromptContext) {
  return agent ? { agentName: agent.name } : {};
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function buildTimingSnapshot(startedAt: number, stages: AiTimingStage[]): AiTimingEvent {
  const finishedAt = Date.now();
  const decisionMs = Math.max(0, finishedAt - startedAt);
  return {
    startedAt,
    finishedAt,
    totalMs: decisionMs,
    decisionMs,
    stages: stages.map((s) => ({ ...s })),
  };
}

function buildModelContext(
  providerName: string,
  input: LlmDecisionInput,
  promptUseHint = true,
): AiModelContextEvent {
  const viewText = formatView(input.view);
  const legalActionsText = formatLegalActions(input.legalActions, promptUseHint);
  const retryFeedbackCount = input.retryFeedback?.length ?? 0;

  if (providerName.startsWith('llm(')) {
    const userPrompt = buildLlmUserMessage(input, promptUseHint);
    const systemPrompt = LLM_SYSTEM_PROMPT;
    return {
      provider: providerName,
      format: 'llm-prompt',
      legalActionCount: input.legalActions.length,
      retryFeedbackCount,
      chars: {
        system: systemPrompt.length,
        user: userPrompt.length,
        total: systemPrompt.length + userPrompt.length,
        view: viewText.length,
        legalActions: legalActionsText.length,
      },
      systemPrompt,
      userPrompt,
    };
  }

  const providerInputJson = JSON.stringify(
    {
      agent: input.agent,
      view: input.view,
      legalActions: input.legalActions,
      retryFeedback: input.retryFeedback ?? [],
    },
    null,
    2,
  );

  return {
    provider: providerName,
    format: 'provider-input',
    legalActionCount: input.legalActions.length,
    retryFeedbackCount,
    chars: {
      total: providerInputJson.length,
      view: viewText.length,
      legalActions: legalActionsText.length,
      providerInput: providerInputJson.length,
    },
    providerInputJson,
  };
}

function forceEndTurn(
  board: Board,
  state: GameState,
  providerName: string,
  reason: string,
  errors: AiErrorEvent[] = [],
  agent?: AgentPromptContext,
): StepOutcome {
  const startedAt = Date.now();
  const stages: AiTimingStage[] = [];
  // 只在 main 阶段可强制 END_TURN；其他阶段强制结束没语义，让 scheduleAI 的指纹兜底处理
  const end: LegalAction = { id: 'end-turn', label: '结束回合', action: { type: 'END_TURN' } };
  const checkerStartedAt = Date.now();
  const result = checkDecision(board, state, { thought: reason, actionId: end.id }, [end]);
  stages.push({
    key: 'force-checker',
    label: '强制 END_TURN 校验',
    ms: elapsedMs(checkerStartedAt),
    detail: result.ok ? '通过 end-turn' : result.message,
  });
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
        ...agentErrorFields(agent),
        phase: state.phase,
        provider: providerName,
        message: `强制 END_TURN：${reason}`,
        timing: buildTimingSnapshot(startedAt, stages),
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
