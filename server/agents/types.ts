// ============================================================
// AI Agent Runtime：每个 AI 玩家一份独立身份、性格和记忆
// ------------------------------------------------------------
// 注意：这里仍是 server 编排层，不进入 shared/ 状态机。
// shared/ 保持纯规则内核；agent 记忆属于后端观察/LLM 调度上下文。
// ============================================================

import type { GameState, Phase } from '../../shared/types';
import type { AgentPromptContext } from '../llm/types';

const MAX_AGENT_MEMORY = 12;

export interface AiAgentRuntime {
  playerId: number;
  name: string;
  providerName: string;
  personality: string;
  memory: string[];
  decisionCount: number;
  /** 本回合目标（LLM 声明）；END_TURN 时清空 */
  currentTurnGoal?: string;
  /** 较慢变化的长期策略阶段 */
  stance?: string;
}

export interface AgentDecisionMemory {
  phase: Phase;
  thought: string;
  actionSummary: string;
}

const PERSONALITIES: Record<number, string> = {
  0: '进攻型红色 Agent。敢于抢节奏，优先扩张、最长路和关键资源卡位；必要时接受短期资源不均衡。',
  1: '冷静扩张者。优先抢高产资源点和最长路，愿意为了关键道路暂时牺牲发展卡节奏。',
  2: '资源经济师。重视港口、资源均衡和城市升级；倾向通过交易与银行兑换补齐短板。',
  3: '防守压制者。偏好发展卡、骑士和强盗压制领先者；不轻易给对手送关键资源。',
};

function fallbackPersonality(playerId: number): string {
  return `独立 AI 玩家 ${playerId}。稳健评估资源、分数和地图位置，选择当前最能推进胜利的动作。`;
}

export function createAgentRuntimes(
  state: GameState,
  defaultProviderName: string,
): Record<number, AiAgentRuntime> {
  const agents: Record<number, AiAgentRuntime> = {};
  for (const p of state.players) {
    if (!p.isAI) continue;
    agents[p.id] = {
      playerId: p.id,
      name: `${p.name} Agent`,
      providerName: defaultProviderName,
      personality: PERSONALITIES[p.id] ?? fallbackPersonality(p.id),
      memory: [],
      decisionCount: 0,
    };
  }
  return agents;
}

export function toAgentPromptContext(agent: AiAgentRuntime): AgentPromptContext {
  return {
    playerId: agent.playerId,
    name: agent.name,
    providerName: agent.providerName,
    personality: agent.personality,
    memory: [...agent.memory],
    decisionCount: agent.decisionCount,
    currentTurnGoal: agent.currentTurnGoal,
    stance: agent.stance,
  };
}

export function rememberAgentDecision(
  agent: AiAgentRuntime,
  memory: AgentDecisionMemory,
) {
  agent.decisionCount++;
  agent.memory.push(
    `第 ${agent.decisionCount} 次决策｜${memory.phase}｜${memory.actionSummary}｜${memory.thought}`,
  );
  if (agent.memory.length > MAX_AGENT_MEMORY) {
    agent.memory.splice(0, agent.memory.length - MAX_AGENT_MEMORY);
  }
}
