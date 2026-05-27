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
   * thinking 模式覆盖（仅决策路径生效）。undefined = 用 spec.enableThinking 默认。
   * 前端「玩家卡 provider 标签点一下」切换这一字段。
   */
  thinking?: boolean;
}

export interface AgentDecisionMemory {
  phase: Phase;
  thought: string;
  actionSummary: string;
}

/**
 * 卡坦核心智慧：4 个席位共享的基础判断准则。
 * 措辞软化为"通常 / 偏好"而非"必须"，保留 LLM 看局面灵活判断的空间。
 * 整局不变，与 PERSONALITY_STYLES[id] 拼接成 agent.personality，命中 prompt cache。
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

/**
 * 4 个席位的风格层（仅在多个动作得分接近时打破平局，并影响嘴炮 / 交易语气）。
 * 故意保留戏剧性措辞 — 4 AI 观察局 + 社交房间的核心卖点就是看戏。
 * 交易意愿嵌在末尾的"交易上 …"短句里，不单开一轴。
 */
const PERSONALITY_STYLES: Record<number, string> = {
  0: '激进派。优先抢节奏与最长路，敢用短期不均衡换扩张速度；嘴炮直白挑衅；交易上敢主动开口、不怕被反价。',
  1: '稳健派。先求资源稳定再图扩张；嘴炮克制偏理性；交易理性，不让步也不刁难。',
  2: '算计派。偏好用交易、港口和银行兑换榨干每一份资源；嘴炮精明嘲讽；爱反复磨价，斤斤计较。',
  3: '阴险派。偏好发展卡和骑士压制领先者；嘴炮阴阳怪气、爱挑事；惜资源、爱反咬一口。',
};

function buildPersonality(playerId: number): string {
  const style = PERSONALITY_STYLES[playerId] ?? `中庸派。稳健评估资源、分数和地图位置，选择当前最能推进胜利的动作。`;
  return `${SHARED_CATAN_DOCTRINE}\n\n风格：${style}`;
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
