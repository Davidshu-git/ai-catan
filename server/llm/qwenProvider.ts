// ============================================================
// 阿里 Qwen Provider：OpenAI-compatible Chat Completions
// ------------------------------------------------------------
// 默认使用 omnibot 同款 coding.dashscope.aliyuncs.com/v1 端点，
// key 读取 ALI_CODING_PLAN_KEY，模型默认 qwen3.6-plus。
// ============================================================

import {
  buildLlmUserMessage,
  LLM_SYSTEM_PROMPT,
} from './llmProvider';
import type {
  AiDecisionProvider,
  LlmDecisionInput,
  LlmDecisionOutput,
} from './types';

const DEFAULT_BASE_URL =
  process.env.ALI_CODING_PLAN_BASE_URL ??
  process.env.QWEN_BASE_URL ??
  'https://coding.dashscope.aliyuncs.com/v1';
const DEFAULT_MODEL =
  process.env.QWEN_MODEL ??
  process.env.ALI_QWEN_MODEL ??
  'qwen3.6-plus';
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 30_000);
const LLM_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS ?? 1024);
const LLM_TEMPERATURE = Number(process.env.LLM_TEMPERATURE ?? 0.4);
// qwen3.6-plus 默认开启 thinking，对游戏决策不必要且严重拖慢速度（一次推理消耗大量 token）
const QWEN_ENABLE_THINKING = process.env.QWEN_ENABLE_THINKING === '1';
const LLM_HINT_DEFAULT = process.env.LLM_HINT !== '0';

interface OpenAiChatResp {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  [k: string]: unknown;
}

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

function parseDecision(raw: string): LlmDecisionOutput {
  let parsed: unknown;
  try {
    parsed = extractJson(raw);
  } catch (err) {
    throw new Error(`Qwen 输出 JSON 解析失败：${(err as Error).message}；原始：${raw.slice(0, 300)}`);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { thought?: unknown }).thought !== 'string' ||
    typeof (parsed as { actionId?: unknown }).actionId !== 'string'
  ) {
    throw new Error(`Qwen 输出 schema 不对（应含 thought:string + actionId:string）：${JSON.stringify(parsed).slice(0, 300)}`);
  }
  const p = parsed as { thought: string; actionId: string; turnGoal?: unknown; stance?: unknown };
  const turnGoal = typeof p.turnGoal === 'string' ? p.turnGoal.trim() : undefined;
  const stance = typeof p.stance === 'string' ? p.stance.trim() : undefined;
  return {
    thought: p.thought.trim(),
    actionId: p.actionId.trim(),
    turnGoal: turnGoal && turnGoal.length > 0 ? turnGoal : undefined,
    stance: stance && stance.length > 0 ? stance : undefined,
  };
}

function contentToText(
  content: string | Array<{ type?: string; text?: string }> | undefined,
): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block.type == null || block.type === 'text' ? block.text ?? '' : ''))
      .join('');
  }
  return '';
}

async function callQwen(
  apiKey: string,
  baseUrl: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LLM_TIMEOUT_MS);
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: LLM_TEMPERATURE,
        max_tokens: LLM_MAX_TOKENS,
        enable_thinking: QWEN_ENABLE_THINKING,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Qwen HTTP ${resp.status}: ${body.slice(0, 300)}`);
    }
    const json = (await resp.json()) as OpenAiChatResp;
    const text = contentToText(json.choices?.[0]?.message?.content);
    if (!text) {
      throw new Error(`Qwen 返回无 message.content：${JSON.stringify(json).slice(0, 300)}`);
    }
    return text;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Qwen 调用超时（>${LLM_TIMEOUT_MS}ms）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface QwenProviderOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  useHint?: boolean;
}

export function createQwenProvider(opts: QwenProviderOptions): AiDecisionProvider {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const model = opts.model ?? DEFAULT_MODEL;
  const useHint = opts.useHint ?? LLM_HINT_DEFAULT;
  return {
    name: `qwen(${model}${useHint ? '+hint' : ''})`,
    async decide(input: LlmDecisionInput): Promise<LlmDecisionOutput> {
      const userPrompt = buildLlmUserMessage(input, useHint);
      const raw = await callQwen(opts.apiKey, baseUrl, model, LLM_SYSTEM_PROMPT, userPrompt);
      return { ...parseDecision(raw), raw };
    },
  };
}
