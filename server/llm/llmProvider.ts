// ============================================================
// 真实 LLM Provider：调 MiniMax-M2.7 的 Anthropic 兼容端点
// ------------------------------------------------------------
// 用裸 fetch 而非 @anthropic-ai/sdk，原因：
//   1) MiniMax 的 /anthropic 端点是兼容层，响应字段可能与官方 SDK 期望不完全吻合
//   2) 减少依赖，便于切换其他 OpenAI/Anthropic 兼容供应商
// 输入：LlmDecisionInput（PlayerView + LegalAction[]）
// 输出：{ thought, actionId } 严格 JSON
// 失败语义：抛 Error；外层 controller 会重试（最多 2 次）再 fallback 到 rule
// ============================================================

import type {
  AiDecisionProvider,
  LegalAction,
  LlmDecisionInput,
  LlmDecisionOutput,
} from './types';
import type { PlayerView } from './stateTranslator';

const DEFAULT_HOST = process.env.MINIMAX_API_HOST ?? 'api.minimaxi.com';
const DEFAULT_MODEL = process.env.LLM_MODEL ?? 'MiniMax-M2.7';
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 30_000);
const LLM_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS ?? 1024);
const LLM_TEMPERATURE = Number(process.env.LLM_TEMPERATURE ?? 0.4);

const SYSTEM_PROMPT = `你是卡坦岛策略助手，正在替一名 AI 玩家做一步决策。

铁律：
1. 你必须从给定的 legalActions 列表里挑一个 actionId（精确字符串匹配）；不要自创 id、不要补坐标
2. 输出必须是严格 JSON：{"thought": "...", "actionId": "..."}
3. thought 用中文，1-3 句话，说清为什么选这个
4. 不要写规则解释、不要用代码块包裹、不要前后缀文字，只返回 JSON 本体
5. 如果输入里有 agentProfile，你必须延续该 agent 的性格、偏好和记忆，但仍以当前合法动作列表为准
6. 偏好：升级城市 > 建房屋 > 朝资源点修路 > 买发展卡 > END_TURN；银行兑换只在差 1 张关键资源时用`;

interface AnthropicResp {
  content?: Array<{ type: string; text?: string }>;
  // MiniMax 可能多塞字段，宽松解析
  [k: string]: unknown;
}

/** 压紧 legalActions，每行 `id<TAB>label`，便于 LLM 看到全貌且省 token */
function formatLegalActions(actions: LegalAction[]): string {
  return actions.map((a) => `${a.id}\t${a.label}`).join('\n');
}

/** 压紧 PlayerView：自己全留，他人只留摘要，hexes 留 id+terrain+number+robber */
function formatView(view: PlayerView): string {
  return JSON.stringify({
    phase: view.phase,
    turn: view.turn,
    current: view.current,
    me: view.me,
    dice: view.dice,
    robberHex: view.robber,
    bank: view.bank,
    self: view.self,
    others: view.others,
    myBuildings: view.myBuildings,
    hexes: view.hexes,
    ports: view.ports,
    pendingTradeForMe: view.pendingTradeForMe,
    recentLog: view.recentLog,
  });
}

function buildUserMessage(input: LlmDecisionInput): string {
  const parts: string[] = [];
  if (input.agent) {
    parts.push('你的独立 agent 身份（JSON）：');
    parts.push(
      JSON.stringify({
        playerId: input.agent.playerId,
        name: input.agent.name,
        providerName: input.agent.providerName,
        personality: input.agent.personality,
        decisionCount: input.agent.decisionCount,
        memory: input.agent.memory,
      }),
    );
    parts.push('');
  }
  parts.push('当前局面（你的视角，JSON）：');
  parts.push(formatView(input.view));
  parts.push('');
  parts.push(`合法动作列表（${input.legalActions.length} 个，必须从这里选一个 id）：`);
  parts.push(formatLegalActions(input.legalActions));
  if (input.retryFeedback && input.retryFeedback.length > 0) {
    parts.push('');
    parts.push('【重试反馈】之前的尝试失败：');
    for (const f of input.retryFeedback) {
      const suffix = f.parsedActionId ? '（你上次给的 actionId="' + f.parsedActionId + '"）' : '';
      parts.push('- ' + f.error + suffix);
    }
    parts.push('请修正后重新输出 JSON。');
  }
  parts.push('');
  parts.push('现在输出 JSON：');
  return parts.join('\n');
}

// 多策略 JSON 提取：直 parse → 三引号 json 代码块 → 第一个 {...} 块
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {
      /* fall through */
    }
  }
  // 第一个完整 { ... } 块（按花括号配对）
  const start = trimmed.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < trimmed.length; i++) {
      if (trimmed[i] === '{') depth++;
      else if (trimmed[i] === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new Error('无法从模型输出里解析出 JSON');
}

async function callMinimax(
  apiKey: string,
  host: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LLM_TIMEOUT_MS);
  try {
    const resp = await fetch(`https://${host}/anthropic/v1/messages`, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        // MiniMax 文档表明也接受 Authorization Bearer，双发更稳
        Authorization: `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: LLM_MAX_TOKENS,
        temperature: LLM_TEMPERATURE,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`MiniMax HTTP ${resp.status}: ${body.slice(0, 300)}`);
    }
    const json = (await resp.json()) as AnthropicResp;
    const blocks = json.content ?? [];
    const text = blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text!)
      .join('');
    if (!text) {
      throw new Error(`MiniMax 返回无 text 块：${JSON.stringify(json).slice(0, 300)}`);
    }
    return text;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`MiniMax 调用超时（>${LLM_TIMEOUT_MS}ms）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface LlmProviderOptions {
  apiKey: string;
  host?: string;
  model?: string;
}

export function createLlmProvider(opts: LlmProviderOptions): AiDecisionProvider {
  const host = opts.host ?? DEFAULT_HOST;
  const model = opts.model ?? DEFAULT_MODEL;
  return {
    name: `llm(${model})`,
    async decide(input: LlmDecisionInput): Promise<LlmDecisionOutput> {
      const userMsg = buildUserMessage(input);
      const raw = await callMinimax(opts.apiKey, host, model, SYSTEM_PROMPT, userMsg);
      let parsed: unknown;
      try {
        parsed = extractJson(raw);
      } catch (err) {
        throw new Error(`LLM 输出 JSON 解析失败：${(err as Error).message}；原始：${raw.slice(0, 300)}`);
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof (parsed as { thought?: unknown }).thought !== 'string' ||
        typeof (parsed as { actionId?: unknown }).actionId !== 'string'
      ) {
        throw new Error(`LLM 输出 schema 不对（应含 thought:string + actionId:string）：${JSON.stringify(parsed).slice(0, 300)}`);
      }
      return {
        thought: (parsed as { thought: string }).thought.trim(),
        actionId: (parsed as { actionId: string }).actionId.trim(),
      };
    },
  };
}
