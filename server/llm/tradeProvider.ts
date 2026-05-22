// ============================================================
// 交易谈判 LLM Provider：提议消息生成 + 回应决策（接受/拒绝/还价）
// ------------------------------------------------------------
// 两种调用：
//   generateProposeMessage：发起方生成开场白（不决策，只出文字）
//   decideTradeResponse：参与方回应报价，输出 decision + message
// rule/mock provider 直接走 aiAcceptsTrade 规则兜底，不调 LLM。
// ============================================================

import { aiAcceptsTrade } from '../../shared/ai';
import type { Board, GameState, ResMap, Resource } from '../../shared/types';
import { RESOURCES, COSTS } from '../../shared/types';
import { playerDisplayName } from '../../shared/state';
import { publicVP, tradeRatio, handSize } from '../../shared/rules';
import type {
  TradeOfferEvent,
  TradeChatMessageEvent,
  AiModelContextEvent,
} from '../../shared/protocol';
import type { AgentPromptContext } from './types';

const MINIMAX_HOST = process.env.MINIMAX_API_HOST ?? 'api.minimaxi.com';
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY ?? '';
const MINIMAX_MODEL = process.env.LLM_MODEL ?? 'MiniMax-M2.7';
const MINIMAX_ENABLE_THINKING = process.env.MINIMAX_ENABLE_THINKING === '1';

const QWEN_BASE_URL =
  process.env.ALI_CODING_PLAN_BASE_URL ??
  process.env.QWEN_BASE_URL ??
  'https://coding.dashscope.aliyuncs.com/v1';
const QWEN_API_KEY = process.env.ALI_CODING_PLAN_KEY ?? '';
const QWEN_MODEL = process.env.QWEN_MODEL ?? process.env.ALI_QWEN_MODEL ?? 'qwen3.6-plus';
const QWEN_ENABLE_THINKING = process.env.QWEN_ENABLE_THINKING === '1';

const TRADE_TIMEOUT_MS = Number(
  process.env.TRADE_LLM_TIMEOUT_MS ?? process.env.LLM_TIMEOUT_MS ?? 20_000,
);
const TRADE_TEMPERATURE = Number(process.env.LLM_TEMPERATURE ?? 0.6);

// ---------- 上下文工具 ----------

/** 玩家显示名（红/蓝/绿/橙）：AI 空名时用颜色字样，让 LLM 能区分各家 */
function pname(state: GameState, id: number): string {
  return playerDisplayName(state.players, id);
}

/** 竞争态势：各玩家公开分一行概览，带红蓝绿橙区分 */
function competitionLine(state: GameState, myId: number): string {
  const myVP = publicVP(state, myId);
  const others = state.players
    .filter((p) => p.id !== myId)
    .map((p) => `${pname(state, p.id)}${publicVP(state, p.id)}分`)
    .join(' / ');
  const leading = Math.max(...state.players.map((p) => publicVP(state, p.id)));
  const suffix = myVP < leading ? `（当前最高${leading}分，你落后${leading - myVP}分）` : '（你当前领先）';
  return `得分：你=${pname(state, myId)}${myVP}分 | 对手：${others}${suffix}`;
}

/** 我的建造目标：列出 1-2 个差 1-2 种资源就能完成的计划 */
function myNearGoals(state: GameState, myId: number): string {
  const res = state.players[myId].resources;
  const plans: string[] = [];
  for (const [name, cost] of [
    ['升级城市', COSTS.city],
    ['建造房屋', COSTS.settlement],
    ['购买发展卡', COSTS.dev],
    ['修建道路', COSTS.road],
  ] as [string, Partial<ResMap>][]) {
    const missing: string[] = [];
    for (const r of RESOURCES) {
      const need = (cost[r] ?? 0) - res[r];
      for (let i = 0; i < need; i++) missing.push(r);
    }
    if (missing.length === 0) plans.push(`${name}（资源已够，可立即建造）`);
    else if (missing.length <= 2) plans.push(`${name}（还差：${missing.join('+')}）`);
  }
  return plans.length > 0 ? `我的建造目标：${plans.slice(0, 3).join('；')}` : '';
}

