// ============================================================
// AI 交易谈判管理器
// ------------------------------------------------------------
// 调用 LLM（或规则 fallback）为每个参与方生成真实决策 + 自然语言消息。
// tradeDecide 函数由 server/index.ts 按玩家注入（持有 providerName）。
// ============================================================

import { reduce, type Action } from '../../shared/reducer';
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
} from '../llm/tradeProvider';

const TRADE_LIMITS = {
  sessionsPerTurn: 2,
  messagesPerSession: 8,
  offersPerSession: 2,
  counterOffersPerSession: 1,
  repliesPerPlayer: 2,
};

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
  fallback: string,
  agent?: AgentPromptContext,
) => Promise<TradeProposeOutput>;

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
  getAgent: (playerId: number) => AgentPromptContext | undefined,
  onEvent: (entry: TradeEventEntry) => void,
): Promise<AiNegotiationResult | null> {
  if (state.phase !== 'main') return null;
  const initiator = state.current;
  if (!state.players[initiator]?.isAI) return null;

  ensureLedgerTurn(ledger, state);
  const usedSessions = ledger.sessionsByPlayer[initiator] ?? 0;
  if (usedSessions >= TRADE_LIMITS.sessionsPerTurn) return null;

  const candidate = chooseTradeCandidate(board, state, ledger);
  if (!candidate) return null;

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
      participants: candidate.participants,
      proposedTrade: cloneOffer(candidate.offer),
      limits: limits(),
      ts: Date.now(),
    },
  };
  push(startedEntry);

  // 发起方生成开场白
  const fallbackPropose = `${playerName(state, initiator)}想推进${candidate.planLabel}，愿意给出${resStr(candidate.offer.give)}换${resStr(candidate.offer.receive)}。`;
  const proposeOut = await tradeProposeMessage(
    initiator,
    candidate.planLabel,
    candidate.offer,
    fallbackPropose,
    getAgent(initiator),
  );
  pushMessage(
    push,
    sessionId,
    state.turn,
    counters,
    limits,
    initiator,
    'PROPOSE',
    proposeOut.message,
    candidate.offer,
    { modelContext: proposeOut.modelContext, rawOutput: proposeOut.rawOutput, provider: proposeOut.provider },
  );

  for (const participant of candidate.participants) {
    if (!canSpeak(counters, participant)) continue;

    const directOffer: TradeOfferEvent = {
      from: initiator,
      to: participant,
      give: cloneRes(candidate.offer.give),
      receive: cloneRes(candidate.offer.receive),
    };
    const counterCandidates = buildCounterCandidates(state, directOffer);

    // 参与方 LLM 决策
    const resp = await tradeDecide(
      participant,
      board,
      state,
      directOffer,
      history(),
      getAgent(participant),
    );

    const respMeta: MessageMeta = {
      modelContext: resp.modelContext,
      rawOutput: resp.rawOutput,
      provider: resp.provider,
    };

    if (resp.decision === 'ACCEPT') {
      pushMessage(push, sessionId, state.turn, counters, limits, participant, 'ACCEPT', resp.message, directOffer, respMeta);
      return closeAccepted(board, state, ledger, push, sessionId, limits, directOffer);
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

        // 发起方回应还价（无进一步还价选项）
        if (canSpeak(counters, initiator)) {
          const initiatorResp = await tradeDecide(
            initiator,
            board,
            state,
            counterOffer,
            history(),
            getAgent(initiator),
          );
          const initMeta: MessageMeta = {
            modelContext: initiatorResp.modelContext,
            rawOutput: initiatorResp.rawOutput,
            provider: initiatorResp.provider,
          };
          if (initiatorResp.decision === 'ACCEPT') {
            pushMessage(push, sessionId, state.turn, counters, limits, initiator, 'ACCEPT', initiatorResp.message, counterOffer, initMeta);
            return closeAccepted(board, state, ledger, push, sessionId, limits, counterOffer);
          }
          pushMessage(push, sessionId, state.turn, counters, limits, initiator, 'REJECT', initiatorResp.message, counterOffer, initMeta);
        }
        continue;
      }
    }

    // REJECT 或 COUNTER_OFFER 解析失败
    pushMessage(push, sessionId, state.turn, counters, limits, participant, 'REJECT', resp.message, directOffer, respMeta);
  }

  ledger.rejectedOfferKeys[candidate.offerKey] = true;
  push({
    kind: 'closed',
    data: closeEvent(sessionId, state.turn, 'rejected', '所有参与 AI 均拒绝或还价未达成', limits()),
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
  return { events, nextState: executed };
}

function dryRunTrade(board: Board, state: GameState, trade: TradeOfferEvent): GameState | null {
  if (trade.to == null) return null;
  if (!hasResources(state, trade.from, trade.give)) return null;
  if (!hasResources(state, trade.to, trade.receive)) return null;
  const action: Action = {
    type: 'TRADE_EXECUTE',
    from: trade.from,
    to: trade.to,
    give: cloneRes(trade.give),
    receive: cloneRes(trade.receive),
  };
  const before = tradeResourceSignature(state);
  const next = reduce(board, state, action);
  return tradeResourceSignature(next) === before ? null : next;
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

function hasResources(state: GameState, player: number, res: ResMap): boolean {
  return RESOURCES.every((r) => state.players[player].resources[r] >= res[r]);
}

function tradeResourceSignature(state: GameState): string {
  return state.players
    .map((p) => RESOURCES.map((r) => p.resources[r]).join(','))
    .join('|');
}

function cloneRes(res: ResMap): ResMap {
  return { ...res };
}

function cloneOffer(offer: TradeOfferEvent): TradeOfferEvent {
  return {
    from: offer.from,
    to: offer.to,
    give: cloneRes(offer.give),
    receive: cloneRes(offer.receive),
  };
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function playerName(state: GameState, player: number): string {
  return state.players[player]?.name ?? `玩家${player}`;
}

function resStr(m: ResMap): string {
  return RESOURCES.filter((r) => m[r] > 0)
    .map((r) => `${RESOURCE_LABEL[r]}×${m[r]}`)
    .join(' ') || '无';
}
