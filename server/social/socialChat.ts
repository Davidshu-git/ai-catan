// ============================================================
// 社交聊天调度器（AI 社交房间第 3 层）
// ------------------------------------------------------------
// 在一组"关系事件"（强盗/最长路/逼近胜利…）上，按 **预算 + 冷却 + 开关** 挑人发声。
// 纯旁路：不改游戏状态、不经 reducer。生成具体话术由注入的 SocialLineFn 负责
// （便于压测注入模板、真实用 LLM）。开关默认关，是防 token 失控的实时刹车。
// ============================================================

import type { SocialChatEvent } from '../../shared/protocol';
import type { GameState } from '../../shared/types';
import type { AgentPromptContext } from '../llm/types';
import type { SocialLineOutput } from '../llm/socialProvider';
import type { RelationshipEvent, RelationshipLedger } from './relationshipLedger';

export const SOCIAL_LIMITS = {
  /** 每个游戏回合全场社交发言上限（硬封顶） */
  linesPerTurn: Math.max(0, Number(process.env.SOCIAL_LINES_PER_TURN ?? 2)),
  /** 单个 agent 两次社交发言之间的最小回合间隔 */
  cooldownTurns: Math.max(0, Number(process.env.SOCIAL_COOLDOWN_TURNS ?? 1)),
  /** 整局社交发言总上限（兜底，防失控累积） */
  linesPerGame: Math.max(0, Number(process.env.SOCIAL_LINES_PER_GAME ?? 40)),
};

export interface SocialChatBudget {
  turnKey: number;
  linesThisTurn: number;
  linesThisGame: number;
  lastTurnByAgent: Record<number, number>;
}

export function createSocialBudget(): SocialChatBudget {
  return { turnKey: -1, linesThisTurn: 0, linesThisGame: 0, lastTurnByAgent: {} };
}

/** 注入式发言生成器：server 按 speaker 的 agent providerName 决定走模板还是 LLM */
export type SocialLineFn = (
  speaker: number,
  trigger: RelationshipEvent,
  agent: AgentPromptContext | undefined,
) => Promise<SocialLineOutput>;

/**
 * 在一组关系事件上挑人发言。isEnabled 每条前后都查一次 —— 运行时熄火能立即止住，
 * 包括生成中途被关：结果直接丢弃，不再 emit。
 */
export async function maybeRunSocialChat(
  state: GameState,
  ledger: RelationshipLedger,
  events: RelationshipEvent[],
  budget: SocialChatBudget,
  generate: SocialLineFn,
  getAgent: (id: number) => AgentPromptContext | undefined,
  isEnabled: () => boolean,
  onEvent: (ev: SocialChatEvent) => void,
): Promise<void> {
  if (!isEnabled() || events.length === 0) return;

  // 跨回合重置"每回合"配额
  if (budget.turnKey !== state.turn) {
    budget.turnKey = state.turn;
    budget.linesThisTurn = 0;
  }

  for (const ev of events) {
    if (!isEnabled()) return; // 中途被熄火
    if (budget.linesThisGame >= SOCIAL_LIMITS.linesPerGame) return;
    if (budget.linesThisTurn >= SOCIAL_LIMITS.linesPerTurn) return;

    const speaker = pickSpeaker(state, ledger, ev, budget);
    if (speaker == null) continue;

    const out = await generate(speaker, ev, getAgent(speaker));
    if (!isEnabled()) return; // 生成期间被熄火 → 丢弃

    onEvent({
      player: speaker,
      trigger: ev.type,
      target: out.target ?? ev.actor,
      kind: out.kind,
      message: out.message,
      turn: state.turn,
      phase: state.phase,
      provider: out.provider,
      modelContext: out.modelContext,
      rawOutput: out.rawOutput,
      ts: Date.now(),
    });

    budget.linesThisTurn++;
    budget.linesThisGame++;
    budget.lastTurnByAgent[speaker] = state.turn;
  }
}

/** 从 affected 里挑：AI、非主角、冷却已过、对主角"威胁−信任"最高（最有发声动机）者 */
function pickSpeaker(
  state: GameState,
  ledger: RelationshipLedger,
  ev: RelationshipEvent,
  budget: SocialChatBudget,
): number | null {
  let best: number | null = null;
  let bestScore = -Infinity;
  for (const p of ev.affected) {
    if (p === ev.actor) continue;
    const player = state.players[p];
    if (!player?.isAI) continue;
    const last = budget.lastTurnByAgent[p];
    if (last != null && state.turn - last < SOCIAL_LIMITS.cooldownTurns) continue;
    const rel = ledger[p]?.[ev.actor];
    const score = (rel?.threat ?? 0) - (rel?.trust ?? 0);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}
