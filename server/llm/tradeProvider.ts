// ============================================================
// 交易谈判 LLM Provider：提议消息生成 + 回应决策（接受/拒绝/还价）
// ------------------------------------------------------------
// 三种调用：
//   generateProposeMessage：发起方生成开场白（不决策，只出文字）
//   decideTradeResponse：参与方回应报价，输出 decision + message
//   decideTradeChatResponse：参与方回应无报价喊话，只出文字
// rule/mock provider 直接走 aiAcceptsTrade 规则兜底，不调 LLM。
// ============================================================

import { aiAcceptsTrade } from '../../shared/ai';
import type { Board, GameState, ResMap, Resource } from '../../shared/types';
import { RESOURCES, COSTS, emptyRes } from '../../shared/types';
import { playerDisplayName } from '../../shared/state';
import { publicVP, tradeRatio, handSize } from '../../shared/rules';
import type {
  TradeOfferEvent,
  TradeChatMessageEvent,
  AiModelContextEvent,
} from '../../shared/protocol';
import type { AgentPromptContext } from './types';
import { findModel, isLlmProvider, providerLabel } from './modelRegistry';

// socialProvider 仍从本模块 import { providerLabel, isLlmProvider }，故把注册表的实现再导出
export { providerLabel, isLlmProvider };

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

export interface TradeChatInput {
  state: GameState;
  responderId: number;
  history: TradeChatMessageEvent[];
  agent?: AgentPromptContext;
}