/** 给出某资源的银行兑换比率（帮 LLM 判断"拒绝后能否自力更生"） */
function bankRatioLine(board: Board, state: GameState, playerId: number, resource: Resource): string {
  const ratio = tradeRatio(board, state, playerId, resource);
  return `银行兑换 ${resource}：${ratio}:1（${ratio <= 2 ? '港口优惠' : ratio === 3 ? '通用港口' : '无港口'})`;
}

// ---------- 公共类型 ----------

export interface TradeCounterCandidate {
  id: string;
  label: string;
  /** 还价中我（参与方）给出的资源 */
  give: ResMap;
  /** 还价中我（参与方）要求的资源 */
  receive: ResMap;
}

export interface TradeResponseInput {
  board: Board;
  state: GameState;
  responderId: number;
  offer: TradeOfferEvent;
  history: TradeChatMessageEvent[];
  counterCandidates: TradeCounterCandidate[];
  agent?: AgentPromptContext;
}

export interface TradeResponseOutput {
  decision: 'ACCEPT' | 'REJECT' | 'COUNTER_OFFER';
  counterId?: string;
  message: string;
  /** 该次 LLM 调用的输入快照；仅 LLM provider 有 */
  modelContext?: AiModelContextEvent;
  /** LLM 原始输出（未经 JSON 解析），便于前端排查 */
  rawOutput?: string;
  /** 实际使用的 provider 名称（含模型） */
  provider?: string;
}

export interface TradeProposeInput {
  state: GameState;
  initiatorId: number;
  planLabel: string;
  offer: TradeOfferEvent;
  /** 这笔报价面向的参与方（按意愿度排序），用于在开场白 prompt 里写明交易对象 */
  participants?: number[];
  agent?: AgentPromptContext;
}

export interface TradeProposeOutput {
  message: string;
  modelContext?: AiModelContextEvent;
  rawOutput?: string;
  provider?: string;
}

// ---------- 格式化工具 ----------

function resStr(m: ResMap): string {
  return RESOURCES.filter((r) => m[r] > 0)
    .map((r) => `${r}×${m[r]}`)
    .join(' ') || '无';
}

function hasResources(state: GameState, player: number, res: ResMap): boolean {
  return RESOURCES.every((r) => state.players[player].resources[r] >= res[r]);
}

/** 生成还价候选：参与方给出原来要求的，但要求发起方多给一种资源 */
export function buildCounterCandidates(
  state: GameState,
  offer: TradeOfferEvent,
): TradeCounterCandidate[] {
  if (offer.to == null) return [];
  const candidates: TradeCounterCandidate[] = [];
  const baseReceive = { ...offer.give } as ResMap;

  for (const extra of RESOURCES) {
    const receive = { ...baseReceive } as ResMap;
    receive[extra] = (receive[extra] ?? 0) + 1;
    if (!hasResources(state, offer.from, receive)) continue;
    candidates.push({
      id: `counter-${extra}`,
      label: `我给${resStr(offer.receive)}，但要对方给${resStr(receive)}（多${extra}×1）`,
      give: { ...offer.receive } as ResMap,
      receive,
    });
  }
  return candidates;
}

// ---------- Prompt 构建 ----------

const RESPOND_SYSTEM = `你是卡坦岛交易谈判 AI，正在替一名玩家回应一个资源交换报价。

铁律：
1. 输出必须是严格 JSON：{"decision":"ACCEPT"|"REJECT"|"COUNTER_OFFER","counterId":"（仅还价时填）","message":"1-2句中文"}
2. COUNTER_OFFER 时必须从 counterCandidates 里选一个 id 填入 counterId；列表为空时禁止还价
3. 接受条件：接受后能立即推进某建造目标，或你给出的是纯余量资源
4. 拒绝条件：你正好需要那份资源，或对方明显占便宜
5. message 用第一人称，1-2句，带点你的角色个性，别客套
6. 只输出 JSON，不要代码块或其他文字`;

const PROPOSE_SYSTEM = `你是卡坦岛交易谈判 AI，正在替一名玩家生成交易开场白。

铁律：
1. 输出必须是严格 JSON：{"message":"1-2句中文开场白"}
2. 说明你想用什么换什么，以及为什么这对双方有利
3. 第一人称，带角色个性，简洁有力，不要客套话
4. 只输出 JSON，不要代码块或其他文字`;

