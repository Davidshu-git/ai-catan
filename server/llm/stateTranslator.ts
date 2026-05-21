// ============================================================
// 状态翻译器：board + state → 当前玩家视角的精简 JSON
// ------------------------------------------------------------
// 隐藏信息：其他玩家的 devCards 明细、vpCards 数量、resources 明细
// 公开信息：手牌数、已打骑士数、最长路/最大军队归属、公开分
// 注意：本结构会出现在 LLM 输入和 ai_thought 日志里，命名要简短
// ============================================================

import type { Board, GameState, Phase, Resource, ResMap, Port } from '../../shared/types';
import { COSTS, RESOURCES } from '../../shared/types';
import { handSize, publicVP, longestRoadLength, tradeRatio } from '../../shared/rules';

/** 单个地块（去掉像素坐标，只留逻辑信息） */
export interface HexSummary {
  id: number;
  terrain: string;
  number: number | null;
  /** 强盗是否在此 */
  robber: boolean;
}

/** 自己 / 他人的玩家视图 */
export interface SelfPlayerView {
  id: number;
  name: string;
  resources: ResMap;
  /** 可用发展卡（不含本回合新购） */
  devCards: string[];
  /** 本回合新购、下回合可用 */
  newDevCards: string[];
  knightsPlayed: number;
  vpCards: number;
  publicVP: number;
  totalVP: number;
  /** 港口 2:1 资源比率（按资源） */
  tradeRatio: Record<Resource, number>;
}

export interface OtherPlayerView {
  id: number;
  name: string;
  isAI: boolean;
  /** 手牌总张数（不暴露资源明细） */
  handSize: number;
  /** 发展卡总数（不暴露 victory 等具体类别） */
  devCardCount: number;
  knightsPlayed: number;
  publicVP: number;
  /** 拥有的房屋顶点 id */
  settlements: number[];
  /** 拥有的城市顶点 id */
  cities: number[];
  /** 拥有的道路边 id */
  roads: number[];
  longestRoadLen: number;
}

export interface PlayerView {
  phase: Phase;
  turn: number;
  current: number;
  dice: [number, number] | null;
  /** 本玩家 id（也是 view 视角的所有者） */
  me: number;
  self: SelfPlayerView;
  others: OtherPlayerView[];
  bank: ResMap;
  /** 强盗当前所在地块 id */
  robber: number;
  hexes: HexSummary[];
  /** 港口位置：顶点 id → 港口类型 */
  ports: Array<{ vertex: number; port: Port }>;
  /** 本玩家所有建筑/道路（自己的也单列方便 LLM） */
  myBuildings: { settlements: number[]; cities: number[]; roads: number[] };
  /** 建造成本速查；用于资源规划，legalActions 仍是唯一合法动作来源 */
  costs: {
    road: Partial<ResMap>;
    settlement: Partial<ResMap>;
    city: Partial<ResMap>;
    dev: Partial<ResMap>;
  };
  /** 最近 10 条游戏日志（给 LLM 上下文） */
  recentLog: string[];
  /** 待应答的交易（若 me 是 to 方） */
  pendingTradeForMe: {
    from: number;
    give: ResMap;
    receive: ResMap;
  } | null;
}

export function buildPlayerView(b: Board, s: GameState, me: number): PlayerView {
  const self = s.players[me];

  const settlements: Record<number, number[]> = {};
  const cities: Record<number, number[]> = {};
  for (const [vStr, bld] of Object.entries(s.buildings)) {
    const v = Number(vStr);
    const arr = bld.type === 'city' ? cities : settlements;
    (arr[bld.owner] ??= []).push(v);
  }
  const roadsByOwner: Record<number, number[]> = {};
  for (const [eStr, road] of Object.entries(s.roads)) {
    (roadsByOwner[road.owner] ??= []).push(Number(eStr));
  }

  const ratio: Record<Resource, number> = {} as Record<Resource, number>;
  for (const r of RESOURCES) ratio[r] = tradeRatio(b, s, me, r);

  return {
    phase: s.phase,
    turn: s.turn,
    current: s.current,
    dice: s.dice,
    me,
    self: {
      id: me,
      name: self.name,
      resources: { ...self.resources },
      devCards: [...self.devCards],
      newDevCards: [...self.newDevCards],
      knightsPlayed: self.knightsPlayed,
      vpCards: self.vpCards,
      publicVP: publicVP(s, me),
      // 仅自己能看到 totalVP（含隐藏胜利点卡）
      totalVP: publicVP(s, me) + self.vpCards,
      tradeRatio: ratio,
    },
    others: s.players
      .filter((p) => p.id !== me)
      .map((p) => ({
        id: p.id,
        name: p.name,
        isAI: p.isAI,
        handSize: handSize(p),
        devCardCount: p.devCards.length + p.newDevCards.length,
        knightsPlayed: p.knightsPlayed,
        publicVP: publicVP(s, p.id),
        settlements: settlements[p.id] ?? [],
        cities: cities[p.id] ?? [],
        roads: roadsByOwner[p.id] ?? [],
        longestRoadLen: longestRoadLength(b, s, p.id),
      })),
    bank: { ...s.bank },
    robber: s.robber,
    hexes: b.hexes.map((h) => ({
      id: h.id,
      terrain: h.terrain,
      number: h.number,
      robber: h.id === s.robber,
    })),
    ports: b.vertices
      .filter((v) => v.port != null)
      .map((v) => ({ vertex: v.id, port: v.port! })),
    myBuildings: {
      settlements: settlements[me] ?? [],
      cities: cities[me] ?? [],
      roads: roadsByOwner[me] ?? [],
    },
    costs: {
      road: { ...COSTS.road },
      settlement: { ...COSTS.settlement },
      city: { ...COSTS.city },
      dev: { ...COSTS.dev },
    },
    recentLog: s.log.slice(-10).map((l) => l.text),
    pendingTradeForMe:
      s.pendingTrade && s.pendingTrade.to === me
        ? {
            from: s.pendingTrade.from,
            give: { ...s.pendingTrade.give },
            receive: { ...s.pendingTrade.receive },
          }
        : null,
  };
}
