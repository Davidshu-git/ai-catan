// ============================================================
// AI 交易谈判管理器
// ------------------------------------------------------------
// 第一版只处理 AI ↔ AI：谈判状态留在 server 内存，最终成交仍然
// dry-run + TRADE_EXECUTE，不进入 shared/state.ts 主状态机。
// ============================================================

import { aiAcceptsTrade } from '../../shared/ai';
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

export function maybeRunAiNegotiation(
  board: Board,
  state: GameState,
  ledger: AiTradeLedger,
): AiNegotiationResult | null {
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

  events.push({
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
  });

  pushMessage(
    events,
    sessionId,
    state.turn,
    counters,
    limits,
    initiator,
    'PROPOSE',
    `${playerName(state, initiator)}想推进${candidate.planLabel}，愿意给出${resStr(candidate.offer.give)}换${resStr(candidate.offer.receive)}。`,
    candidate.offer,
  );

  for (const participant of candidate.participants) {
    if (!canSpeak(counters, participant)) continue;
    const directTrade: TradeOfferEvent = {
      from: initiator,
      to: participant,
      give: cloneRes(candidate.offer.give),
      receive: cloneRes(candidate.offer.receive),
    };

    if (aiAcceptsTrade(state, participant, directTrade.give, directTrade.receive)) {
      pushMessage(
        events,
        sessionId,
        state.turn,
        counters,
        limits,
        participant,
        'ACCEPT',
        `${playerName(state, participant)}接受报价：得到${resStr(directTrade.give)}，交出${resStr(directTrade.receive)}。`,
        directTrade,
      );
      return closeAccepted(board, state, ledger, events, sessionId, limits, directTrade);
    }

    const counter = buildCounterOffer(state, directTrade);
    if (counter && counters.counterOffersUsed < TRADE_LIMITS.counterOffersPerSession) {
      counters.counterOffersUsed++;
      counters.offersUsed++;
      pushMessage(
        events,
        sessionId,
        state.turn,
        counters,
        limits,
        participant,
        'COUNTER_OFFER',
        `${playerName(state, participant)}提出还价：给出${resStr(counter.give)}，要求${resStr(counter.receive)}。`,
        counter,
      );

      if (canSpeak(counters, initiator) && aiAcceptsTrade(state, initiator, counter.give, counter.receive)) {
        pushMessage(
          events,
          sessionId,
          state.turn,
          counters,
          limits,
          initiator,
          'ACCEPT',
          `${playerName(state, initiator)}接受还价，交易成立。`,
          counter,
        );
        return closeAccepted(board, state, ledger, events, sessionId, limits, counter);
      }

      if (canSpeak(counters, initiator)) {
        pushMessage(
          events,
          sessionId,
          state.turn,
          counters,
          limits,
          initiator,
          'REJECT',
          `${playerName(state, initiator)}拒绝还价，继续等待其他回应。`,
          counter,
        );
      }
      continue;
    }

    pushMessage(
      events,
      sessionId,
      state.turn,
      counters,
      limits,
      participant,
      'REJECT',
      `${playerName(state, participant)}拒绝：这笔交换不会改善自己的资源结构。`,
      directTrade,
    );
  }

  ledger.rejectedOfferKeys[candidate.offerKey] = true;
  events.push({
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
        .sort((a, b) => participantScore(state, b.id, offer, receive) - participantScore(state, a.id, offer, receive))
        .map((p) => p.id);
      if (participants.length === 0) continue;
      const offerKey = `${state.current}:${plan.id}:${give}->${need}:${participants.join(',')}`;
      if (ledger.rejectedOfferKeys[offerKey]) continue;
      candidates.push({
        planLabel: plan.label,
        need,
        give,
        participants,
        score: plan.priority * 10 + participants.length + RESOURCE_WEIGHT[need] - RESOURCE_WEIGHT[give],
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
  return RESOURCES.filter((r) => r !== need && resources[r] > (cost[r] ?? 0))
    .sort((a, b) => resources[b] - (cost[b] ?? 0) - (resources[a] - (cost[a] ?? 0)));
}

function participantScore(state: GameState, player: number, gain: ResMap, loss: ResMap): number {
  if (aiAcceptsTrade(state, player, gain, loss)) return 100;
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

function buildCounterOffer(state: GameState, directTrade: TradeOfferEvent): TradeOfferEvent | null {
  if (directTrade.to == null) return null;
  const initiator = directTrade.from;
  const responder = directTrade.to;
  const responderGive = cloneRes(directTrade.receive);
  const baseReceive = cloneRes(directTrade.give);

  for (const extra of RESOURCES) {
    const receive = cloneRes(baseReceive);
    receive[extra]++;
    if (!hasResources(state, initiator, receive)) continue;
    if (!aiAcceptsTrade(state, responder, receive, responderGive)) continue;
    return {
      from: responder,
      to: initiator,
      give: responderGive,
      receive,
    };
  }
  return null;
}

function closeAccepted(
  board: Board,
  state: GameState,
  ledger: AiTradeLedger,
  events: TradeEventEntry[],
  sessionId: string,
  limits: () => TradeLimitsEvent,
  trade: TradeOfferEvent,
): AiNegotiationResult {
  const executed = dryRunTrade(board, state, trade);
  if (!executed) {
    events.push({
      kind: 'closed',
      data: closeEvent(sessionId, state.turn, 'invalid', '成交报价未通过 TRADE_EXECUTE dry-run', limits()),
    });
    return { events, nextState: null };
  }
  ledger.dealsByPair[pairKey(trade.from, trade.to!)] = true;
  events.push({
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

function pushMessage(
  events: TradeEventEntry[],
  sessionId: string,
  turn: number,
  counters: SessionCounters,
  limits: () => TradeLimitsEvent,
  speaker: number | null,
  decision: TradeDecisionEvent,
  message: string,
  offer?: TradeOfferEvent,
) {
  if (counters.messagesUsed >= TRADE_LIMITS.messagesPerSession) return;
  counters.messagesUsed++;
  if (speaker != null) {
    counters.repliesByPlayer[speaker] = (counters.repliesByPlayer[speaker] ?? 0) + 1;
  }
  events.push({
    kind: 'message',
    data: {
      sessionId,
      turn,
      speaker,
      decision,
      message,
      offer: offer ? cloneOffer(offer) : undefined,
      limits: limits(),
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
