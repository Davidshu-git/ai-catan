// ============================================================
// Mock Provider：从 legalActions 中按弱启发式选一个，并生成假 thought
// ------------------------------------------------------------
// 用途：
//   1) 在不接真实 LLM 时端到端跑通整条 LLM 链路（catalog → check → apply）
//   2) sim.ts 压测：替代规则 AI 跑 60 局，验证 LLM 链路不破坏不变量
// 启发式（轻量、可复现）：
//   - 优先：建城 > 建房屋 > 修路 > 买发展卡 > 银行兑换 > 打发展卡 > 结束回合
//   - 在同优先级里挑第一条（catalog 顺序决定 → 决定性可复现）
//   - main 之外的阶段：随机选一项（setup / robber / steal 等）
// ============================================================

import type {
  AiDecisionProvider,
  LegalAction,
  LlmDecisionInput,
  LlmDecisionOutput,
} from './types';

const MAIN_PRIORITY: Array<{ prefix: string; thought: string }> = [
  { prefix: 'build-city-', thought: '升级城市性价比最高，先做这个。' },
  { prefix: 'build-settlement-', thought: '新建定居点能扩张产能。' },
  { prefix: 'build-road-', thought: '修路打通新顶点位。' },
  { prefix: 'buy-dev', thought: '资源够买发展卡，搏一搏。' },
  { prefix: 'bank-', thought: '银行兑换补齐缺口。' },
  { prefix: 'play-knight', thought: '骑士卡能搬强盗 + 抢卡。' },
  { prefix: 'play-road-building', thought: '免费两路扩张。' },
  { prefix: 'yop-', thought: '丰收两张关键资源。' },
  { prefix: 'monopoly-', thought: '垄断抢光对手的关键资源。' },
  { prefix: 'end-turn', thought: '本回合没有更好的动作了。' },
];

function pickFromMain(legalActions: LegalAction[]): LlmDecisionOutput | null {
  for (const rule of MAIN_PRIORITY) {
    const hit = legalActions.find((la) => la.id.startsWith(rule.prefix));
    if (hit) return { thought: rule.thought, actionId: hit.id };
  }
  return null;
}

function withAgentVoice(input: LlmDecisionInput, out: LlmDecisionOutput): LlmDecisionOutput {
  if (!input.agent) return out;
  return {
    ...out,
    thought: `${input.agent.name}（独立记忆 ${input.agent.memory.length} 条）：${out.thought}`,
  };
}

function pickRandom(legalActions: LegalAction[]): LlmDecisionOutput | null {
  if (legalActions.length === 0) return null;
  const la = legalActions[Math.floor(Math.random() * legalActions.length)];
  return {
    thought: `Mock 随机选择：${la.label}`,
    actionId: la.id,
  };
}

export function createMockProvider(): AiDecisionProvider {
  return {
    name: 'mock',
    async decide(input: LlmDecisionInput): Promise<LlmDecisionOutput> {
      const phase = input.view.phase;
      if (phase === 'main') {
        const out = pickFromMain(input.legalActions);
        if (out) return withAgentVoice(input, out);
      }
      const out = pickRandom(input.legalActions);
      if (!out) {
        throw new Error(`mock provider: empty legalActions in phase ${phase}`);
      }
      return withAgentVoice(input, out);
    },
  };
}
