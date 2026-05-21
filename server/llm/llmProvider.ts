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
// LLM_HINT=0 关闭空间动作的语义化 hint，用于 A/B 对比
const LLM_HINT_DEFAULT = process.env.LLM_HINT !== '0';

export const LLM_SYSTEM_PROMPT = `你是卡坦岛策略助手，正在替一名 AI 玩家做一步决策。

铁律：
1. 你必须从给定的 legalActions 列表里挑一个 actionId（精确字符串匹配）；不要自创 id、不要补坐标
2. 输出必须是严格 JSON：{"thought": "...", "actionId": "..."}
3. thought 用中文，1-3 句话，说清为什么选这个
4. 不要写规则解释、不要用代码块包裹、不要前后缀文字，只返回 JSON 本体
5. 如果输入里有 agentProfile，你必须延续该 agent 的性格、偏好和记忆，但仍以当前合法动作列表为准
6. 偏好：升级城市 > 建房屋 > 朝资源点修路 > 买发展卡 > END_TURN；银行兑换只在差 1 张关键资源时用
7. 建房/初始放房屋必须遵守距离规则：任何房屋或城市的相邻顶点都不能再建房屋；legalActions 里已经过滤掉违规顶点
8. 成本速查：道路=木1+砖1；房屋=木1+砖1+羊1+麦1；城市=麦2+矿3；发展卡=羊1+麦1+矿1。当前局面 JSON 里也有 costs 字段
9. 掷出 7 时，所有手牌数 >7 的玩家必须弃掉 floor(手牌数/2) 张，然后当前玩家移动强盗并偷牌；打骑士卡只移动强盗/偷牌，不触发弃半。若 self.discardOnSeven > 0，优先考虑建造、买发展卡或合理兑换来降低弃牌风险，别轻易 END_TURN

hint 阅读约定（仅空间动作有；没有 hint 的行就只看 label）：
- "麦8(5产出点)" = 该地块是麦，骰点为 8，产出点为 5；产出点不是资源数量，而是骰子概率权重（6/8 最高）
- "总产出 12产出点" = 顶点周边三块地的产出点总和（不含沙漠）
- "港口(木2:1)" / "港口(通用3:1)" = 该顶点附带港口
- "通往：v23→..." = 该路通向的空顶点的资源潜力
- "⚠" = 明显不利提示（如强盗只压己方建筑）`;

interface AnthropicResp {
  content?: Array<{ type: string; text?: string }>;
  // MiniMax 可能多塞字段，宽松解析
  [k: string]: unknown;
}

/**
 * 压紧 legalActions：每行 `id<TAB>label[<TAB>hint]`，hint 可选。
 * hint 仅出现在空间动作上（见 actionHints.ts），可由 useHint=false 一键关掉。
 */
export function formatLegalActions(actions: LegalAction[], useHint: boolean): string {
  return actions
    .map((a) => {
      if (useHint && a.hint) return `${a.id}\t${a.label}\t${a.hint}`;
      return `${a.id}\t${a.label}`;
    })
    .join('\n');
}

/** 压紧 PlayerView：自己全留，他人只留摘要，hexes 留 id+terrain+number+robber */
export function formatView(view: PlayerView): string {
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
    costs: view.costs,
    hexes: view.hexes,
    ports: view.ports,
    pendingTradeForMe: view.pendingTradeForMe,
    recentLog: view.recentLog,
  });
}

export function buildLlmUserMessage(input: LlmDecisionInput, useHint: boolean): string {
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
  const hintLegend = useHint
    ? '每行格式：actionId<TAB>label<TAB>hint（hint 是该空间动作的资源/概率/敌我分布情报，仅空间动作有）。'
    : '每行格式：actionId<TAB>label。';
  parts.push(
    `合法动作列表（${input.legalActions.length} 个，必须从这里选一个 id）。${hintLegend}`,
  );
  parts.push(formatLegalActions(input.legalActions, useHint));
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
  /** 是否在 prompt 里塞 actionHints；默认读 LLM_HINT 环境变量（缺省/=1 → true，=0 → false） */
  useHint?: boolean;
}

export function createLlmProvider(opts: LlmProviderOptions): AiDecisionProvider {
  const host = opts.host ?? DEFAULT_HOST;
  const model = opts.model ?? DEFAULT_MODEL;
  const useHint = opts.useHint ?? LLM_HINT_DEFAULT;
  return {
    name: `llm(${model}${useHint ? '+hint' : ''})`,
    async decide(input: LlmDecisionInput): Promise<LlmDecisionOutput> {
      const userMsg = buildLlmUserMessage(input, useHint);
      const raw = await callMinimax(opts.apiKey, host, model, LLM_SYSTEM_PROMPT, userMsg);
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