function buildRespondUserMessage(input: TradeResponseInput): string {
  const { board, state, responderId, offer, history, counterCandidates, agent } = input;
  const me = state.players[responderId];
  const initiator = state.players[offer.from];
  const parts: string[] = [];

  if (agent) {
    parts.push(`你的角色：${agent.name}（${agent.personality}）`);
    if (agent.stance) parts.push(`当前策略：${agent.stance}`);
    if (agent.memory.length > 0) {
      parts.push(`近期记忆：${agent.memory.slice(-3).join(' | ')}`);
    }
    parts.push('');
  }

  // 身份与对手：明确"我是谁"和"在跟谁交易"
  parts.push(`你的身份：${pname(state, responderId)}（正在回应 ${pname(state, offer.from)} 的报价）`);

  // 竞争态势
  parts.push(competitionLine(state, responderId));

  // 我的资源与手牌
  parts.push(`你（${pname(state, responderId)}）的资源：${resStr(me.resources as ResMap)}`);
  const hand = handSize(me);
  if (hand > 7) parts.push(`⚠ 手牌 ${hand} 张，若有人掷 7 需弃 ${Math.floor(hand / 2)} 张`);

  // 我的建造目标（知道自己差什么）
  const goals = myNearGoals(state, responderId);
  if (goals) parts.push(goals);

  // 发起方信息（对手状态）
  const initVP = publicVP(state, offer.from);
  const initHand = handSize(initiator);
  parts.push(`报价方 ${pname(state, offer.from)}：${initVP}分，手牌${initHand}张`);
  parts.push('');

  parts.push(`本次交易：${pname(state, offer.from)} → 你（${pname(state, responderId)}）`);
  parts.push(`${pname(state, offer.from)} 向你报价：`);
  parts.push(`  对方给你：${resStr(offer.give)}`);
  parts.push(`  你需要给出：${resStr(offer.receive)}`);

  // 给出资源的银行替代方案
  for (const r of RESOURCES) {
    if ((offer.receive[r] ?? 0) > 0) {
      parts.push(`  （${bankRatioLine(board, state, responderId, r)}）`);
    }
  }
  parts.push('');

  if (history.length > 0) {
    parts.push('本轮对话历史：');
    for (const msg of history.slice(-4)) {
      const name = msg.speaker == null ? '系统' : pname(state, msg.speaker);
      parts.push(`  [${name}/${msg.decision}] ${msg.message}`);
    }
    parts.push('');
  }

  if (counterCandidates.length > 0) {
    parts.push('还价选项（COUNTER_OFFER 时从中选 id）：');
    for (const c of counterCandidates) {
      parts.push(`  ${c.id}  ${c.label}`);
    }
  } else {
    parts.push('（无可用还价选项，只能 ACCEPT 或 REJECT）');
  }
  parts.push('');
  parts.push('输出 JSON：');
  return parts.join('\n');
}

function buildProposeUserMessage(input: TradeProposeInput): string {
  const { state, initiatorId, planLabel, offer, participants, agent } = input;
  const me = state.players[initiatorId];
  const parts: string[] = [];

  if (agent) {
    parts.push(`你的角色：${agent.name}（${agent.personality}）`);
    if (agent.currentTurnGoal) parts.push(`本回合目标：${agent.currentTurnGoal}`);
    if (agent.stance) parts.push(`当前策略：${agent.stance}`);
    parts.push('');
  }

  // 身份
  parts.push(`你的身份：${pname(state, initiatorId)}`);

  // 竞争态势
  parts.push(competitionLine(state, initiatorId));

  // 我的状态
  parts.push(`你（${pname(state, initiatorId)}）的资源：${resStr(me.resources as ResMap)}`);
  parts.push(`你正在追求：${planLabel}`);

  // 建造目标（帮 LLM 说清楚为什么想要这个资源）
  const goals = myNearGoals(state, initiatorId);
  if (goals) parts.push(goals);
  parts.push('');

  parts.push('你发起的报价：');
  if (participants && participants.length > 0) {
    parts.push(`  交易对象：${participants.map((id) => pname(state, id)).join('、')}`);
  }
  parts.push(`  你给出：${resStr(offer.give)}`);
  parts.push(`  你想换：${resStr(offer.receive)}`);
  parts.push('');
  parts.push('生成一句简洁有力的交易开场白 JSON：');
  return parts.join('\n');
}