export interface TradeChatOutput {
  message: string;
  modelContext?: AiModelContextEvent;
  rawOutput?: string;
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

export interface TradeInitiationInput {
  board: Board;
  state: GameState;
  initiatorId: number;
  /** 本回合剩余可发起交易次数（含本次） */
  sessionsRemaining: number;
  agent?: AgentPromptContext;
}

export interface TradeInitiationOutput {
  /** 是否发起交易 */
  initiate: boolean;
  /** 发起方给出的资源（自由构造，由 negotiationManager 二次校验） */
  give: ResMap;
  /** 发起方想换到的资源 */
  receive: ResMap;
  /** 开场白（initiate=true 时用作 PROPOSE 文案） */
  message?: string;
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

对局规则与限制：
- 牌局先到 10 分（含隐藏胜利点卡）者获胜；你只看得到对手的公开分，其真实分可能更高。
- 你看不到对手的具体手牌种类，只知道手牌总数。
- 反资敌：别接受会让对方（尤其公开分领先你、或已接近 10 分获胜的对手）完成关键建造或抢分的交易，哪怕你能拿到想要的资源。
- 这单交易最多再还价 1 次，还价被拒就作废——能直接推进你自己建造目标的成交，别为多要 1 张资源而让它告吹。

铁律：
1. 输出必须是严格 JSON：{"decision":"ACCEPT"|"REJECT"|"COUNTER_OFFER","counterId":"（仅还价时填）","message":"1-2句中文"}
2. COUNTER_OFFER 时必须从 counterCandidates 里选一个 id 填入 counterId；列表为空时禁止还价
3. 接受条件：接受后能立即推进某建造目标、或你给出的是纯余量资源，且这笔不会明显资敌
4. 拒绝条件：你正好需要那份资源、对方明显占便宜，或这笔会帮到领先/快赢的对手
5. message 用第一人称，1-2句，带点你的角色个性，别客套
6. 只输出 JSON，不要代码块或其他文字`;

const PROPOSE_SYSTEM = `你是卡坦岛交易谈判 AI，正在替一名玩家生成交易开场白。

铁律：
1. 输出必须是严格 JSON：{"message":"1-2句中文开场白"}
2. 说明你想用什么换什么，以及为什么这对双方有利
3. 第一人称，带角色个性，简洁有力，不要客套话
4. 只输出 JSON，不要代码块或其他文字`;

const CHAT_SYSTEM = `你是卡坦岛交易谈判 AI，正在替一名玩家回应真人玩家的喊话。

当前没有结构化报价，因此你不能承诺成交，也不要说“接受”或“成交”。你可以：
- 表态自己缺什么 / 愿意考虑什么资源交换；
- 回应真人对某个玩家的点名或挑拨；
- 简短施压、拒绝、试探，体现你的角色个性。

铁律：
1. 输出必须是严格 JSON：{"message":"1-2句中文"}
2. 如果真人喊话里点名“小红/红色/红/P0”等别名，要按输入里的玩家身份识别
3. 不要编造自己没有的资源数量；可以说“如果你出麦/矿我会考虑”
4. 只输出 JSON，不要代码块或其他文字`;

const INITIATE_SYSTEM = `你是卡坦岛交易发起 AI，正在替一名玩家决定「此刻要不要向其他 AI 发起一笔资源交易，以及报什么价」。

对局规则与限制：
1. 牌局先到 10 分（含隐藏胜利点卡）者获胜。交易只能交换资源（木/砖/羊/麦/矿），不能换分数、地块或发展卡。
2. 报价 = 你给出 give + 你想换 receive，不必 1:1：紧缺且自己难产的资源值得用 2 换 1 甚至更高。但 give 只能用你真正拥有的资源，give 总量不要超过 4 张；give 与 receive 不能含同一种资源。
3. 结构限制：你本回合最多发起 2 次交易（看输入里的 sessionsRemaining 还剩几次）；单次谈判最多 8 条发言、最多 1 次还价、每人最多回 2 次。发起次数有限，别为蝇头小利浪费机会。
4. 反资敌：你看不到对手的具体手牌（只知总数）。别送出会让对手完成关键建造、抢分或逼近 10 分获胜的资源；对公开分领先你的对手尤其谨慎。
5. 自己判断时机：只在交易确实能推进你的建造目标、或换到当前紧缺且银行兑换又太亏的资源时才发起；否则 initiate=false，把发起机会留给更值的时刻。能用银行港口比率（输入里给了）自力更生时就别开口求人。

输出严格 JSON：{"initiate":true,"give":{"麦":2},"receive":{"矿":1},"message":"1-2句中文开场白，说清想换什么、为什么"}
- initiate=false 时 give/receive 给空对象 {}，message 可留空
- give/receive 用资源名做 key、数量（正整数）做 value，只列数量>0 的项
- 只输出 JSON，不要代码块或其他文字`;

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
    if (agent.relationships) parts.push(`你对各家的看法：${agent.relationships}`);
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
    if (agent.relationships) parts.push(`你对各家的看法：${agent.relationships}`);
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

function buildChatUserMessage(input: TradeChatInput): string {
  const { state, responderId, history, agent } = input;
  const me = state.players[responderId];
  const parts: string[] = [];

  if (agent) {
    parts.push(`你的角色：${agent.name}（${agent.personality}）`);
    if (agent.stance) parts.push(`当前策略：${agent.stance}`);
    if (agent.memory.length > 0) {
      parts.push(`近期记忆：${agent.memory.slice(-4).join(' | ')}`);
    }
    if (agent.relationships) parts.push(`你对各家的看法：${agent.relationships}`);
    parts.push('');
  }

  parts.push(`你的身份：${pname(state, responderId)}（正在回应真人玩家的喊话）`);
  parts.push(competitionLine(state, responderId));
  parts.push(`你的资源：${resStr(me.resources as ResMap)}（手牌${handSize(me)}张）`);
  const goals = myNearGoals(state, responderId);
  if (goals) parts.push(goals);
  parts.push('');

  parts.push('玩家身份与常用别名：');
  for (const p of state.players) {
    const display = pname(state, p.id);
    parts.push(`  P${p.id}=${display}（可称：${display}、小${display}、${display}色、P${p.id}）`);
  }
  parts.push('');

  parts.push('本轮对话历史：');
  for (const msg of history.slice(-8)) {
    const name = msg.speaker == null ? '系统' : pname(state, msg.speaker);
    parts.push(`  [${name}/${msg.decision}] ${msg.message}`);
  }
  parts.push('');
  parts.push('请回应最后一条真人喊话。输出 JSON：');
  return parts.join('\n');
}

function buildInitiateUserMessage(input: TradeInitiationInput, feedback?: string): string {
  const { board, state, initiatorId, sessionsRemaining, agent } = input;
  const me = state.players[initiatorId];
  const parts: string[] = [];

  if (agent) {
    parts.push(`你的角色：${agent.name}（${agent.personality}）`);
    if (agent.currentTurnGoal) parts.push(`本回合目标：${agent.currentTurnGoal}`);
    if (agent.stance) parts.push(`当前策略：${agent.stance}`);
    if (agent.relationships) parts.push(`你对各家的看法：${agent.relationships}`);
    parts.push('');
  }

  parts.push(`你的身份：${pname(state, initiatorId)}`);
  parts.push(competitionLine(state, initiatorId));
  parts.push(`你的资源：${resStr(me.resources as ResMap)}（手牌${handSize(me)}张）`);

  const goals = myNearGoals(state, initiatorId);
  if (goals) parts.push(goals);

  // 银行替代方案：让模型判断"自力更生 vs 求人"
  const ratios = RESOURCES.map((r) => `${r}=${tradeRatio(board, state, initiatorId, r)}:1`).join(' ');
  parts.push(`银行/港口兑换比率：${ratios}`);
  parts.push('');

  // 其他玩家概览（反资敌判断；手牌种类不可见）
  parts.push('其他玩家（只知公开分与手牌总数，看不到具体手牌）：');
  for (const p of state.players) {
    if (p.id === initiatorId) continue;
    const tag = p.isAI ? '' : '（人类）';
    parts.push(`  ${pname(state, p.id)}${tag}：${publicVP(state, p.id)}分，手牌${handSize(p)}张`);
  }
  parts.push('');

  parts.push(
    `本回合还可发起交易：${sessionsRemaining} 次（上限 2）。单次谈判：最多 8 条发言、最多 1 次还价、每人最多回 2 次。`,
  );

  if (feedback) {
    parts.push('');
    parts.push(`【上次报价不合规】${feedback}`);
    parts.push('请修正后重新输出 JSON（或 initiate=false 放弃发起）。');
  }

  parts.push('');
  parts.push('决定是否发起交易并给出报价，输出 JSON：');
  return parts.join('\n');
}

// ---------- LLM 调用 ----------

export async function callLlm(providerName: string, system: string, user: string): Promise<string> {
  const spec = findModel(providerName);
  if (!spec) throw new Error(`未知 LLM provider：${providerName}`);
  const apiKey = process.env[spec.apiKeyEnv] ?? '';

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TRADE_TIMEOUT_MS);

  try {
    if (spec.api === 'anthropic') {
      const resp = await fetch(`https://${spec.endpoint}/anthropic/v1/messages`, {
        method: 'POST',
        signal: ctl.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          Authorization: `Bearer ${apiKey}`,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: spec.model,
          max_tokens: 256,
          temperature: TRADE_TEMPERATURE,
          system,
          messages: [{ role: 'user', content: user }],
          ...(spec.enableThinking ? {} : { thinking: { type: 'disabled' } }),
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`${spec.label} trade HTTP ${resp.status}: ${body.slice(0, 200)}`);
      }
      const json = (await resp.json()) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const text = (json.content ?? [])
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text!)
        .join('');
      if (!text) throw new Error(`${spec.label} trade 无 text 块`);
      return text;
    }

    // openai 兼容（qwen 等）
    const url = `${spec.endpoint.replace(/\/+$/, '')}/chat/completions`;
    const resp = await fetch(url, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: spec.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: 256,
        temperature: TRADE_TEMPERATURE,
        enable_thinking: spec.enableThinking,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`${spec.label} trade HTTP ${resp.status}: ${body.slice(0, 200)}`);
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
    if (!text) throw new Error(`${spec.label} trade 无内容`);
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

