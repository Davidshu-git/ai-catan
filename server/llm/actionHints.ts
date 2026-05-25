// ============================================================
// 语义化动作提示：把 vertex/edge/hex id 翻译成"战略情报文本"
// ------------------------------------------------------------
// 目的：减轻 LLM 的拓扑推理负担。LLM 看到 `build-settlement-v42`
// 时不需要在脑里反查 v42→相邻 hex→数字→资源，hint 已经写好了。
// 设计：所有 hint 一句话、可读、信息密度高；不要写"建议"/"应该"，
// 只摆事实（资源+概率+港口+敌我建筑分布），让 LLM 自己决策。
// 改 hint 文本时注意：会进入 LLM prompt 和 ai_thought 日志。
// ============================================================

import type { Board, GameState, Resource, ResMap, Terrain } from '../../shared/types';
import { emptyRes, pips as yieldPoints } from '../../shared/types';
import { canBuildRoad, canBuildSettlement } from '../../shared/rules';

/** 资源/地形显示顺序，便于 LLM 比较时稳定 */
const TERRAIN_ORDER: Terrain[] = ['麦', '矿', '木', '砖', '羊', '沙漠'];

/** 把一个顶点周边的 hex 描述成 "麦8(5产出点) 矿11(2产出点) 木6(5产出点)" 形式 */
function describeVertexTiles(b: Board, vertexId: number): string {
  const v = b.vertices[vertexId];
  if (!v) return '?';
  const parts = v.hexes
    .map((hid) => b.hexes[hid])
    .filter((h): h is NonNullable<typeof h> => h != null)
    .sort((a, b) => TERRAIN_ORDER.indexOf(a.terrain) - TERRAIN_ORDER.indexOf(b.terrain))
    .map((h) => {
      if (h.terrain === '沙漠' || h.number == null) return '沙漠';
      return `${h.terrain}${h.number}(${yieldPoints(h.number)}产出点)`;
    });
  return parts.length > 0 ? parts.join(' ') : '?';
}

/** 顶点产出点总和（骰点概率权重），用于 LLM 直观对比"产出潜力" */
function vertexYieldPointSum(b: Board, vertexId: number): number {
  const v = b.vertices[vertexId];
  if (!v) return 0;
  let sum = 0;
  for (const hid of v.hexes) {
    const h = b.hexes[hid];
    if (h && h.terrain !== '沙漠') sum += yieldPoints(h.number);
  }
  return sum;
}

/** 一个顶点拥有的资源种类集合（用于"资源多样性"判断） */
function vertexResourceKinds(b: Board, vertexId: number): Set<Resource> {
  const out = new Set<Resource>();
  const v = b.vertices[vertexId];
  if (!v) return out;
  for (const hid of v.hexes) {
    const h = b.hexes[hid];
    if (h && h.terrain !== '沙漠') out.add(h.terrain);
  }
  return out;
}

function portText(b: Board, vertexId: number): string {
  const v = b.vertices[vertexId];
  if (!v || !v.port) return '';
  return v.port === '通用' ? ' 港口(通用3:1)' : ` 港口(${v.port}2:1)`;
}

function distanceRuleText(b: Board, s: GameState, vertexId: number): string {
  const v = b.vertices[vertexId];
  if (!v) return '';
  const adjacentBuildings = v.neighbors.filter((n) => !!s.buildings[n]);
  if (adjacentBuildings.length === 0) {
    return '；距离规则已满足：相邻顶点均无建筑';
  }
  return `；⚠ 距离规则不满足：相邻顶点 ${adjacentBuildings.map((n) => `v${n}`).join('、')} 已有建筑`;
}

function stateWithRoad(s: GameState, edgeId: number, owner: number): GameState {
  return {
    ...s,
    roads: {
      ...s.roads,
      [edgeId]: { owner },
    },
  };
}

function edgeBetween(b: Board, a: number, c: number) {
  return b.edges.find((e) => (e.v1 === a && e.v2 === c) || (e.v1 === c && e.v2 === a));
}

function hasPlayerRoadOrBuildingAt(b: Board, s: GameState, vertexId: number, player: number): boolean {
  const bld = s.buildings[vertexId];
  if (bld) return bld.owner === player;
  return b.edges.some(
    (e) =>
      (e.v1 === vertexId || e.v2 === vertexId) &&
      s.roads[e.id] != null &&
      s.roads[e.id].owner === player,
  );
}

