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
// MINIMAX_ENABLE_THINKING=1 开启 thinking（默认关闭，M2.7 thinking 拉满约 15-25s）
const MINIMAX_ENABLE_THINKING = process.env.MINIMAX_ENABLE_THINKING === '1';

export const LLM_SYSTEM_PROMPT = `你是卡坦岛策略助手，正在替一名 AI 玩家做一步决策。

铁律：
1. 你必须从给定的 legalActions 列表里挑一个 actionId（精确字符串匹配）；不要自创 id、不要补坐标
2. 输出必须是严格 JSON：{"thought": "...", "actionId": "...", "turnGoal": "本回合简短目标 10-20 字", "stance": "长期策略阶段（可选，跟上次保持一致即可）"}
3. thought 用中文，1-3 句话，说清为什么选这个动作；turnGoal 描述本回合还想完成什么（END_TURN 时可写"已结束本回合"）；stance 是长期策略阶段（如"抢最长路+城市混合"），保持稳定，每隔几回合才微调
4. 不要写规则解释、不要用代码块包裹、不要前后缀文字，只返回 JSON 本体
5. 输入里 agent.currentTurnGoal 是你上一步声明的本回合目标——本步必须以该目标为锚点，要么继续推进，要么明确改写。agent.stance 是你正在执行的长期策略。memory 是过去 12 步决策摘要
6. 偏好：升级城市 > 建房屋 > 朝资源点修路 > 买发展卡 > END_TURN；银行兑换只在差 1 张关键资源时用
7. 建房/初始放房屋必须遵守距离规则：任何房屋或城市的相邻顶点都不能再建房屋；legalActions 里已经过滤掉违规顶点
8. 成本速查：道路=木1+砖1；房屋=木1+砖1+羊1+麦1；城市=麦2+矿3；发展卡=羊1+麦1+矿1。当前局面 JSON 里也有 costs 字段
9. 掷出 7 时，所有手牌数 >7 的玩家必须弃掉 floor(手牌数/2) 张，然后当前玩家移动强盗并偷牌；打骑士卡只移动强盗/偷牌，不触发弃半。若 self.discardOnSeven > 0，优先考虑建造、买发展卡或合理兑换来降低弃牌风险，别轻易 END_TURN
10. 反短视铁律：
    - 修路前必须读 hint。若 hint 写"暂未打开可建房屋位"或仅"延长路网长度"，仅在抢最长路（路差 ≤1）时考虑；否则**别修**，更别为这种路兑换/凑资源
    - 优先选 hint 含"修完即可建：...产出点 ≥ 9"或"隔点候选：...产出点 ≥ 10"的路
    - 建房选点优先 总产出 ≥ 9 产出点且 资源种类 ≥ 3；带港口对应资源已经稳产时港口加分
    - 升城前先确认所需的麦/矿够，且本回合不会因升城耗尽阻断下一目标
    - 资源凑齐前**不修无去处的"装饰路"**，宁可 END_TURN 攒资源`;

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

/**
 * 整局不变的静态上下文：棋盘几何（hexes 地形+点数）、港口分布、建造成本。
 * 单独抽出来便于通过 cache_control 命中 prompt cache。
 */
function formatStaticBoardContext(view: PlayerView): string {
  return JSON.stringify({
    hexes: view.hexes,
    ports: view.ports,
    costs: view.costs,
  });
}

/**
 * agent 整体身份（personality 整局基本不变）— 也走静态缓存。
 * 注意：decisionCount / memory 是动态的，放到 dynamic 段。
 */
function formatStaticAgentContext(input: LlmDecisionInput): string | null {
  if (!input.agent) return null;
  return JSON.stringify({
    playerId: input.agent.playerId,
    name: input.agent.name,
    providerName: input.agent.providerName,
    personality: input.agent.personality,
  });
}

function formatDynamicView(view: PlayerView): string {
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
    pendingTradeForMe: view.pendingTradeForMe,
    recentLog: view.recentLog,
  });
}

function formatDynamicAgentRuntime(input: LlmDecisionInput): string | null {
  if (!input.agent) return null;
  return JSON.stringify({
    decisionCount: input.agent.decisionCount,
    currentTurnGoal: input.agent.currentTurnGoal ?? null,
    stance: input.agent.stance ?? null,
    memory: input.agent.memory,
  });
}

export function buildLlmUserMessage(input: LlmDecisionInput, useHint: boolean): string {
  // 仅用于诊断面板展示 / 校验：把静态 + 动态拼回单串。真实 API 调用走 buildLlmRequestBlocks。
  const blocks = buildLlmRequestBlocks(input, useHint);
  return blocks.userBlocks.map((b) => b.text).join('\n');
}

export interface LlmContentBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface LlmRequestBlocks {
  system: LlmContentBlock[];
  userBlocks: LlmContentBlock[];
}

