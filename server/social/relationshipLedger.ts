// ============================================================
// 关系账本（Relationship Ledger）—— AI 社交房间第 2 层地基
// ------------------------------------------------------------
// 每个玩家对其他玩家的"看法"，由游戏事件以**确定性规则**驱动更新，
// 零额外 LLM 调用。最终压成一段自然语言塞进交易 prompt，让 AI 的
// 报价 / 接受倾向随恩怨变化（对头不给好价、联手压制领先者）。
//
// 设计定位：与谈判状态同级，纯服务端编排状态，**不进 shared/state.ts**，
// reducer 不感知它；server 重启丢失可接受（与现状一致）。
// ============================================================

import { publicVP } from '../../shared/rules';
import { playerDisplayName } from '../../shared/state';
import {
  RESOURCES,
  type Board,
  type GameState,
  type ResMap,
  type Resource,
} from '../../shared/types';

/** viewer 对单个 target 的看法 */
export interface Relationship {
  /** 信任：-100(死敌) .. 100(铁盟)；公平成交↑，被强盗针对/被坑↓ */
  trust: number;
  /** 警惕：0 .. 100；对方逼近胜利 / 拿下最长路最大军队↑ */
  threat: number;
  /** 人情账（有符号）：>0 表示 viewer 觉得自己欠 target；<0 表示 target 欠 viewer */
  debt: number;
  /** 最近几条交互摘要（自然语言），供 prompt 直接引用 */
  recent: string[];
}

/** ledger[viewer][target] = viewer 对 target 的看法 */
export type RelationshipLedger = Record<number, Record<number, Relationship>>;

export type RelationshipEventType = 'robber' | 'longest-road' | 'largest-army' | 'near-win';

/**
 * 一次状态跃迁里检测到的"社交可发声事件"。账本据此更新看法，社交层据此触发发言。
 * 由 applyTransition 返回，避免社交层再 diff 一遍。
 */
export interface RelationshipEvent {
  type: RelationshipEventType;
  /** 事件主角（移动强盗的人 / 拿下成就的人 / 逼近胜利的人） */
  actor: number;
  actorName: string;
  /** 可能想就此发声的玩家（强盗受害者；其余事件为除 actor 外全体），均为潜在 speaker */
  affected: number[];
  /** 第三人称简述，给社交 prompt 当由头 */
  note: string;
}

const MAX_RECENT = 4;

// 各类事件对 trust/threat 的确定性增量（保守初值，可后续调参）
const W = {
  tradeTrust: 6, // 公平成交，双方互信 +
  lopsidedDebt: 1, // 倾斜成交，吃亏方记一笔人情
  robberTrust: -10, // 强盗砸到我家门口，对操作者信任 -
  robberThreat: 6, // 同上，警惕 +
  longestRoadThreat: 8, // 有人拿下最长路，全场警惕 +
  largestArmyThreat: 8, // 有人拿下最大军队，全场警惕 +
  nearWinThreat: 12, // 有人逼近胜利（publicVP>=8），全场警惕 +
} as const;

const NEAR_WIN_VP = 8;