function describeBuildTarget(b: Board, vertexId: number): string {
  const tiles = describeVertexTiles(b, vertexId);
  const sum = vertexYieldPointSum(b, vertexId);
  const kinds = vertexResourceKinds(b, vertexId).size;
  const port = portText(b, vertexId);
  return `v${vertexId}→${tiles} ${sum}产出点/${kinds}种${port}`;
}

/**
 * 当前玩家现有建筑构成的"产出组合"：每种资源累计产出点（城市×2）。
 * 关系性信息：把候选点和"你已经在产什么"做对比，是模型自己算不出的协同视角。
 * 强盗压制是回合级临时状态，这里只看长期建筑组合，故不扣强盗。
 */
function playerProductionProfile(b: Board, s: GameState, player: number): ResMap {
  const prof = emptyRes();
  for (const [vStr, bld] of Object.entries(s.buildings)) {
    if (bld.owner !== player) continue;
    const v = b.vertices[Number(vStr)];
    if (!v) continue;
    const mult = bld.type === 'city' ? 2 : 1;
    for (const hid of v.hexes) {
      const h = b.hexes[hid];
      if (h && h.terrain !== '沙漠' && h.number != null) {
        prof[h.terrain as Resource] += yieldPoints(h.number) * mult;
      }
    }
  }
  return prof;
}

/**
 * 候选顶点产出与玩家现有产出组合的对齐：
 *  - "补你0产出的 X"：你当前完全不产的资源，建在此可补全资源多样性
 *  - "叠加已有 Y"：你已在产、此处会进一步加厚的资源
 * setup1 无建筑时全部算"补你0产出"，符合直觉（首点什么都缺）。
 */
function portfolioAlignText(b: Board, s: GameState, vertexId: number, player: number): string {
  const v = b.vertices[vertexId];
  if (!v) return '';
  const prof = playerProductionProfile(b, s, player);
  const seen = new Set<Resource>();
  const fresh: Resource[] = [];
  const stack: Resource[] = [];
  for (const hid of v.hexes) {
    const h = b.hexes[hid];
    if (!h || h.terrain === '沙漠' || h.number == null) continue;
    const r = h.terrain as Resource;
    if (seen.has(r)) continue;
    seen.add(r);
    if (prof[r] === 0) fresh.push(r);
    else stack.push(r);
  }
  const parts: string[] = [];
  if (fresh.length > 0) parts.push(`补你0产出的 ${fresh.join('')}`);
  if (stack.length > 0) parts.push(`叠加已有 ${stack.join('')}`);
  return parts.length > 0 ? `；产出组合：${parts.join('、')}` : '';
}

/** 与某顶点"共享地块"的对手（同一 hex 上已有对手建筑），按 id 升序去重 */
function contestedOpponents(b: Board, s: GameState, vertexId: number, player: number): number[] {
  const v = b.vertices[vertexId];
  if (!v) return [];
  const opp = new Set<number>();
  for (const hid of v.hexes) {
    const h = b.hexes[hid];
    if (!h) continue;
    for (const c of h.corners) {
      const bld = s.buildings[c];
      if (bld && bld.owner !== player) opp.add(bld.owner);
    }
  }
  return [...opp].sort((a, c) => a - c);
}

/** 城市加倍的资源在你当前产出组合中的丰寡（边际价值参考） */
function cityDoubleScarcityText(b: Board, s: GameState, vertexId: number, player: number): string {
  const v = b.vertices[vertexId];
  if (!v) return '';
  const prof = playerProductionProfile(b, s, player);
  const seen = new Set<Resource>();
  const parts: string[] = [];
  for (const hid of v.hexes) {
    const h = b.hexes[hid];
    if (!h || h.terrain === '沙漠' || h.number == null) continue;
    const r = h.terrain as Resource;
    if (seen.has(r)) continue;
    seen.add(r);
    parts.push(`${r}(现${prof[r]}产出点)`);
  }
  return parts.length > 0 ? `；加倍 ${parts.join(' ')}` : '';
}

