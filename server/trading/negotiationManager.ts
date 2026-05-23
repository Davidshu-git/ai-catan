// ============================================================
// AI 交易谈判管理器
// ------------------------------------------------------------
// 调用 LLM（或规则 fallback）为每个参与方生成真实决策 + 自然语言消息。
// tradeDecide 函数由 server/index.ts 按玩家注入（持有 providerName）。
// ============================================================

import {
  COSTS,
  RESOURCES,
  RESOURCE_LABEL,
  emptyRes,
  type Board,
  type GameState,
  type ResMap,
  type Resource,
} from '../../shared/types';
import {
  canBuildCity,
  canBuildRoad,
  canBuildSettlement,
  handSize,
  publicVP,
} from '../../shared/rules';
import { playerDisplayName } from '../../shared/state';
import { cloneOffer, cloneRes, dryRunTrade, hasResources, resStr } from './roomCore';
import type {
  TradeChatClosedEvent,
  TradeChatMessageEvent,
  TradeChatStartedEvent,
  TradeDecisionEvent,
  TradeLimitsEvent,
  TradeOfferEvent,
  TradeSessionStatus,
} from '../../shared/protocol';
import type { AgentPromptContext } from '../llm/types';
import {
  buildCounterCandidates,
  type TradeResponseOutput,
  type TradeProposeOutput,
  type TradeInitiationOutput,
} from '../llm/tradeProvider';

const TRADE_LIMITS = {
  sessionsPerTurn: 2,
  // 多轮房间式谈判放宽预算，但 messagesPerSession 仍是每个 session 的 LLM 调用硬上限。
  messagesPerSession: 12,
  offersPerSession: 5,
  counterOffersPerSession: 4,
  // 每人发言上限 3：发起方=开场白(1)+最多2次反应；参与方=最多 3 轮反应。
  repliesPerPlayer: 3,
};

// 一个 session 内"参与方互相反应 + 发起方回应"的最大轮数。
// 配合 messagesPerSession 双重封顶 LLM 调用次数，避免 token 失控。
const ROOM_ROUNDS_MAX = Math.max(1, Number(process.env.ROOM_ROUNDS_MAX ?? 2));

// LLM 自由报价的安全上限：give 最多 4 张（允许"高报价"换紧缺资源），receive 最多 3 张
const MAX_GIVE_CARDS = 4;
const MAX_RECEIVE_CARDS = 3;
// 发起报价校验不过时，"模型可修复"类错误带反馈重试的次数（默认 1，即最多 2 次发起调用）
const MAX_INIT_RETRIES = Number(process.env.TRADE_INIT_RETRIES ?? 1);

const PLAN_PRIORITY = [
  { id: 'city', label: '升级城市', cost: COSTS.city, priority: 5 },
  { id: 'settlement', label: '建造房屋', cost: COSTS.settlement, priority: 4 },
  { id: 'dev', label: '购买发展卡', cost: COSTS.dev, priority: 3 },
  { id: 'road', label: '修建道路', cost: COSTS.road, priority: 2 },
] as const;

const RESOURCE_WEIGHT: Record<Resource, number> = {
  木: 1.05,
  砖: 1.05,
  羊: 1,
  麦: 1.25,
  矿: 1.2,
};

export interface AiTradeLedger {
  turnKey: string;
  sessionSeq: number;
  sessionsByPlayer: Record<number, number>;
  dealsByPair: Record<string, boolean>;
  rejectedOfferKeys: Record<string, boolean>;
}

export type TradeEventEntry =
  | { kind: 'started'; data: TradeChatStartedEvent }
  | { kind: 'message'; data: TradeChatMessageEvent }
  | { kind: 'closed'; data: TradeChatClosedEvent };

export interface AiNegotiationResult {
  events: TradeEventEntry[];
  nextState: GameState | null;
  /** 成交时的最终报价（from/to/give/receive）；供关系账本记账，未成交为 undefined */
  acceptedTrade?: TradeOfferEvent;
}

