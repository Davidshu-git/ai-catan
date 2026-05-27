// ============================================================
// 社交发言生成器：把一个触发事件 + 说话人性格/关系，变成一句桌面喊话。
// 非 LLM provider（rule/mock）用模板兜底，保证无 API / 压测也能跑；
// LLM provider 复用 tradeProvider 的 callLlm/extractJson（便宜模型即可，纯味道）。
// 调度（预算/冷却/开关）在 server/social/socialChat.ts，本文件只管"生成一句话"。
// ============================================================

import type { AiModelContextEvent, SocialChatKind } from '../../shared/protocol';
import { playerDisplayName } from '../../shared/state';
import type { GameState } from '../../shared/types';
import { callLlm, extractJson, providerLabel, isLlmProvider } from './tradeProvider';
import { CATAN_RULES_BLOCK } from './llmProvider';
import type { AgentPromptContext } from './types';

export interface SocialLineInput {
  state: GameState;
  speaker: number;
  /** 触发类型：robber / longest-road / largest-army / near-win */
  triggerKind: string;
  /** 第三人称由头，如"橙把强盗砸向了你" */
  triggerNote: string;
  /** 发言针对的对象（通常是事件主角） */
  target?: number;
  agent?: AgentPromptContext;
}

export interface SocialLineOutput {
  kind: SocialChatKind;
  message: string;
  target?: number;
  provider?: string;
  modelContext?: AiModelContextEvent;
  rawOutput?: string;
}

const SOCIAL_SYSTEM = `你是卡坦岛牌桌上的一名玩家，要说一句简短的社交发言（嘴炮/拉拢结盟/威胁/炫耀/闲聊）。

${CATAN_RULES_BLOCK}

社交发言本路径要求：①只说一句中文，不超过 30 字，符合你的性格；②不要泄露隐藏手牌或具体数字策略；③这是口头喊话，不改变任何游戏规则。
严格输出 JSON：{"kind":"taunt|ally|threat|gloat|chat","message":"……"}`;

const KINDS: SocialChatKind[] = ['taunt', 'ally', 'threat', 'gloat', 'chat'];

function templateLine(input: SocialLineInput): SocialLineOutput {
  const t = input.target != null ? playerDisplayName(input.state.players, input.target) : '';
  switch (input.triggerKind) {
    case 'robber':
      return { kind: 'threat', message: `${t}，强盗这笔账我记下了。`, target: input.target, provider: 'template' };
    case 'longest-road':
      return { kind: 'taunt', message: `${t}的最长路，大家可得盯紧了。`, target: input.target, provider: 'template' };
    case 'largest-army':
      return { kind: 'taunt', message: `${t}骑士成群，小心被压制。`, target: input.target, provider: 'template' };
    case 'near-win':
      return { kind: 'ally', message: `${t}要赢了，咱们得联手压一压。`, target: input.target, provider: 'template' };
    default:
      return { kind: 'chat', message: '这一局越来越有意思了。', provider: 'template' };
  }
}

export async function generateSocialLine(
  input: SocialLineInput,
  providerName: string,
): Promise<SocialLineOutput> {
  const isLlm = isLlmProvider(providerName);
  if (!isLlm) return templateLine(input);

  const speakerName = playerDisplayName(input.state.players, input.speaker);
  const parts: string[] = [];
  if (input.agent) {
    parts.push(`你的角色：${input.agent.name}（${input.agent.personality}）`);
    if (input.agent.relationships) parts.push(`你对各家的看法：${input.agent.relationships}`);
  }
  parts.push(`你是 ${speakerName}。`);
  parts.push(`牌桌上刚刚发生：${input.triggerNote}。`);
  parts.push('请就此说一句符合你性格的桌面发言。');
  const user = parts.join('\n');
  const providerLbl = providerLabel(providerName);
  const modelContext: AiModelContextEvent = {
    provider: providerLbl,
    format: 'llm-prompt',
    legalActionCount: 0,
    retryFeedbackCount: 0,
    chars: {
      system: SOCIAL_SYSTEM.length,
      user: user.length,
      total: SOCIAL_SYSTEM.length + user.length,
    },
    systemPrompt: SOCIAL_SYSTEM,
    userPrompt: user,
  };

  try {
    const raw = await callLlm(providerName, SOCIAL_SYSTEM, user);
    const parsed = extractJson(raw) as Record<string, unknown>;
    const kind = KINDS.includes(parsed.kind as SocialChatKind) ? (parsed.kind as SocialChatKind) : 'chat';
    const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
    if (!message) return { ...templateLine(input), modelContext, rawOutput: raw, provider: providerLbl };
    return { kind, message, target: input.target, modelContext, rawOutput: raw, provider: providerLbl };
  } catch (err) {
    return {
      ...templateLine(input),
      modelContext,
      rawOutput: `[LLM 调用失败] ${(err as Error).message}`,
      provider: providerLbl,
    };
  }
}