/** 顶点周边 hex 短标签，用于道路端点压缩描述："麦8,矿6,木3" */
function vertexTilesShort(b: Board, vertexId: number): string {
  const v = b.vertices[vertexId];
  if (!v) return '?';
  const parts = v.hexes
    .map((hid) => b.hexes[hid])
    .filter((h): h is NonNullable<typeof h> => h != null)
    .map((h) => (h.terrain === '沙漠' || h.number == null ? '沙漠' : `${h.terrain}${h.number}`));
  return parts.length > 0 ? parts.join(',') : '?';
}

/** 房屋/城市建筑的空间情报；用于把对手 / 自己已建顶点翻译给 LLM */
export function buildingSummary(b: Board, vertexId: number): string {
  return describeBuildTarget(b, vertexId);
}

/** 道路的空间情报：两端顶点的 hex 短标签 */
export function roadSummary(b: Board, edgeId: number): string {
  const e = b.edges[edgeId];
  if (!e) return `e${edgeId}: ?`;
  return `e${edgeId}: v${e.v1}[${vertexTilesShort(b, e.v1)}]↔v${e.v2}[${vertexTilesShort(b, e.v2)}]`;
}

/** 顶点上的建筑：返回 owner+类型，无则 null */
function buildingAt(s: GameState, vertexId: number): { owner: number; type: 'settlement' | 'city' } | null {
  const b = s.buildings[vertexId];
  return b ? { owner: b.owner, type: b.type } : null;
}

// ---------- 对外 API ----------

/**
 * 建/初始放房屋的 hint：周围 hex 摘要 + 港口 + 产出点总分
 * + 产出组合对齐（补缺/叠加）+ 与对手共享地块的争产/卡位关系（关系性信息，模型自己算不出）。
 */
export function settlementHint(b: Board, s: GameState, vertexId: number, player: number): string {
  const tiles = describeVertexTiles(b, vertexId);
  const sum = vertexYieldPointSum(b, vertexId);
  const kinds = vertexResourceKinds(b, vertexId).size;
  const port = portText(b, vertexId);
  const distance = distanceRuleText(b, s, vertexId);
  const align = portfolioAlignText(b, s, vertexId, player);
  const opp = contestedOpponents(b, s, vertexId, player);
  const contested = opp.length > 0 ? `；与 ${opp.map((o) => `P${o}`).join('、')} 共享地块(争产/卡位)` : '';
  return `周边 ${tiles}；总产出 ${sum}产出点；${kinds} 种资源${port}${distance}${align}${contested}`;
}

/** 升级城市的 hint：产出翻倍 + 加倍资源在你产出组合中的丰寡（边际价值参考） */
export function cityHint(b: Board, s: GameState, vertexId: number, player: number): string {
  const tiles = describeVertexTiles(b, vertexId);
  const sum = vertexYieldPointSum(b, vertexId);
  const scarcity = cityDoubleScarcityText(b, s, vertexId, player);
  return `升级后产出翻倍：周边 ${tiles}；翻倍后 ${sum * 2}产出点${scarcity}`;
}

/**
 * 建/初始放路的 hint：
 *  - 不把道路端点的资源误当成收益：端点若紧邻已有建筑，受距离规则约束不能建房
 *  - 模拟修完此路后的可建点；若端点不可建，再看从该端点继续一条路后的隔点候选
 */