/**
 * 注入函数：server/index.ts 按玩家的 agent providerName 决定调用哪个 LLM。
 * responderId: 当前做决策的玩家（发起方回应还价时 responderId = initiator）
 */
export type TradeDecideFn = (
  responderId: number,
  board: Board,
  state: GameState,
  offer: TradeOfferEvent,
  history: TradeChatMessageEvent[],
  agent?: AgentPromptContext,
) => Promise<TradeResponseOutput>;

/**
 * 注入函数：生成发起方提议的开场白消息。
 * 返回 message + 可选的 modelContext/rawOutput，便于前端可视化模型输入与原始输出。
 */
export type TradeProposeMessageFn = (
  initiatorId: number,
  planLabel: string,
  offer: TradeOfferEvent,
  participants: number[],
  fallback: string,
  agent?: AgentPromptContext,
) => Promise<TradeProposeOutput>;

/**
 * 注入函数：让发起方 LLM 决定是否发起交易 + 自由构造报价。
 * 返回 initiate=false 时（含非 LLM provider）→ manager 走规则候选兜底。
 */
export type TradeInitiateFn = (
  initiatorId: number,
  board: Board,
  state: GameState,
  sessionsRemaining: number,
  agent: AgentPromptContext | undefined,
  feedback: string | undefined,
) => Promise<TradeInitiationOutput>;

/** 发起报价校验结果：ok→可用；retryable→模型可修复（带反馈重试）；否则转规则兜底 */
type InitiationResolveResult =
  | { ok: true; resolved: ResolvedInitiation }
  | { ok: false; retryable: true; reason: string }
  | { ok: false; retryable: false };

/** 发起决策解析结果：LLM 自由报价与规则候选统一成这个结构后驱动会话 */
interface ResolvedInitiation {
  planLabel: string;
  /** to=null 的广播报价 */
  offer: TradeOfferEvent;
  participants: number[];
  offerKey: string;
  /** LLM 路径：直接用作 PROPOSE 文案；规则路径：null（再调 tradeProposeMessage 生成） */
  openingMessage: string | null;
  openingMeta?: MessageMeta;
}

interface TradeCandidate {
  planLabel: string;
  need: Resource;
  give: Resource;
  participants: number[];
  score: number;
  offerKey: string;
  offer: TradeOfferEvent;
}

interface SessionCounters {
  messagesUsed: number;
  offersUsed: number;
  counterOffersUsed: number;
  repliesByPlayer: Record<number, number>;
}

export function createAiTradeLedger(): AiTradeLedger {
  return {
    turnKey: '',
    sessionSeq: 0,
    sessionsByPlayer: {},
    dealsByPair: {},
    rejectedOfferKeys: {},
  };
}

