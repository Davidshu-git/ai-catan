// ============================================================
// 语义化动作提示：把 vertex/edge/hex id 翻译成"战略情报文本"
// ------------------------------------------------------------
// 目的：减轻 LLM 的拓扑推理负担。LLM 看到 `build-settlement-v42`
// 时不需要在脑里反查 v42→相邻 hex→数字→资源，hint 已经写好了。
// 设计：所有 hint 一句话、可读、信息密度高；不要写"建议"/"应该"，
// 只摆事实（资源+概率+港口+敌我建筑分布），让 LLM 自己决策。
// 改 hint 文本时注意：会进入 LLM prompt 和 ai_thought 日志。
// ============================================================

import type { Board, GameState, Resource, Terrain } from '../../shared/types';
import { pips } from '../../shared/types';

/** 资源/地形显示顺序，便于 LLM 比较时稳定 */
const TERRAIN_ORDER: Terrain[] = ['麦', '矿', '木', '砖', '羊', '沙漠'];

/** 把一个顶点周边的 hex 描述成 "麦8(5) 矿11(2) 木6(5)" 形式 */
function describeVertexTiles(b: Board, vertexId: number): string {
  const v = b.vertices[vertexId];
  if (!v) return '?';
  const parts = v.hexes
    .map((hid) => b.hexes[hid])
    .filter((h): h is NonNullable<typeof h> => h != null)
    .sort((a, b) => TERRAIN_ORDER.indexOf(a.terrain) - TERRAIN_ORDER.indexOf(b.terrain))
    .map((h) => {
      if (h.terrain === '沙漠' || h.number == null) return '沙漠';
      return `${h.terrain}${h.number}(${pips(h.number)})`;
    });
  return parts.length > 0 ? parts.join(' ') : '?';
}

/** 顶点资源点数总和（dice pips），用于 LLM 直观对比"产出潜力" */
function vertexPipSum(b: Board, vertexId: number): number {
  const v = b.vertices[vertexId];
  if (!v) return 0;
  let sum = 0;
  for (const hid of v.hexes) {
    const h = b.hexes[hid];
    if (h && h.terrain !== '沙漠') sum += pips(h.number);
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

/** 顶点上的建筑：返回 owner+类型，无则 null */
function buildingAt(s: GameState, vertexId: number): { owner: number; type: 'settlement' | 'city' } | null {
  const b = s.buildings[vertexId];
  return b ? { owner: b.owner, type: b.type } : null;
}

// ---------- 对外 API ----------

/** 建/初始放房屋的 hint：周围 hex 摘要 + 港口 + pip 总分 */
export function settlementHint(b: Board, vertexId: number): string {
  const tiles = describeVertexTiles(b, vertexId);
  const sum = vertexPipSum(b, vertexId);
  const kinds = vertexResourceKinds(b, vertexId).size;
  const port = portText(b, vertexId);
  return `周边 ${tiles}；总产出 ${sum}pip；${kinds} 种资源${port}`;
}

/** 升级城市的 hint：同 vertexHint，但加"产出翻倍"提示 */
export function cityHint(b: Board, vertexId: number): string {
  const tiles = describeVertexTiles(b, vertexId);
  const sum = vertexPipSum(b, vertexId);
  return `升级后产出翻倍：周边 ${tiles}；翻倍后 ${sum * 2}pip`;
}

/**
 * 建/初始放路的 hint：
 *  - 若有一端是"可未来建房屋的空顶点"，描述其资源潜力（最有用的信息）
 *  - 若两端都已被建筑占据，说明"纯延长"
 */
export function roadHint(b: Board, s: GameState, edgeId: number, currentPlayer: number): string {
  const e = b.edges[edgeId];
  if (!e) return '?';
  const ends = [e.v1, e.v2];
  const open = ends.filter((vid) => !buildingAt(s, vid));
  const occupied = ends.filter((vid) => !!buildingAt(s, vid));

  if (open.length === 0) {
    const detail = occupied
      .map((vid) => {
        const b1 = buildingAt(s, vid)!;
        const owner = b1.owner === currentPlayer ? '己方' : `P${b1.owner}`;
        return `v${vid}(${owner}${b1.type === 'city' ? '城' : '房'})`;
      })
      .join(' ↔ ');
    return `两端均已饱和：${detail}；仅延长路网长度`;
  }

  // 优先描述空端的资源潜力
  const targets = open.map((vid) => {
    const tiles = describeVertexTiles(b, vid);
    const sum = vertexPipSum(b, vid);
    const port = portText(b, vid);
    return `v${vid}→${tiles} ${sum}pip${port}`;
  });
  return `通往：${targets.join('；')}`;
}

/** 强盗目标 hint：该 hex 资源/数字 + 上面的玩家分布（可偷谁） */
export function robberHint(b: Board, s: GameState, hexId: number, currentPlayer: number): string {
  const h = b.hexes[hexId];
  if (!h) return '?';
  const tag = h.terrain === '沙漠' ? '沙漠' : `${h.terrain}${h.number ?? '?'}(${pips(h.number)}pip)`;

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