export function roadHint(b: Board, s: GameState, edgeId: number, currentPlayer: number): string {
  const e = b.edges[edgeId];
  if (!e) return '?';
  const ends = [e.v1, e.v2];
  const occupied = ends.filter((vid) => !!buildingAt(s, vid));
  const afterRoad = stateWithRoad(s, edgeId, currentPlayer);
  const connectedBefore = new Set(
    ends.filter((vid) => hasPlayerRoadOrBuildingAt(b, s, vid, currentPlayer)),
  );
  const frontier = ends.filter((vid) => !connectedBefore.has(vid));
  const frontierEnds = frontier.length > 0 ? frontier : ends;

  if (occupied.length === ends.length) {
    const detail = occupied
      .map((vid) => {
        const b1 = buildingAt(s, vid)!;
        const owner = b1.owner === currentPlayer ? '己方' : `P${b1.owner}`;
        return `v${vid}(${owner}${b1.type === 'city' ? '城' : '房'})`;
      })
      .join(' ↔ ');
    return `两端均已饱和：${detail}；仅延长路网长度`;
  }

  const immediate = frontierEnds
    .filter((vid) => !buildingAt(s, vid) && canBuildSettlement(b, afterRoad, vid, currentPlayer))
    .map((vid) => describeBuildTarget(b, vid));

  const oneMore = new Map<number, string>();
  for (const from of frontierEnds) {
    for (const to of b.vertices[from]?.neighbors ?? []) {
      if (ends.includes(to)) continue;
      const nextEdge = edgeBetween(b, from, to);
      if (!nextEdge || nextEdge.id === edgeId || s.roads[nextEdge.id]) continue;
      if (!canBuildRoad(b, afterRoad, nextEdge.id, currentPlayer)) continue;
      const afterSecondRoad = stateWithRoad(afterRoad, nextEdge.id, currentPlayer);
      if (!canBuildSettlement(b, afterSecondRoad, to, currentPlayer)) continue;
      oneMore.set(to, `经 v${from} 再修 e${nextEdge.id} 到 ${describeBuildTarget(b, to)}`);
    }
  }

  const blockedFrontier = frontierEnds
    .filter((vid) => !buildingAt(s, vid) && !canBuildSettlement(b, afterRoad, vid, currentPlayer))
    .map((vid) => {
      const adjacent = b.vertices[vid]?.neighbors.filter((n) => !!s.buildings[n]) ?? [];
      return adjacent.length > 0
        ? `v${vid} 不能建：相邻 ${adjacent.map((n) => `v${n}`).join('、')} 已有建筑`
        : `v${vid} 暂不能建`;
    });

  const contestOpp = new Set<number>();
  for (const vid of frontierEnds) for (const o of contestedOpponents(b, s, vid, currentPlayer)) contestOpp.add(o);

  const parts = [];
  parts.push(`路端 ${frontierEnds.map((vid) => `v${vid}`).join('、')}`);
  if (blockedFrontier.length > 0) parts.push(blockedFrontier.join('；'));
  if (immediate.length > 0) parts.push(`修完即可建：${immediate.join('；')}`);
  if (oneMore.size > 0) parts.push(`隔点候选：${[...oneMore.values()].join('；')}`);
  if (immediate.length === 0 && oneMore.size === 0) parts.push('暂未打开可建房屋位，仅延长路网/争最长路');
  if (contestOpp.size > 0) {
    parts.push(`卡位：路端与 ${[...contestOpp].sort((a, c) => a - c).map((o) => `P${o}`).join('、')} 共享地块`);
  }
  return parts.join('；');
}

/** 强盗目标 hint：该 hex 资源/数字 + 上面的玩家分布（可偷谁） */
export function robberHint(b: Board, s: GameState, hexId: number, currentPlayer: number): string {
  const h = b.hexes[hexId];
  if (!h) return '?';
  const tag = h.terrain === '沙漠' ? '沙漠' : `${h.terrain}${h.number ?? '?'}(${yieldPoints(h.number)}产出点)`;

  // 统计该 hex 6 个角点上的建筑分布
  const ownerCount = new Map<number, { settlements: number; cities: number }>();
  for (const vid of h.corners) {
    const bld = buildingAt(s, vid);
    if (!bld) continue;
    if (!ownerCount.has(bld.owner)) ownerCount.set(bld.owner, { settlements: 0, cities: 0 });
    const slot = ownerCount.get(bld.owner)!;
    if (bld.type === 'city') slot.cities++;
    else slot.settlements++;
  }
  if (ownerCount.size === 0) {
    return `${tag}；上面无任何建筑（无人可偷，只是封锁该资源）`;
  }
  const breakdown = [...ownerCount.entries()]
    .map(([owner, c]) => {
      const tag2 = owner === currentPlayer ? '己方' : `P${owner}`;
      const pieces = [];
      if (c.settlements) pieces.push(`房×${c.settlements}`);
      if (c.cities) pieces.push(`城×${c.cities}`);
      return `${tag2}(${pieces.join('+')})`;
    })
    .join('、');

  // 仅压自己时给个显式警告
  const onlySelf = ownerCount.size === 1 && ownerCount.has(currentPlayer);
  const warn = onlySelf ? '；⚠ 只压己方建筑（自伤）' : '';
  return `${tag}；上面：${breakdown}${warn}`;
}