export function extractJson(raw: string): unknown {
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

/** 把模型输出的 give/receive 解析成干净的 ResMap：只收 5 种资源、正整数 */
function parseResMap(v: unknown): ResMap {
  const out = emptyRes();
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    for (const r of RESOURCES) {
      const n = obj[r];
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) out[r] = Math.floor(n);
    }
  }
  return out;
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

function ruleTradeChatResponse(input: TradeChatInput): TradeChatOutput {
  const goals = myNearGoals(input.state, input.responderId);
  return {
    message: goals
      ? `我听到了。${goals}，如果你能给我缺的资源，我会认真考虑。`
      : '我听到了。先把你愿意给什么、想换什么说清楚，我再表态。',
  };
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

/** 参与方回应报价：返回 ACCEPT / REJECT / COUNTER_OFFER + message */
export async function decideTradeResponse(
  input: TradeResponseInput,
  providerName: string,
): Promise<TradeResponseOutput> {
  const isLlm = isLlmProvider(providerName);
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

/** 参与方回应无报价喊话：返回自然语言消息，不产生成交候选 */
export async function decideTradeChatResponse(
  input: TradeChatInput,
  providerName: string,
): Promise<TradeChatOutput> {
  const isLlm = isLlmProvider(providerName);
  if (!isLlm) return ruleTradeChatResponse(input);

  const user = buildChatUserMessage(input);
  const providerLbl = providerLabel(providerName);
  const modelContext = buildTradeModelContext(providerLbl, CHAT_SYSTEM, user);

  try {
    const raw = await callLlm(providerName, CHAT_SYSTEM, user);
    const parsed = extractJson(raw) as Record<string, unknown>;
    const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
    return {
      message: message || ruleTradeChatResponse(input).message,
      modelContext,
      rawOutput: raw,
      provider: providerLbl,
    };
  } catch (err) {
    console.warn(`[trade-llm] chat 失败，走规则 fallback：${(err as Error).message}`);
    const ruled = ruleTradeChatResponse(input);
    return {
      ...ruled,
      modelContext,
      rawOutput: `[LLM 调用失败] ${(err as Error).message}`,
      provider: providerLbl,
    };
  }
}

/**
 * 发起方决定是否发起交易 + 自由构造报价（give/receive）。
 * 非 LLM provider（rule/mock）返回 initiate:false，让 negotiationManager 走规则候选兜底。
 * 报价的合法性（拥有/非空/不自换/总量上限/有对手能兑现/dry-run）由 negotiationManager 二次校验。
 */
export async function decideTradeInitiation(
  input: TradeInitiationInput,
  providerName: string,
  feedback?: string,
): Promise<TradeInitiationOutput> {
  const isLlm = isLlmProvider(providerName);
  if (!isLlm) return { initiate: false, give: emptyRes(), receive: emptyRes() };

  const user = buildInitiateUserMessage(input, feedback);
  const providerLbl = providerLabel(providerName);
  const modelContext = buildTradeModelContext(providerLbl, INITIATE_SYSTEM, user);

  try {
    const raw = await callLlm(providerName, INITIATE_SYSTEM, user);
    const parsed = extractJson(raw) as Record<string, unknown>;
    const initiate = parsed.initiate === true;
    const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
    return {
      initiate,
      give: parseResMap(parsed.give),
      receive: parseResMap(parsed.receive),
      message: message || undefined,
      modelContext,
      rawOutput: raw,
      provider: providerLbl,
    };
  } catch (err) {
    console.warn(`[trade-llm] 发起决策失败，跳过 LLM 发起：${(err as Error).message}`);
    return {
      initiate: false,
      give: emptyRes(),
      receive: emptyRes(),
      modelContext,
      rawOutput: `[LLM 调用失败] ${(err as Error).message}`,
      provider: providerLbl,
    };
  }
}

/** 发起方生成提议开场白；失败时返回规则拼字符串 */
export async function generateProposeMessage(
  input: TradeProposeInput,
  providerName: string,
  fallbackMessage: string,
): Promise<TradeProposeOutput> {
  const isLlm = isLlmProvider(providerName);
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
