// ============================================================
// AI 对手：启发式决策（开局选点 / 回合行动 / 交易应答）
// 由 App 的驱动循环反复调用 aiNextAction，每次返回一个动作
// ============================================================

import type { Action } from './reducer';
import { longestRoadLength, robberCandidates } from './reducer';
import {
  canAfford,
  canBuildCity,
  canBuildRoad,
  canBuildSettlement,
  canPlaceRoadSetup,
  canPlaceSettlementFree,
  handSize,
  tradeRatio,
  totalVP,
} from './rules';
import type { Board, GameState, Resource, ResMap } from './types';
import { COSTS, RESOURCES, pips } from './types';

const IMPORTANCE: Record<Resource, number> = {
  木: 1.1,
  砖: 1.1,
  羊: 1.0,
  麦: 1.2,
  矿: 1.15,
};

/** 顶点的资源潜力评分 */
function vertexValue(b: Board, v: number): number {
  const vx = b.vertices[v];
  let val = 0;
  const terr = new Set<string>();
  for (const hid of vx.hexes) {
    const h = b.hexes[hid];
    if (h.terrain === '沙漠') continue;
    val += pips(h.number) * IMPORTANCE[h.terrain as Resource];
    terr.add(h.terrain);
  }
  val += terr.size * 0.6; // 资源多样性
  if (vx.port) val += vx.port === '通用' ? 0.6 : 1.0;
  return val;
}

function need(p: { resources: ResMap }, r: Resource): number {
  // 边际价值：拥有越少越值钱
  return IMPORTANCE[r] / (1 + p.resources[r]);
}

// ---------- 开局 ----------

function aiSetupSettlement(b: Board, s: GameState): Action {
  let best = -1;
  let bestVal = -Infinity;
  for (const v of b.vertices) {
    if (!canPlaceSettlementFree(b, s, v.id)) continue;
    const val = vertexValue(b, v.id);
    if (val > bestVal) {
      bestVal = val;
      best = v.id;
    }
  }
  return { type: 'PLACE_SETTLEMENT', v: best };
}

function aiSetupRoad(b: Board, s: GameState): Action {
  const from = s.lastSettlement!;
  // 朝向潜力最高的相邻顶点修路
  let bestEdge = -1;
  let bestVal = -Infinity;
  for (const e of b.edges) {
    if (!canPlaceRoadSetup(b, s, e.id)) continue;
    const far = e.v1 === from ? e.v2 : e.v1;
    const val = vertexValue(b, far);
    if (val > bestVal) {
      bestVal = val;
      bestEdge = e.id;
    }
  }
  if (bestEdge < 0) bestEdge = b.edges.find((e) => canPlaceRoadSetup(b, s, e.id))!.id;
  return { type: 'PLACE_ROAD', e: bestEdge };
}

// ---------- 强盗 ----------

function aiMoveRobber(b: Board, s: GameState): Action {
  const meId = s.current;
  // 找出当前领先的对手
  let bestHex = -1;
  let bestScore = -Infinity;
  for (const h of b.hexes) {
    if (h.id === s.robber) continue;
    let score = 0;
    let touchesSelf = false;
    for (const v of h.corners) {
      const bld = s.buildings[v];
      if (!bld) continue;
      if (bld.owner === meId) {
        touchesSelf = true;
      } else {
        const lead = totalVP(s, bld.owner);
        score += pips(h.number) * (bld.type === 'city' ? 2 : 1) * (1 + lead * 0.15);
      }
    }
    if (touchesSelf) score -= 100;
    if (score > bestScore) {
      bestScore = score;
      bestHex = h.id;
    }
  }
  if (bestHex < 0) bestHex = b.hexes.find((h) => h.id !== s.robber)!.id;
  return { type: 'MOVE_ROBBER', hex: bestHex };
}

function aiSteal(b: Board, s: GameState): Action {
  const cands = robberCandidates(b, s);
  let target = cands[0];
  let best = -1;
  for (const c of cands) {
    const score = handSize(s.players[c]) + totalVP(s, c) * 2;
    if (score > best) {
      best = score;
      target = c;
    }
  }
  return { type: 'STEAL', target };
}

// ---------- 弃牌 ----------