// ---------- LLM 调用 ----------

async function callLlm(providerName: string, system: string, user: string): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TRADE_TIMEOUT_MS);

  try {
    if (providerName === 'minimax') {
      const resp = await fetch(`https://${MINIMAX_HOST}/anthropic/v1/messages`, {
        method: 'POST',
        signal: ctl.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': MINIMAX_API_KEY,
          Authorization: `Bearer ${MINIMAX_API_KEY}`,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MINIMAX_MODEL,
          max_tokens: 256,
          temperature: TRADE_TEMPERATURE,
          system,
          messages: [{ role: 'user', content: user }],
          ...(MINIMAX_ENABLE_THINKING ? {} : { thinking: { type: 'disabled' } }),
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`MiniMax trade HTTP ${resp.status}: ${body.slice(0, 200)}`);
      }
      const json = (await resp.json()) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const text = (json.content ?? [])
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text!)
        .join('');
      if (!text) throw new Error('MiniMax trade 无 text 块');
      return text;
    }

    // qwen36
    const url = `${QWEN_BASE_URL.replace(/\/+$/, '')}/chat/completions`;
    const resp = await fetch(url, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${QWEN_API_KEY}` },
      body: JSON.stringify({
        model: QWEN_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: 256,
        temperature: TRADE_TEMPERATURE,
        enable_thinking: QWEN_ENABLE_THINKING,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Qwen trade HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    const json = (await resp.json()) as {
      choices?: Array<{
        message?: { content?: string | Array<{ type?: string; text?: string }> };
      }>;
    };
    const content = json.choices?.[0]?.message?.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((b) => b.text ?? '').join('')
          : '';
    if (!text) throw new Error('Qwen trade 无内容');
    return text;
  } catch (err) {
    if ((err as Error).name === 'AbortError')
      throw new Error(`交易 LLM 超时（>${TRADE_TIMEOUT_MS}ms）`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- JSON 解析 ----------

function extractJson(raw: string): unknown {
  const t = raw.trim();
  for (const fn of [
    () => JSON.parse(t),
    () => {
      const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (!m) throw new Error('no fence');
      return JSON.parse(m[1]);
    },
    () => {
      const s = t.indexOf('{');
      if (s < 0) throw new Error('no brace');
      let d = 0;
      for (let i = s; i < t.length; i++) {
        if (t[i] === '{') d++;
        else if (t[i] === '}') {
          d--;
          if (d === 0) return JSON.parse(t.slice(s, i + 1));
        }
      }
      throw new Error('unmatched');
    },
  ]) {
    try {
      return fn();
    } catch {
      /* continue */
    }
  }
  throw new Error('JSON 解析失败：' + raw.slice(0, 200));
}

// ---------- 规则 fallback ----------

function ruleTradeResponse(input: TradeResponseInput): TradeResponseOutput {
  const { state, responderId, offer, counterCandidates } = input;
  const directOffer: TradeOfferEvent = {
    from: offer.from,
    to: responderId,
    give: { ...offer.give } as ResMap,
    receive: { ...offer.receive } as ResMap,
  };

  if (aiAcceptsTrade(state, responderId, directOffer.give, directOffer.receive)) {
    return { decision: 'ACCEPT', message: '这笔交换对我有利，成交。' };
  }

  for (const c of counterCandidates) {
    if (aiAcceptsTrade(state, offer.from, c.give, c.receive)) {
      return { decision: 'COUNTER_OFFER', counterId: c.id, message: '原报价我接受不了，但可以调整一下条件。' };
    }
  }

  return { decision: 'REJECT', message: '这个价不合算，没法接受。' };
}

// ---------- 公开接口 ----------

function buildTradeModelContext(
  providerName: string,
  systemPrompt: string,
  userPrompt: string,
  counterCount?: number,
): AiModelContextEvent {
  return {
    provider: providerName,
    format: 'llm-prompt',
    legalActionCount: counterCount ?? 0,
    retryFeedbackCount: 0,
    chars: {
      system: systemPrompt.length,
      user: userPrompt.length,
      total: systemPrompt.length + userPrompt.length,
    },
    systemPrompt,
    userPrompt,
  };
}

/** 给前端展示用的 provider 标签（含模型 ID） */
function providerLabel(providerName: string): string {
  if (providerName === 'minimax')
    return `minimax(${process.env.LLM_MODEL ?? 'MiniMax-M2.7'})`;
  if (providerName === 'qwen36')
    return `qwen(${process.env.QWEN_MODEL ?? process.env.ALI_QWEN_MODEL ?? 'qwen3.6-plus'})`;
  return providerName;
}

/** 参与方回应报价：返回 ACCEPT / REJECT / COUNTER_OFFER + message */
export async function decideTradeResponse(
  input: TradeResponseInput,
  providerName: string,
): Promise<TradeResponseOutput> {
  const isLlm = providerName === 'minimax' || providerName === 'qwen36';
  if (!isLlm) return ruleTradeResponse(input);

  const user = buildRespondUserMessage(input);
  const providerLbl = providerLabel(providerName);
  const modelContext = buildTradeModelContext(
    providerLbl,
    RESPOND_SYSTEM,
    user,
    input.counterCandidates.length,
  );

  try {
    const raw = await callLlm(providerName, RESPOND_SYSTEM, user);
    const parsed = extractJson(raw) as Record<string, unknown>;

    const decision = parsed.decision;
    if (decision !== 'ACCEPT' && decision !== 'REJECT' && decision !== 'COUNTER_OFFER') {
      throw new Error(`decision 非法：${decision}`);
    }
    const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
    const counterId = typeof parsed.counterId === 'string' ? parsed.counterId.trim() : undefined;

    if (decision === 'COUNTER_OFFER') {
      const valid = input.counterCandidates.find((c) => c.id === counterId);
      if (!valid) {
        console.warn(`[trade-llm] COUNTER_OFFER counterId "${counterId}" 非法，降级 REJECT`);
        return {
          decision: 'REJECT',
          message: message || '还价方案不可行，只好拒绝。',
          modelContext,
          rawOutput: raw,
          provider: providerLbl,
        };
      }
    }

    return {
      decision,
      counterId: counterId || undefined,
      message,
      modelContext,
      rawOutput: raw,
      provider: providerLbl,
    };
  } catch (err) {
    console.warn(`[trade-llm] ${providerName} 失败，走规则 fallback：${(err as Error).message}`);
    const ruled = ruleTradeResponse(input);
    return { ...ruled, modelContext, rawOutput: `[LLM 调用失败] ${(err as Error).message}`, provider: providerLbl };
  }
}

/** 发起方生成提议开场白；失败时返回规则拼字符串 */
export async function generateProposeMessage(
  input: TradeProposeInput,
  providerName: string,
  fallbackMessage: string,
): Promise<TradeProposeOutput> {
  const isLlm = providerName === 'minimax' || providerName === 'qwen36';
  if (!isLlm) return { message: fallbackMessage };

  const user = buildProposeUserMessage(input);
  const providerLbl = providerLabel(providerName);
  const modelContext = buildTradeModelContext(providerLbl, PROPOSE_SYSTEM, user);

  try {
    const raw = await callLlm(providerName, PROPOSE_SYSTEM, user);
    const parsed = extractJson(raw) as Record<string, unknown>;
    const msg = typeof parsed.message === 'string' ? parsed.message.trim() : '';
    return {
      message: msg || fallbackMessage,
      modelContext,
      rawOutput: raw,
      provider: providerLbl,
    };
  } catch (err) {
    console.warn(`[trade-llm] propose 消息失败，用默认：${(err as Error).message}`);
    return {
      message: fallbackMessage,
      modelContext,
      rawOutput: `[LLM 调用失败] ${(err as Error).message}`,
      provider: providerLbl,
    };
  }
}