/**
 * 把一次决策的输入拆成「静态可缓存」+「动态每次变」两部分。
 * - system 段：固定 prompt（铁律 + hint 阅读约定），整个进程内不变
 * - user 段第 1 块：本局静态（棋盘 + 港口 + 成本 + agent 身份），整局不变
 * - user 段第 2 块：动态（当前局面 + 合法动作 + 重试反馈）
 *
 * 给前两块打 cache_control: ephemeral，命中 Anthropic prompt cache 后只算
 * 一次完整 input tokens；TTL 默认 5 分钟，足够 AI 自动推进的高频调用。
 */
export function buildLlmRequestBlocks(
  input: LlmDecisionInput,
  useHint: boolean,
): LlmRequestBlocks {
  const system: LlmContentBlock[] = [
    { type: 'text', text: LLM_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
  ];

  const staticParts: string[] = [];
  staticParts.push('本局静态信息（棋盘几何、港口、建造成本）JSON：');
  staticParts.push(formatStaticBoardContext(input.view));
  const agentStatic = formatStaticAgentContext(input);
  if (agentStatic) {
    staticParts.push('');
    staticParts.push('你的 agent 身份（JSON，整局不变部分）：');
    staticParts.push(agentStatic);
  }

  const dynamicParts: string[] = [];
  const agentRuntime = formatDynamicAgentRuntime(input);
  if (agentRuntime) {
    dynamicParts.push('你的 agent 运行时（JSON，每步刷新）：');
    dynamicParts.push(agentRuntime);
    dynamicParts.push('');
  }
  dynamicParts.push('当前局面（你的视角，JSON）：');
  dynamicParts.push(formatDynamicView(input.view));
  dynamicParts.push('');
  const hintLegend = useHint
    ? '每行格式：actionId<TAB>label<TAB>hint（hint 是该空间动作的资源/概率/敌我分布情报，仅空间动作有）。'
    : '每行格式：actionId<TAB>label。';
  dynamicParts.push(
    `合法动作列表（${input.legalActions.length} 个，必须从这里选一个 id）。${hintLegend}`,
  );
  dynamicParts.push(formatLegalActions(input.legalActions, useHint));
  if (input.retryFeedback && input.retryFeedback.length > 0) {
    dynamicParts.push('');
    dynamicParts.push('【重试反馈】之前的尝试失败：');
    for (const f of input.retryFeedback) {
      const suffix = f.parsedActionId ? '（你上次给的 actionId="' + f.parsedActionId + '"）' : '';
      dynamicParts.push('- ' + f.error + suffix);
    }
    dynamicParts.push('请修正后重新输出 JSON。');
  }
  dynamicParts.push('');
  dynamicParts.push('现在输出 JSON：');

  const userBlocks: LlmContentBlock[] = [
    { type: 'text', text: staticParts.join('\n'), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: dynamicParts.join('\n') },
  ];

  return { system, userBlocks };
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

interface CacheUsage {
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}

async function callMinimax(
  apiKey: string,
  host: string,
  model: string,
  blocks: LlmRequestBlocks,
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
        // 开启 prompt cache 能力（Anthropic 历史 beta header；新模型多已默认可用，
        // 但 MiniMax 兼容端点行为不确定，加上保险）
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({
        model,
        max_tokens: LLM_MAX_TOKENS,
        temperature: LLM_TEMPERATURE,
        system: blocks.system,
        messages: [{ role: 'user', content: blocks.userBlocks }],
        ...(MINIMAX_ENABLE_THINKING ? {} : { thinking: { type: 'disabled' } }),
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`MiniMax HTTP ${resp.status}: ${body.slice(0, 300)}`);
    }
    const json = (await resp.json()) as AnthropicResp & { usage?: CacheUsage };
    const contentBlocks = json.content ?? [];
    const text = contentBlocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text!)
      .join('');
    if (!text) {
      throw new Error(`MiniMax 返回无 text 块：${JSON.stringify(json).slice(0, 300)}`);
    }
    // 打印一次缓存命中情况，便于线上观察是否生效（命中 cache_read > 0）
    if (json.usage) {
      const u = json.usage;
      if ((u.cache_read_input_tokens ?? 0) > 0 || (u.cache_creation_input_tokens ?? 0) > 0) {
        console.log(
          `[llm] cache read=${u.cache_read_input_tokens ?? 0} write=${u.cache_creation_input_tokens ?? 0} input=${u.input_tokens ?? 0} output=${u.output_tokens ?? 0}`,
        );
      }
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
      const blocks = buildLlmRequestBlocks(input, useHint);
      const raw = await callMinimax(opts.apiKey, host, model, blocks);
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
      const p = parsed as { thought: string; actionId: string; turnGoal?: unknown; stance?: unknown };
      const turnGoal = typeof p.turnGoal === 'string' ? p.turnGoal.trim() : undefined;
      const stance = typeof p.stance === 'string' ? p.stance.trim() : undefined;
      return {
        thought: p.thought.trim(),
        actionId: p.actionId.trim(),
        turnGoal: turnGoal && turnGoal.length > 0 ? turnGoal : undefined,
        stance: stance && stance.length > 0 ? stance : undefined,
      };
    },
  };
}