export async function maybeRunAiNegotiation(
  board: Board,
  state: GameState,
  ledger: AiTradeLedger,
  tradeDecide: TradeDecideFn,
  tradeProposeMessage: TradeProposeMessageFn,
  tradeInitiate: TradeInitiateFn,
  getAgent: (playerId: number) => AgentPromptContext | undefined,
  onEvent: (entry: TradeEventEntry) => void,
): Promise<AiNegotiationResult | null> {
  if (state.phase !== 'main') return null;
  const initiator = state.current;
  if (!state.players[initiator]?.isAI) return null;

  ensureLedgerTurn(ledger, state);
  const usedSessions = ledger.sessionsByPlayer[initiator] ?? 0;
  if (usedSessions >= TRADE_LIMITS.sessionsPerTurn) return null;
  const sessionsRemaining = TRADE_LIMITS.sessionsPerTurn - usedSessions;

  // 优先让发起方 LLM 决定是否发起 + 自由构造报价；不发起/校验不过/规则 provider → 规则候选兜底。
  // 校验为"模型可修复"错误（如 give 超额、自换、超上限）时，带反馈重试 MAX_INIT_RETRIES 次；
  // "非模型可修复"错误（无可成交对手等）直接转规则兜底，不浪费 token 重试。
  let resolved: ResolvedInitiation | null = null;
  let feedback: string | undefined;
  for (let attempt = 0; attempt <= MAX_INIT_RETRIES; attempt++) {
    const init = await tradeInitiate(initiator, board, state, sessionsRemaining, getAgent(initiator), feedback);
    if (!init.initiate) break; // 模型主动不发起 → 不重试
    const res = resolveLlmInitiation(state, ledger, initiator, init);
    if (res.ok) {
      resolved = res.resolved;
      break;
    }
    if (!res.retryable) break; // 非模型可修复 → 转规则兜底
    feedback = res.reason; // 可修复 → 带反馈再试
  }
  if (!resolved) {
    const candidate = chooseTradeCandidate(board, state, ledger);
    if (!candidate) return null;
    resolved = {
      planLabel: candidate.planLabel,
      offer: candidate.offer,
      participants: candidate.participants,
      offerKey: candidate.offerKey,
      openingMessage: null,
    };
  }

  ledger.sessionSeq++;
  ledger.sessionsByPlayer[initiator] = usedSessions + 1;

  const sessionId = `trade-t${state.turn}-p${initiator}-${ledger.sessionSeq}`;
  const counters: SessionCounters = {
    messagesUsed: 0,
    offersUsed: 1,
    counterOffersUsed: 0,
    repliesByPlayer: {},
  };
  const events: TradeEventEntry[] = [];
  const limits = () => buildLimits(counters, ledger, initiator);
  const history = () => events.filter((e): e is { kind: 'message'; data: TradeChatMessageEvent } => e.kind === 'message').map((e) => e.data);
  const push = (entry: TradeEventEntry) => { events.push(entry); onEvent(entry); };

  const startedEntry: TradeEventEntry = {
    kind: 'started',
    data: {
      sessionId,
      turn: state.turn,
      phase: state.phase,
      initiator,
      participants: resolved.participants,
      proposedTrade: cloneOffer(resolved.offer),
      limits: limits(),
      ts: Date.now(),
    },
  };
  push(startedEntry);

  // 发起方开场白：LLM 路径直接用其决策时给的文案；规则路径再调 tradeProposeMessage
  if (resolved.openingMessage) {
    pushMessage(
      push, sessionId, state.turn, counters, limits, initiator,
      'PROPOSE', resolved.openingMessage, resolved.offer, resolved.openingMeta,
    );
  } else {
    const fallbackPropose = `${playerName(state, initiator)}想推进${resolved.planLabel}，愿意给出${resStr(resolved.offer.give)}换${resStr(resolved.offer.receive)}。`;
    const proposeOut = await tradeProposeMessage(
      initiator,
      resolved.planLabel,
      resolved.offer,
      resolved.participants,
      fallbackPropose,
      getAgent(initiator),
    );
    pushMessage(
      push, sessionId, state.turn, counters, limits, initiator,
      'PROPOSE', proposeOut.message, resolved.offer,
      { modelContext: proposeOut.modelContext, rawOutput: proposeOut.rawOutput, provider: proposeOut.provider },
    );
  }

  // ── 多轮房间式谈判 ──────────────────────────────────────
  // 与旧的"每人回应一次"不同：参与方每轮都能看到完整 history（含其他人本轮/上轮的
  // 还价、发起方的反应），从而互相反应；发起方每轮挑一个对自己最有利的还价回应；
  // 同一轮多人接受底价时竞争择优、原子只成交一笔。轮数 + messagesPerSession 双重封顶。
  const live = new Set<number>(resolved.participants); // 仍在场的参与方
  const standingCounters = new Map<number, TradeOfferEvent>(); // participant → 桌上挂着的还价

  for (let round = 0; round < ROOM_ROUNDS_MAX && live.size > 0; round++) {
    let progressed = false;
    const roundAccepts: TradeOfferEvent[] = []; // 本轮直接接受底价的报价（initiator→participant）

    // (a) 参与方依次反应（看完整 history，竞争压力来自看到他人报价）
    for (const participant of resolved.participants) {
      if (!live.has(participant)) continue;
      if (!canSpeak(counters, participant)) continue;

      const directOffer: TradeOfferEvent = {
        from: initiator,
        to: participant,
        give: cloneRes(resolved.offer.give),
        receive: cloneRes(resolved.offer.receive),
      };
      const counterCandidates = buildCounterCandidates(state, directOffer);
      const resp = await tradeDecide(participant, board, state, directOffer, history(), getAgent(participant));
      progressed = true;
      const respMeta: MessageMeta = {
        modelContext: resp.modelContext,
        rawOutput: resp.rawOutput,
        provider: resp.provider,
      };

      if (resp.decision === 'ACCEPT') {
        pushMessage(push, sessionId, state.turn, counters, limits, participant, 'ACCEPT', resp.message, directOffer, respMeta);
        roundAccepts.push(directOffer);
        live.delete(participant);
        standingCounters.delete(participant);
        continue;
      }

      if (
        resp.decision === 'COUNTER_OFFER' &&
        counters.counterOffersUsed < TRADE_LIMITS.counterOffersPerSession
      ) {
        const chosen = counterCandidates.find((c) => c.id === resp.counterId);
        if (chosen) {
          counters.counterOffersUsed++;
          counters.offersUsed++;
          const counterOffer: TradeOfferEvent = {
            from: participant,
            to: initiator,
            give: cloneRes(chosen.give),
            receive: cloneRes(chosen.receive),
          };
          pushMessage(push, sessionId, state.turn, counters, limits, participant, 'COUNTER_OFFER', resp.message, counterOffer, respMeta);
          standingCounters.set(participant, counterOffer); // 等发起方本轮统一反应
          continue;
        }
      }

      // REJECT 或还价解析失败 → 退出本场
      pushMessage(push, sessionId, state.turn, counters, limits, participant, 'REJECT', resp.message, directOffer, respMeta);
      live.delete(participant);
      standingCounters.delete(participant);
    }

    // (b) 本轮有人直接接受底价 → 竞争择优、原子只成交一笔
    if (roundAccepts.length > 0) {
      const best = pickBestForInitiator(state, initiator, roundAccepts);
      return closeAccepted(board, state, ledger, push, sessionId, limits, best);
    }

    // (c) 发起方对桌上"对自己最有利"的一个还价反应一次
    if (standingCounters.size > 0 && canSpeak(counters, initiator)) {
      let bestParticipant = -1;
      let bestCounter: TradeOfferEvent | null = null;
      for (const [p, offer] of standingCounters) {
        if (!bestCounter || initiatorScore(state, initiator, offer) > initiatorScore(state, initiator, bestCounter)) {
          bestParticipant = p;
          bestCounter = offer;
        }
      }
      if (bestCounter) {
        const initiatorResp = await tradeDecide(initiator, board, state, bestCounter, history(), getAgent(initiator));
        progressed = true;
        const initMeta: MessageMeta = {
          modelContext: initiatorResp.modelContext,
          rawOutput: initiatorResp.rawOutput,
          provider: initiatorResp.provider,
        };
        if (initiatorResp.decision === 'ACCEPT') {
          pushMessage(push, sessionId, state.turn, counters, limits, initiator, 'ACCEPT', initiatorResp.message, bestCounter, initMeta);
          return closeAccepted(board, state, ledger, push, sessionId, limits, bestCounter);
        }
        // 拒了最优还价 → 该还价作废、提出者退出（其余还价留到下一轮再议）
        pushMessage(push, sessionId, state.turn, counters, limits, initiator, 'REJECT', initiatorResp.message, bestCounter, initMeta);
        standingCounters.delete(bestParticipant);
        live.delete(bestParticipant);
      }
    }

    if (!progressed) break; // 无人能继续发言 → 收摊
  }

  ledger.rejectedOfferKeys[resolved.offerKey] = true;
  push({
    kind: 'closed',
    data: closeEvent(sessionId, state.turn, 'rejected', '多轮谈判未达成：参与 AI 均拒绝或还价未被接受', limits()),
  });
  return { events, nextState: null };
}

