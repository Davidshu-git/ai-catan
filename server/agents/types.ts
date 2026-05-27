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
  /**
   * thinking 模式（仅决策路径生效，交易/社交 LLM 不受影响）。
   * - 'on' / 'off': 强制开 / 关
   * - 'auto': 走 server/llm/thinkingPolicy.ts 的 phase 策略
   * 前端「玩家卡 thinking 下拉」切换；默认 'auto'。
   */
  thinkingMode: ThinkingMode;
}

export type ThinkingMode = 'auto' | 'on' | 'off';

export interface AgentDecisionMemory {
  phase: Phase;
  thought: string;
  actionSummary: string;
}

/**
 * 卡坦核心智慧：4 个席位共享的基础判断准则。
 * 措辞软化为"通常 / 偏好"而非"必须"，保留 LLM 看局面灵活判断的空间。
 * 整局不变，作为 agent.personality 直接送给 LLM，命中 prompt cache。
 *
 * 注：原先这里另有 PERSONALITY_STYLES（激进/稳健/算计/阴险派）+ 拼接逻辑，
 * 为了排除"风格差异"作为变量、便于对比模型本身能力，已全部移除。
 * 现在 4 个席位的 personality 完全相同，只有卡坦通识，无任何性格预设。
 */
const SHARED_CATAN_DOCTRINE = `卡坦核心智慧（普世判断准则，作为偏好而非铁律；具体局面以你对牌面的判断为准）：
- 产出点是地利硬通货：6/8 ≈ 5、5/9 ≈ 4、4/10 ≈ 3，初始放屋通常优先合计产出点高 + 资源多样的顶点。
- 同样花资源时通常优先升城而非新建房屋：城市每回合产出翻倍，边际收益更高（setup 阶段除外）。
- 最长路需要 ≥5 段且严格长于当前持有者才有 2 分；凑不到就别为路一直烧木砖。
- 强盗通常放在领先者（publicVP 最高）的高产地块；除非有特别理由，不要落到空地或自己地盘。
- 倾向不给逼近 10 分的对手送他缺的资源；交易优先考虑暂时落后的对手。
- 手牌 ≥8 张时通常要主动消化（建造或交易），否则容易被 7 点强盗洗掉一半。
- 胜利点卡 / 修路卡 / 垄断卡是终结技，最好攒到能一波 10 分时再用，不要轻易暴露。
- 当回合能建城就建城、能建房就建房，不要白攥资源 — 除非在为关键道路或骑士存料。`;

function buildPersonality(_playerId: number): string {
  return SHARED_CATAN_DOCTRINE;
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
      personality: buildPersonality(p.id),
      memory: [],
      decisionCount: 0,
      thinkingMode: 'auto',
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