function aiDiscard(s: GameState, pid: number): Action {
  const p = s.players[pid];
  const cards: Partial<ResMap> = {};
  const have: ResMap = { ...p.resources };
  let n = s.discardLeft[pid];
  while (n-- > 0) {
    // 丢弃当前最多的资源
    let r: Resource = RESOURCES[0];
    let max = -1;
    for (const x of RESOURCES)
      if (have[x] - (x === r ? 0 : 0) > max && have[x] > 0) {
        max = have[x];
        r = x;
      }
    have[r]--;
    cards[r] = (cards[r] ?? 0) + 1;
  }
  return { type: 'DISCARD', player: pid, cards };
}

// ---------- 主阶段 ----------

function bestCity(b: Board, s: GameState): number | null {
  let best: number | null = null;
  let bestVal = -1;
  for (const [vStr, bld] of Object.entries(s.buildings)) {
    if (bld.owner !== s.current || bld.type !== 'settlement') continue;
    const v = Number(vStr);
    const val = vertexValue(b, v);
    if (val > bestVal) {
      bestVal = val;
      best = v;
    }
  }
  return best;
}

function bestSettlementSpot(b: Board, s: GameState): number | null {
  let best: number | null = null;
  let bestVal = -1;
  for (const v of b.vertices) {
    if (!canBuildSettlement(b, s, v.id, s.current)) continue;
    const val = vertexValue(b, v.id);
    if (val > bestVal) {
      bestVal = val;
      best = v.id;
    }
  }
  return best;
}

/** 选一条有价值的路：通向潜在房屋点或延长最长路 */
function bestRoad(b: Board, s: GameState): number | null {
  const cur = longestRoadLength(b, s, s.current);
  let best: number | null = null;
  let bestScore = 0;
  for (const e of b.edges) {
    if (!canBuildRoad(b, s, e.id, s.current)) continue;
    let score = 0;
    for (const v of [e.v1, e.v2]) {
      const vx = b.vertices[v];
      if (!s.buildings[v] && !vx.neighbors.some((n) => s.buildings[n])) {
        score += vertexValue(b, v) * 0.5;
      }
    }
    // 模拟加入这条路后的最长路
    s.roads[e.id] = { owner: s.current };
    const after = longestRoadLength(b, s, s.current);
    delete s.roads[e.id];
    if (after > cur) score += (after - cur) * 2.2;
    if (score > bestScore) {
      bestScore = score;
      best = e.id;
    }
  }
  return best;
}

/** 尝试用银行/港口交易补齐某次建造所缺资源；返回一个交易动作或 null */
function tradeToward(b: Board, s: GameState, cost: Partial<ResMap>): Action | null {
  const me = s.players[s.current];
  const deficit: Partial<ResMap> = {};
  let totalDef = 0;
  for (const r of RESOURCES) {
    const d = (cost[r] ?? 0) - me.resources[r];
    if (d > 0) {
      deficit[r] = d;
      totalDef += d;
    }
  }
  if (totalDef !== 1) return null; // 仅在差 1 张时尝试，避免无限交易
  const needR = (Object.keys(deficit) as Resource[])[0];
  if (s.bank[needR] < 1) return null; // 银行无该资源，交易会被拒绝，避免空转死循环
  // 找一个可用比率内、且不属于成本所需的富余资源
  let bestGive: Resource | null = null;
  let bestSurplus = 0;
  for (const r of RESOURCES) {
    if (r === needR) continue;
    const ratio = tradeRatio(b, s, s.current, r);
    const reserveForCost = cost[r] ?? 0;
    const surplus = me.resources[r] - reserveForCost - ratio;
    if (me.resources[r] >= ratio && surplus >= 0 && surplus > bestSurplus) {
      bestSurplus = surplus + 1;
      bestGive = r;
    }
  }
  if (!bestGive) return null;
  return { type: 'BANK_TRADE', give: bestGive, receive: needR };
}