function ensureLedgerTurn(ledger: AiTradeLedger, state: GameState) {
  const key = `${state.turn}:${state.current}`;
  if (ledger.turnKey === key) return;
  ledger.turnKey = key;
  ledger.sessionSeq = 0;
  ledger.sessionsByPlayer = {};
  ledger.dealsByPair = {};
  ledger.rejectedOfferKeys = {};
}

function chooseTradeCandidate(
  board: Board,
  state: GameState,
  ledger: AiTradeLedger,
): TradeCandidate | null {
  const me = state.players[state.current];
  const candidates: TradeCandidate[] = [];

  for (const plan of PLAN_PRIORITY) {
    if (!planPossible(board, state, plan.id)) continue;
    const missing = missingResources(me.resources, plan.cost);
    if (missing.length !== 1) continue;
    const need = missing[0];
    const gives = surplusResources(me.resources, plan.cost, need);
    for (const give of gives) {
      const offer = emptyRes();
      const receive = emptyRes();
      offer[give] = 1;
      receive[need] = 1;
      const participants = state.players
        .filter((p) => p.id !== state.current && p.isAI && p.resources[need] > 0)
        .filter((p) => !ledger.dealsByPair[pairKey(state.current, p.id)])
        .sort(
          (a, b) =>
            participantScore(state, b.id, offer, receive) -
            participantScore(state, a.id, offer, receive),
        )
        .map((p) => p.id);
      if (participants.length === 0) continue;
      const offerKey = `${state.current}:${plan.id}:${give}->${need}:${participants.join(',')}`;
      if (ledger.rejectedOfferKeys[offerKey]) continue;
      candidates.push({
        planLabel: plan.label,
        need,
        give,
        participants,
        score:
          plan.priority * 10 +
          participants.length +
          RESOURCE_WEIGHT[need] -
          RESOURCE_WEIGHT[give],
        offerKey,
        offer: { from: state.current, to: null, give: offer, receive },
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] ?? null;
}

/**
 * 校验并解析 LLM 自由报价。
 * - "模型可修复"错误（give/receive 空、超上限、给了没有的、自换同种）→ retryable + reason，供带反馈重试。
 * - "非模型可修复"错误（没有能成交的对手、同一报价本回合已被拒）→ retryable:false，转规则兜底。
 * 校验：give/receive 非空、不含同种、give 自己拥有、总量不超上限、有能兑现 receive 的未成交 AI 对手。
 */
function resolveLlmInitiation(
  state: GameState,
  ledger: AiTradeLedger,
  initiator: number,
  init: TradeInitiationOutput,
): InitiationResolveResult {
  const give = cloneRes(init.give);
  const receive = cloneRes(init.receive);
  const giveTotal = RESOURCES.reduce((s, r) => s + give[r], 0);
  const recvTotal = RESOURCES.reduce((s, r) => s + receive[r], 0);

  if (giveTotal === 0 || recvTotal === 0) {
    return { ok: false, retryable: true, reason: 'give 和 receive 都必须非空（各至少 1 张资源）。' };
  }
  if (giveTotal > MAX_GIVE_CARDS) {
    return { ok: false, retryable: true, reason: `give 总量 ${giveTotal} 张超过上限 ${MAX_GIVE_CARDS} 张，请减少。` };
  }
  if (recvTotal > MAX_RECEIVE_CARDS) {
    return { ok: false, retryable: true, reason: `receive 总量 ${recvTotal} 张超过上限 ${MAX_RECEIVE_CARDS} 张，请减少。` };
  }
  // 不能给出自己没有的资源
  if (!hasResources(state, initiator, give)) {
    return {
      ok: false,
      retryable: true,
      reason: `give 超过你实际拥有的资源（你现有：${resStr(state.players[initiator].resources as ResMap)}）。`,
    };
  }
  // give 与 receive 不能含同一种资源（自换无意义）
  for (const r of RESOURCES) {
    if (give[r] > 0 && receive[r] > 0) {
      return { ok: false, retryable: true, reason: `give 和 receive 不能含同一种资源（${RESOURCE_LABEL[r]}），请换一种需求。` };
    }
  }

  // 交易对象：能兑现 receive、本回合未与我成交过的 AI（上帝视角过滤，保证报价能真成交）
  const offer: TradeOfferEvent = { from: initiator, to: null, give, receive };
  const participants = state.players
    .filter((p) => p.id !== initiator && p.isAI)
    .filter((p) => RESOURCES.every((r) => receive[r] === 0 || p.resources[r] >= receive[r]))
    .filter((p) => !ledger.dealsByPair[pairKey(initiator, p.id)])
    .sort(
      (a, b) =>
        participantScore(state, b.id, give, receive) - participantScore(state, a.id, give, receive),
    )
    .map((p) => p.id);
  // 没有能成交的对手：模型看不到对手手牌，重试也无从修复 → 转规则兜底
  if (participants.length === 0) return { ok: false, retryable: false };

  const offerKey = `llm:${initiator}:${resKey(give)}->${resKey(receive)}:${participants.join(',')}`;
  if (ledger.rejectedOfferKeys[offerKey]) return { ok: false, retryable: false };

  const opening =
    init.message && init.message.length > 0
      ? init.message
      : `${playerName(state, initiator)}愿意用${resStr(give)}换${resStr(receive)}。`;

  return {
    ok: true,
    resolved: {
      planLabel: '资源交换',
      offer,
      participants,
      offerKey,
      openingMessage: opening,
      openingMeta: { modelContext: init.modelContext, rawOutput: init.rawOutput, provider: init.provider },
    },
  };
}

function resKey(m: ResMap): string {
  return RESOURCES.filter((r) => m[r] > 0)
    .map((r) => `${r}${m[r]}`)
    .join('+');
}

function planPossible(
  board: Board,
  state: GameState,
  plan: (typeof PLAN_PRIORITY)[number]['id'],
): boolean {
  const player = state.current;
  switch (plan) {
    case 'city':
      return board.vertices.some((v) => canBuildCity(state, v.id, player));
    case 'settlement':
      return board.vertices.some((v) => canBuildSettlement(board, state, v.id, player));
    case 'dev':
      return state.devDeck.length > 0;
    case 'road':
      return board.edges.some((e) => canBuildRoad(board, state, e.id, player));
  }
}

function missingResources(resources: ResMap, cost: Partial<ResMap>): Resource[] {
  const out: Resource[] = [];
  for (const r of RESOURCES) {
    let n = (cost[r] ?? 0) - resources[r];
    while (n > 0) {
      out.push(r);
      n--;
    }
  }
  return out;
}

function surplusResources(resources: ResMap, cost: Partial<ResMap>, need: Resource): Resource[] {
  return RESOURCES.filter((r) => r !== need && resources[r] > (cost[r] ?? 0)).sort(
    (a, b) => resources[b] - (cost[b] ?? 0) - (resources[a] - (cost[a] ?? 0)),
  );
}

function participantScore(
  state: GameState,
  player: number,
  gain: ResMap,
  loss: ResMap,
): number {
  const p = state.players[player];
  let score = 0;
  for (const r of RESOURCES) {
    score += gain[r] * resourceNeed(p.resources, r);
    score -= loss[r] * resourceNeed(p.resources, r);
  }
  score -= publicVP(state, player) * 0.1;
  score -= handSize(p) > 7 ? 0.3 : 0;
  return score;
}

function resourceNeed(resources: ResMap, r: Resource): number {
  return RESOURCE_WEIGHT[r] / (1 + resources[r]);
}

/** 从发起方视角给一个报价打分：在 TradeOfferEvent 里 from 给 give、收 receive。 */
function initiatorScore(state: GameState, initiator: number, offer: TradeOfferEvent): number {
  const gain = offer.from === initiator ? offer.receive : offer.give;
  const loss = offer.from === initiator ? offer.give : offer.receive;
  return participantScore(state, initiator, gain, loss);
}

/** 多人接受/还价时，选对发起方最有利的一笔（竞争择优）。 */
function pickBestForInitiator(
  state: GameState,
  initiator: number,
  offers: TradeOfferEvent[],
): TradeOfferEvent {
  let best = offers[0];
  for (const o of offers) {
    if (initiatorScore(state, initiator, o) > initiatorScore(state, initiator, best)) best = o;
  }
  return best;
}

function closeAccepted(
  board: Board,
  state: GameState,
  ledger: AiTradeLedger,
  push: (e: TradeEventEntry) => void,
  sessionId: string,
  limits: () => TradeLimitsEvent,
  trade: TradeOfferEvent,
): AiNegotiationResult {
  const events: TradeEventEntry[] = [];
  const p = (e: TradeEventEntry) => { events.push(e); push(e); };
  const executed = dryRunTrade(board, state, trade);
  if (!executed) {
    p({ kind: 'closed', data: closeEvent(sessionId, state.turn, 'invalid', '成交报价未通过 TRADE_EXECUTE dry-run', limits()) });
    return { events, nextState: null };
  }
  ledger.dealsByPair[pairKey(trade.from, trade.to!)] = true;
  p({
    kind: 'closed',
    data: closeEvent(
      sessionId,
      state.turn,
      'accepted',
      `${playerName(state, trade.from)} 与 ${playerName(state, trade.to!)} 成交`,
      limits(),
      trade,
    ),
  });
  return { events, nextState: executed, acceptedTrade: cloneOffer(trade) };
}

interface MessageMeta {
  modelContext?: TradeChatMessageEvent['modelContext'];
  rawOutput?: string;
  provider?: string;
}

function pushMessage(
  push: (e: TradeEventEntry) => void,
  sessionId: string,
  turn: number,
  counters: SessionCounters,
  limits: () => TradeLimitsEvent,
  speaker: number | null,
  decision: TradeDecisionEvent,
  message: string,
  offer?: TradeOfferEvent,
  meta?: MessageMeta,
) {
  if (counters.messagesUsed >= TRADE_LIMITS.messagesPerSession) return;
  counters.messagesUsed++;
  if (speaker != null) {
    counters.repliesByPlayer[speaker] = (counters.repliesByPlayer[speaker] ?? 0) + 1;
  }
  push({
    kind: 'message',
    data: {
      sessionId,
      turn,
      speaker,
      decision,
      message,
      offer: offer ? cloneOffer(offer) : undefined,
      limits: limits(),
      modelContext: meta?.modelContext,
      rawOutput: meta?.rawOutput,
      provider: meta?.provider,
      ts: Date.now(),
    },
  });
}

function canSpeak(counters: SessionCounters, player: number): boolean {
  if (counters.messagesUsed >= TRADE_LIMITS.messagesPerSession) return false;
  return (counters.repliesByPlayer[player] ?? 0) < TRADE_LIMITS.repliesPerPlayer;
}

function buildLimits(
  counters: SessionCounters,
  ledger: AiTradeLedger,
  initiator: number,
): TradeLimitsEvent {
  return {
    messagesUsed: counters.messagesUsed,
    messagesMax: TRADE_LIMITS.messagesPerSession,
    offersUsed: counters.offersUsed,
    offersMax: TRADE_LIMITS.offersPerSession,
    counterOffersUsed: counters.counterOffersUsed,
    counterOffersMax: TRADE_LIMITS.counterOffersPerSession,
    repliesByPlayer: { ...counters.repliesByPlayer },
    repliesMaxPerPlayer: TRADE_LIMITS.repliesPerPlayer,
    sessionsUsedByInitiator: ledger.sessionsByPlayer[initiator] ?? 0,
    sessionsMaxPerTurn: TRADE_LIMITS.sessionsPerTurn,
  };
}

function closeEvent(
  sessionId: string,
  turn: number,
  status: TradeSessionStatus,
  reason: string,
  limits: TradeLimitsEvent,
  finalTrade?: TradeOfferEvent,
): TradeChatClosedEvent {
  return {
    sessionId,
    turn,
    status,
    reason,
    finalTrade: finalTrade ? cloneOffer(finalTrade) : undefined,
    limits,
    ts: Date.now(),
  };
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function playerName(state: GameState, player: number): string {
  return playerDisplayName(state.players, player);
}