const RESOURCE_WEIGHT: Record<Resource, number> = {
  木: 1.05,
  砖: 1.05,
  羊: 1,
  麦: 1.25,
  矿: 1.2,
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function emptyRelationship(): Relationship {
  return { trust: 0, threat: 0, debt: 0, recent: [] };
}

/** 为当前所有玩家两两建立初始（中立）关系 */
export function createRelationshipLedger(state: GameState): RelationshipLedger {
  const ledger: RelationshipLedger = {};
  for (const viewer of state.players) {
    ledger[viewer.id] = {};
    for (const target of state.players) {
      if (target.id === viewer.id) continue;
      ledger[viewer.id][target.id] = emptyRelationship();
    }
  }
  return ledger;
}

function rel(ledger: RelationshipLedger, viewer: number, target: number): Relationship | null {
  if (viewer === target) return null;
  const row = (ledger[viewer] ??= {});
  return (row[target] ??= emptyRelationship());
}

function pushRecent(r: Relationship, text: string) {
  r.recent.push(text);
  if (r.recent.length > MAX_RECENT) r.recent.splice(0, r.recent.length - MAX_RECENT);
}

function resValue(res: ResMap): number {
  let v = 0;
  for (const r of RESOURCES) v += (res[r] ?? 0) * RESOURCE_WEIGHT[r];
  return v;
}

function resStr(res: ResMap): string {
  const parts = RESOURCES.filter((r) => (res[r] ?? 0) > 0).map((r) => `${r}×${res[r]}`);
  return parts.join('') || '无';
}

function name(state: GameState, id: number): string {
  return playerDisplayName(state.players, id);
}

// ------------------------------------------------------------
// 1) 成交事件（显式调用）：from 给出 give、收到 receive；to 反之。
//    谈判成交点（AI↔AI / 人↔AI）拿得到精确 offer，比 diff 推断可靠。
// ------------------------------------------------------------
export function applyTradeOutcome(
  ledger: RelationshipLedger,
  state: GameState,
  from: number,
  to: number,
  give: ResMap,
  receive: ResMap,
) {
  const rFrom = rel(ledger, from, to);
  const rTo = rel(ledger, to, from);
  if (!rFrom || !rTo) return;

  // 合意成交本身建立互信
  rFrom.trust = clamp(rFrom.trust + W.tradeTrust, -100, 100);
  rTo.trust = clamp(rTo.trust + W.tradeTrust, -100, 100);

  // from 的净收益 = 收到价值 - 给出价值；明显占便宜的一方欠对方人情
  const netFrom = resValue(receive) - resValue(give);
  if (netFrom > 1.5) {
    rFrom.debt += W.lopsidedDebt; // from 占了便宜，欠 to
    rTo.debt -= W.lopsidedDebt;
  } else if (netFrom < -1.5) {
    rTo.debt += W.lopsidedDebt; // to 占了便宜，欠 from
    rFrom.debt -= W.lopsidedDebt;
  }

  const turn = state.turn;
  pushRecent(rFrom, `第${turn}回合：与${name(state, to)}成交（给${resStr(give)}换${resStr(receive)}）`);
  pushRecent(rTo, `第${turn}回合：与${name(state, from)}成交（给${resStr(receive)}换${resStr(give)}）`);
}

// ------------------------------------------------------------
// 2) 状态跃迁（diff 调用）：每次权威 reduce 后比较 prev→next，
//    捕捉与交易无关的敌意/威胁信号。**不推断成交**（交给上面的显式入口）。
// ------------------------------------------------------------
export function applyTransition(
  ledger: RelationshipLedger,
  board: Board,
  prev: GameState,
  next: GameState,
): RelationshipEvent[] {
  const out: RelationshipEvent[] = [];

  // 2.1 强盗移动：操作者 = prev.current；受害者 = 新地块上有建筑的其他玩家
  if (prev.robber !== next.robber) {
    const mover = prev.current;
    const hex = board.hexes[next.robber];
    if (hex) {
      const victims = new Set<number>();
      for (const v of hex.corners) {
        const bld = next.buildings[v];
        if (bld && bld.owner !== mover) victims.add(bld.owner);
      }
      for (const victim of victims) {
        const r = rel(ledger, victim, mover);
        if (!r) continue;
        r.trust = clamp(r.trust + W.robberTrust, -100, 100);
        r.threat = clamp(r.threat + W.robberThreat, 0, 100);
        pushRecent(r, `第${next.turn}回合：${name(next, mover)}把强盗放到我家门口`);
      }
      if (victims.size > 0) {
        out.push({
          type: 'robber',
          actor: mover,
          actorName: name(next, mover),
          affected: [...victims],
          note: `${name(next, mover)}把强盗砸向了你`,
        });
      }
    }
  }

  // 2.2 最长路易主：全场对新持有者警惕 +
  if (
    next.longestRoad.player !== null &&
    next.longestRoad.player !== prev.longestRoad.player
  ) {
    out.push(bumpThreatToward(ledger, next, next.longestRoad.player, W.longestRoadThreat, '拿下最长路', 'longest-road'));
  }

  // 2.3 最大军队易主：同理
  if (
    next.largestArmy.player !== null &&
    next.largestArmy.player !== prev.largestArmy.player
  ) {
    out.push(bumpThreatToward(ledger, next, next.largestArmy.player, W.largestArmyThreat, '拿下最大军队', 'largest-army'));
  }

  // 2.4 逼近胜利：publicVP 从 <8 跨到 >=8，全场对其警惕 +（每次跨越触发一次）
  for (const p of next.players) {
    const before = publicVP(prev, p.id);
    const after = publicVP(next, p.id);
    if (before < NEAR_WIN_VP && after >= NEAR_WIN_VP) {
      out.push(bumpThreatToward(ledger, next, p.id, W.nearWinThreat, `已${after}分逼近胜利`, 'near-win'));
    }
  }

  return out;
}

function bumpThreatToward(
  ledger: RelationshipLedger,
  state: GameState,
  target: number,
  amount: number,
  reason: string,
  type: RelationshipEventType,
): RelationshipEvent {
  const affected: number[] = [];
  for (const viewer of state.players) {
    if (viewer.id === target) continue;
    affected.push(viewer.id);
    const r = rel(ledger, viewer.id, target);
    if (!r) continue;
    r.threat = clamp(r.threat + amount, 0, 100);
    pushRecent(r, `第${state.turn}回合：${name(state, target)}${reason}`);
  }
  return {
    type,
    actor: target,
    actorName: name(state, target),
    affected,
    note: `${name(state, target)}${reason}`,
  };
}

// ------------------------------------------------------------
// 3) 压成自然语言喂 prompt：viewer 对每个 target 的一句话看法。
//    没有任何恩怨（全中立）时返回空串，避免给 prompt 添噪。
// ------------------------------------------------------------
export function describeRelationships(
  ledger: RelationshipLedger,
  viewer: number,
  state: GameState,
): string {
  const row = ledger[viewer];
  if (!row) return '';
  const lines: string[] = [];
  for (const p of state.players) {
    if (p.id === viewer) continue;
    const r = row[p.id];
    if (!r) continue;
    const tags = relationshipTags(r);
    if (tags.length === 0) continue; // 中立则不写
    let line = `${name(state, p.id)}：${tags.join('、')}`;
    if (r.recent.length > 0) line += `（${r.recent[r.recent.length - 1]}）`;
    lines.push(line);
  }
  if (lines.length === 0) return '';
  return lines.join('；');
}

function relationshipTags(r: Relationship): string[] {
  const tags: string[] = [];
  if (r.trust >= 12) tags.push('可结盟');
  else if (r.trust <= -12) tags.push('信任很低');
  else if (r.trust <= -6) tags.push('有嫌隙');
  if (r.threat >= 18) tags.push('高度警惕（领先威胁）');
  else if (r.threat >= 8) tags.push('需提防');
  if (r.debt >= 2) tags.push('我欠他人情');
  else if (r.debt <= -2) tags.push('他欠我人情');
  return tags;
}

/** 供观察者面板可视化用的扁平快照（Phase 后续接前端时使用） */
export function snapshotLedger(
  ledger: RelationshipLedger,
): Array<{ viewer: number; target: number; trust: number; threat: number; debt: number }> {
  const out: Array<{ viewer: number; target: number; trust: number; threat: number; debt: number }> = [];
  for (const viewerKey of Object.keys(ledger)) {
    const viewer = Number(viewerKey);
    for (const targetKey of Object.keys(ledger[viewer])) {
      const target = Number(targetKey);
      const r = ledger[viewer][target];
      out.push({ viewer, target, trust: r.trust, threat: r.threat, debt: r.debt });
    }
  }
  return out;
}