function aiMain(b: Board, s: GameState): Action {
  const me = s.players[s.current];

  // 1) 升级城市（性价比最高）
  if (canAfford(me, COSTS.city)) {
    const c = bestCity(b, s);
    if (c != null && canBuildCity(s, c, s.current)) return { type: 'BUILD_CITY', v: c };
  }
  // 2) 建房屋
  if (canAfford(me, COSTS.settlement)) {
    const v = bestSettlementSpot(b, s);
    if (v != null) return { type: 'BUILD_SETTLEMENT', v };
  }
  // 3) 免费修路（修路卡）
  if (s.freeRoads > 0) {
    const r = bestRoad(b, s);
    if (r != null) return { type: 'BUILD_ROAD', e: r };
  }
  // 4) 资源充裕时购买发展卡
  const hand = handSize(me);
  if (
    s.devDeck.length > 0 &&
    canAfford(me, COSTS.dev) &&
    (hand >= 8 || bestSettlementSpot(b, s) == null)
  ) {
    return { type: 'BUY_DEV' };
  }
  // 5) 修一条有价值的路
  if (canAfford(me, COSTS.road)) {
    const r = bestRoad(b, s);
    if (r != null) return { type: 'BUILD_ROAD', e: r };
  }
  // 6) 差一张牌时用银行交易补齐城市/房屋
  for (const cost of [COSTS.city, COSTS.settlement]) {
    const t = tradeToward(b, s, cost);
    if (t) return t;
  }
  // 7) 打骑士卡：抢最大军队或赶走压在自己地块上的强盗
  if (!s.devPlayed && me.devCards.includes('骑士')) {
    const robberHurtsMe = b.hexes[s.robber].corners.some(
      (v) => s.buildings[v]?.owner === s.current,
    );
    const couldGetArmy =
      me.knightsPlayed + 1 >= 3 &&
      (s.largestArmy.player === null || me.knightsPlayed + 1 > s.largestArmy.size);
    if (robberHurtsMe || couldGetArmy) return { type: 'PLAY_KNIGHT' };
  }
  // 8) 丰收卡：差 2 张牌就用
  if (!s.devPlayed && me.devCards.includes('丰收')) {
    for (const cost of [COSTS.city, COSTS.settlement]) {
      const miss: Resource[] = [];
      for (const r of RESOURCES) {
        let d = (cost[r] ?? 0) - me.resources[r];
        while (d-- > 0) miss.push(r);
      }
      if (miss.length === 2) {
        return { type: 'PLAY_YEAR_OF_PLENTY', r1: miss[0], r2: miss[1] };
      }
    }
  }
  // 9) 垄断卡：对方手里某资源很多时
  if (!s.devPlayed && me.devCards.includes('垄断')) {
    let bestR: Resource | null = null;
    let bestSum = 4;
    for (const r of RESOURCES) {
      const sum = s.players.reduce(
        (t, p) => t + (p.id === s.current ? 0 : p.resources[r]),
        0,
      );
      if (sum > bestSum) {
        bestSum = sum;
        bestR = r;
      }
    }
    if (bestR) return { type: 'PLAY_MONOPOLY', r: bestR };
  }
  // 10) 没有更优行动 → 结束回合
  return { type: 'END_TURN' };
}

// ---------- 对外主入口 ----------

/** 返回下一个 AI 动作；若当前轮到人类决策则返回 null */
export function aiNextAction(b: Board, s: GameState): Action | null {
  switch (s.phase) {
    case 'setup1':
    case 'setup2':
      if (!s.players[s.current].isAI) return null;
      return s.setupStep === 'settlement' ? aiSetupSettlement(b, s) : aiSetupRoad(b, s);

    case 'roll':
      if (!s.players[s.current].isAI) return null;
      return { type: 'ROLL' };

    case 'discard': {
      // 任意需要弃牌的 AI 先处理；人类由 UI 处理
      for (const pid of Object.keys(s.discardLeft).map(Number)) {
        if (s.players[pid].isAI) return aiDiscard(s, pid);
      }
      return null;
    }

    case 'moveRobber':
      if (!s.players[s.current].isAI) return null;
      return aiMoveRobber(b, s);

    case 'steal':
      if (!s.players[s.current].isAI) return null;
      return aiSteal(b, s);

    case 'main':
      if (!s.players[s.current].isAI) return null;
      return aiMain(b, s);

    default:
      return null;
  }
}

/** AI 是否接受人类提出的交易：gain=AI 得到的，loss=AI 付出的 */
export function aiAcceptsTrade(s: GameState, aiId: number, gain: ResMap, loss: ResMap): boolean {
  const ai = s.players[aiId];
  if (!RESOURCES.every((r) => ai.resources[r] >= loss[r])) return false;
  const nGain = RESOURCES.reduce((t, r) => t + gain[r], 0);
  const nLoss = RESOURCES.reduce((t, r) => t + loss[r], 0);
  if (nGain === 0) return false;
  let gv = 0;
  let lv = 0;
  for (const r of RESOURCES) {
    gv += gain[r] * need(ai, r);
    lv += loss[r] * need(ai, r);
  }
  // 价值上有明显得益，且不会送出过多张数
  return gv >= lv * 1.15 && nGain >= nLoss;
}

export { vertexValue };
