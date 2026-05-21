// ============================================================
// 规则引擎：合法性判定 / 资源产出 / 最长路 / 最大军队 / 计分
// 这些函数不修改全局状态（produceResources 例外，由 reducer 在副本上调用）
// ============================================================

import type { Board, GameState, Player, Resource, ResMap } from './types';
import { PIECE_LIMIT, RESOURCES } from './types';

export function canAfford(p: Player, cost: Partial<ResMap>): boolean {
  return RESOURCES.every((r) => (p.resources[r] ?? 0) >= (cost[r] ?? 0));
}

export function pay(p: Player, cost: Partial<ResMap>) {
  for (const r of RESOURCES) p.resources[r] -= cost[r] ?? 0;
}

export function refund(p: Player, cost: Partial<ResMap>) {
  for (const r of RESOURCES) p.resources[r] += cost[r] ?? 0;
}

export function handSize(p: Player): number {
  return RESOURCES.reduce((s, r) => s + p.resources[r], 0);
}

export function countType(s: GameState, owner: number, type: 'settlement' | 'city'): number {
  return Object.values(s.buildings).filter((b) => b.owner === owner && b.type === type).length;
}

export function countRoads(s: GameState, owner: number): number {
  return Object.values(s.roads).filter((r) => r.owner === owner).length;
}

// ---- 建造合法性 ----

/** setup 阶段放房屋：顶点空 + 所有相邻顶点空（距离规则） */
export function canPlaceSettlementFree(b: Board, s: GameState, v: number): boolean {
  if (s.buildings[v]) return false;
  for (const n of b.vertices[v].neighbors) if (s.buildings[n]) return false;
  return true;
}

/** 正常阶段建房屋：距离规则 + 必须连到自己的路 + 未超过上限 */
export function canBuildSettlement(b: Board, s: GameState, v: number, player: number): boolean {
  if (!canPlaceSettlementFree(b, s, v)) return false;
  if (countType(s, player, 'settlement') >= PIECE_LIMIT.settlement) return false;
  // 必须与自己的某条路相连
  const connected = b.edges.some((e) => {
    if ((e.v1 !== v && e.v2 !== v) || !s.roads[e.id]) return false;
    return s.roads[e.id].owner === player;
  });
  return connected;
}

/** 顶点 v 对 player 是否可作为修路的连接点 */
function vertexConnectable(b: Board, s: GameState, v: number, player: number): boolean {
  const bld = s.buildings[v];
  if (bld) return bld.owner === player; // 有建筑：必须是自己的；对方建筑阻断
  // 无建筑：需有自己的路接到该点
  return b.edges.some(
    (e) => (e.v1 === v || e.v2 === v) && s.roads[e.id] && s.roads[e.id].owner === player,
  );
}

export function canBuildRoad(b: Board, s: GameState, edgeId: number, player: number): boolean {
  if (s.roads[edgeId]) return false;
  if (countRoads(s, player) >= PIECE_LIMIT.road) return false;
  const e = b.edges[edgeId];
  return vertexConnectable(b, s, e.v1, player) || vertexConnectable(b, s, e.v2, player);
}

/** setup 阶段放路：必须邻接刚放置的房屋顶点 */
export function canPlaceRoadSetup(b: Board, s: GameState, edgeId: number): boolean {
  if (s.roads[edgeId]) return false;
  const e = b.edges[edgeId];
  return e.v1 === s.lastSettlement || e.v2 === s.lastSettlement;
}

export function canBuildCity(s: GameState, v: number, player: number): boolean {
  const bld = s.buildings[v];
  if (!bld || bld.owner !== player || bld.type !== 'settlement') return false;
  return countType(s, player, 'city') < PIECE_LIMIT.city;
}

// ---- 港口与交易比率 ----

/** 玩家可用的最优兑换比率（某资源换银行） */
export function tradeRatio(b: Board, s: GameState, player: number, give: Resource): number {
  let ratio = 4;
  for (const [vStr, bld] of Object.entries(s.buildings)) {
    if (bld.owner !== player) continue;
    const port = b.vertices[Number(vStr)].port;
    if (port === '通用') ratio = Math.min(ratio, 3);
    else if (port === give) ratio = Math.min(ratio, 2);
  }
  return ratio;
}

// ---- 资源产出（在 reducer 的状态副本上调用，会修改 s/players） ----

export function produceResources(b: Board, s: GameState, sum: number): Record<number, ResMap> {
  // 统计每个玩家每种资源的应得量
  const gains: Record<number, ResMap> = {};
  for (const p of s.players)
    gains[p.id] = { 木: 0, 砖: 0, 羊: 0, 麦: 0, 矿: 0 };

  const demand: ResMap = { 木: 0, 砖: 0, 羊: 0, 麦: 0, 矿: 0 };

  for (const h of b.hexes) {
    if (h.number !== sum || h.terrain === '沙漠') continue;
    if (h.id === s.robber) continue;
    const res = h.terrain as Resource;
    for (const v of h.corners) {
      const bld = s.buildings[v];
      if (!bld) continue;
      const amount = bld.type === 'city' ? 2 : 1;
      gains[bld.owner][res] += amount;
      demand[res] += amount;
    }
  }

  // 银行不足规则：若某资源总需求 > 银行库存且不止一个玩家需要，则该资源本次无人获得
  for (const r of RESOURCES) {
    if (demand[r] === 0) continue;
    if (demand[r] > s.bank[r]) {
      const receivers = s.players.filter((p) => gains[p.id][r] > 0).length;
      if (receivers > 1) {
        for (const p of s.players) gains[p.id][r] = 0;
      } else {
        // 仅一名玩家：发放其能拿到的部分
        const p = s.players.find((pp) => gains[pp.id][r] > 0)!;
        gains[p.id][r] = Math.min(gains[p.id][r], s.bank[r]);
      }
    }
  }

  for (const p of s.players) {
    for (const r of RESOURCES) {
      const g = gains[p.id][r];
      if (g > 0) {
        p.resources[r] += g;
        s.bank[r] -= g;
      }
    }
  }
  return gains;
}

// ---- 最长路 ----

/** 计算某玩家最长连续路（对方建筑会截断路线） */
export function longestRoadLength(b: Board, s: GameState, player: number): number {
  const myEdges = b.edges.filter((e) => s.roads[e.id]?.owner === player);
  if (myEdges.length === 0) return 0;

  const incident = new Map<number, { edge: number; other: number }[]>();
  for (const e of myEdges) {
    if (!incident.has(e.v1)) incident.set(e.v1, []);
    if (!incident.has(e.v2)) incident.set(e.v2, []);
    incident.get(e.v1)!.push({ edge: e.id, other: e.v2 });
    incident.get(e.v2)!.push({ edge: e.id, other: e.v1 });
  }

  const blocked = (v: number) => {
    const bld = s.buildings[v];
    return !!bld && bld.owner !== player; // 对方建筑：不能穿越
  };

  let best = 0;
  const dfs = (v: number, used: Set<number>, len: number) => {
    if (len > best) best = len;
    if (blocked(v)) return; // 路线在此被截断
    for (const { edge, other } of incident.get(v) ?? []) {
      if (used.has(edge)) continue;
      used.add(edge);
      dfs(other, used, len + 1);
      used.delete(edge);
    }
  };

  for (const e of myEdges) {
    for (const start of [e.v1, e.v2]) {
      const other = start === e.v1 ? e.v2 : e.v1;
      const used = new Set<number>([e.id]);
      dfs(other, used, 1);
    }
  }
  return best;
}

/** 重算最长路归属（≥5 段才有资格；需严格超过当前持有者才易主） */
export function updateLongestRoad(b: Board, s: GameState) {
  const lens = s.players.map((p) => longestRoadLength(b, s, p.id));
  const holder = s.longestRoad.player;

  if (holder !== null && lens[holder] < 5) {
    s.longestRoad = { player: null, len: 0 };
  } else if (holder !== null) {
    s.longestRoad.len = lens[holder];
  }

  const curLen = s.longestRoad.player === null ? 4 : s.longestRoad.len;
  let bestP = -1;
  let bestL = curLen;
  for (const p of s.players) {
    if (lens[p.id] >= 5 && lens[p.id] > bestL) {
      bestL = lens[p.id];
      bestP = p.id;
    }
  }
  if (bestP >= 0 && bestP !== s.longestRoad.player) {
    s.longestRoad = { player: bestP, len: bestL };
  }
}

/** 重算最大军队归属（≥3 骑士；需严格超过当前持有者才易主） */
export function updateLargestArmy(s: GameState) {
  const cur = s.largestArmy.player;
  const curSize = cur === null ? 2 : s.largestArmy.size;
  let bestP = cur;
  let bestSize = curSize;
  for (const p of s.players) {
    if (p.knightsPlayed >= 3 && p.knightsPlayed > bestSize) {
      bestSize = p.knightsPlayed;
      bestP = p.id;
    }
  }
  if (bestP !== null) s.largestArmy = { player: bestP, size: bestSize };
}

// ---- 计分 ----

/** 公开可见的胜利点（不含隐藏的胜利点卡） */
export function publicVP(s: GameState, player: number): number {
  let vp = 0;
  for (const bld of Object.values(s.buildings)) {
    if (bld.owner !== player) continue;
    vp += bld.type === 'city' ? 2 : 1;
  }
  if (s.longestRoad.player === player) vp += 2;
  if (s.largestArmy.player === player) vp += 2;
  return vp;
}

/** 总胜利点（含胜利点卡，用于判定胜负） */
export function totalVP(s: GameState, player: number): number {
  return publicVP(s, player) + s.players[player].vpCards;
}
