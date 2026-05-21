// ============================================================
// 合法动作目录：根据 board + state + currentPlayer 枚举当前可执行 Action
// ------------------------------------------------------------
// 复用 shared/rules.ts 的判定函数；不要在 server 重新实现规则。
// discard 阶段不在此处枚举（组合爆炸），由 controller fallback 到 rule AI。
// OFFER_TRADE 不在此处枚举（属于第 3 阶段交易子系统）。
// ============================================================

import type { Board, GameState } from '../../shared/types';
import { COSTS, RESOURCES, RESOURCE_LABEL, DEV_LABEL } from '../../shared/types';
import {
  canAfford,
  canBuildCity,
  canBuildRoad,
  canBuildSettlement,
  canPlaceRoadSetup,
  canPlaceSettlementFree,
  tradeRatio,
} from '../../shared/rules';
import { robberCandidates } from '../../shared/reducer';
import type { LegalAction } from './types';
import { settlementHint, cityHint, roadHint, robberHint } from './actionHints';

/** 当前阶段 + 当前玩家的所有合法动作 */
export function buildActionCatalog(b: Board, s: GameState): LegalAction[] {
  switch (s.phase) {
    case 'setup1':
    case 'setup2':
      return s.setupStep === 'settlement' ? setupSettlements(b, s) : setupRoads(b, s);
    case 'roll':
      return rollActions(s);
    case 'moveRobber':
      return moveRobberActions(b, s);
    case 'steal':
      return stealActions(b, s);
    case 'main':
      return mainActions(b, s);
    case 'discard':
    case 'gameOver':
    default:
      // discard 由 controller 走 rule AI 兜底；gameOver 无动作
      return [];
  }
}

// ---------- setup ----------

function setupSettlements(b: Board, s: GameState): LegalAction[] {
  const out: LegalAction[] = [];
  for (const v of b.vertices) {
    if (canPlaceSettlementFree(b, s, v.id)) {
      out.push({
        id: `setup-settlement-v${v.id}`,
        label: `在顶点 v${v.id} 放置初始房屋`,
        hint: settlementHint(b, v.id),
        action: { type: 'PLACE_SETTLEMENT', v: v.id },
      });
    }
  }
  return out;
}

function setupRoads(b: Board, s: GameState): LegalAction[] {
  const out: LegalAction[] = [];
  for (const e of b.edges) {
    if (canPlaceRoadSetup(b, s, e.id)) {
      out.push({
        id: `setup-road-e${e.id}`,
        label: `在边 e${e.id} 放置初始道路`,
        hint: roadHint(b, s, e.id, s.current),
        action: { type: 'PLACE_ROAD', e: e.id },
      });
    }
  }
  return out;
}

// ---------- roll ----------

function rollActions(s: GameState): LegalAction[] {
  const out: LegalAction[] = [
    { id: 'roll', label: '掷骰子', action: { type: 'ROLL' } },
  ];
  // 掷骰前可打骑士卡
  const me = s.players[s.current];
  if (!s.devPlayed && me.devCards.includes('骑士')) {
    out.push({
      id: 'play-knight',
      label: '掷骰前打出骑士卡（移动强盗 + 偷牌）',
      action: { type: 'PLAY_KNIGHT' },
    });
  }
  return out;
}

// ---------- robber ----------

function moveRobberActions(b: Board, s: GameState): LegalAction[] {
  const out: LegalAction[] = [];
  for (const h of b.hexes) {
    if (h.id === s.robber) continue;
    const tag = h.terrain === '沙漠' ? '沙漠' : `${h.number ?? '?'} 号 ${h.terrain}`;
    out.push({
      id: `move-robber-h${h.id}`,
      label: `把强盗移到地块 ${tag}`,
      hint: robberHint(b, s, h.id, s.current),
      action: { type: 'MOVE_ROBBER', hex: h.id },
    });
  }
  return out;
}

function stealActions(b: Board, s: GameState): LegalAction[] {
  const targets = robberCandidates(b, s);
  if (targets.length === 0) {
    // 防御：reducer 不会走到这（finishRobber 应当兜住），但保险起见给 END_TURN 之外的 noop 占位很难，
    // 此时直接返回空列表，controller 会重试 / fallback。
    return [];
  }
  return targets.map((tid) => ({
    id: `steal-p${tid}`,
    label: `从 ${s.players[tid].name} 偷一张随机牌`,
    action: { type: 'STEAL', target: tid },
  }));
}

// ---------- main ----------

function mainActions(b: Board, s: GameState): LegalAction[] {
  const out: LegalAction[] = [];
  const me = s.players[s.current];
  const freeRoad = s.freeRoads > 0;
  const canRoadCost = freeRoad || canAfford(me, COSTS.road);
  const canSettCost = canAfford(me, COSTS.settlement);
  const canCityCost = canAfford(me, COSTS.city);

  // 建路
  if (canRoadCost) {
    for (const e of b.edges) {
      if (canBuildRoad(b, s, e.id, s.current)) {
        out.push({
          id: `build-road-e${e.id}`,
          label: freeRoad ? `修路（免费）在边 e${e.id}` : `修路在边 e${e.id}`,
          hint: roadHint(b, s, e.id, s.current),
          action: { type: 'BUILD_ROAD', e: e.id },
        });
      }
    }
  }
  // 建房屋
  if (canSettCost) {
    for (const v of b.vertices) {
      if (canBuildSettlement(b, s, v.id, s.current)) {
        out.push({
          id: `build-settlement-v${v.id}`,
          label: `建房屋在顶点 v${v.id}`,
          hint: settlementHint(b, v.id),
          action: { type: 'BUILD_SETTLEMENT', v: v.id },
        });
      }
    }
  }
  // 升级城市
  if (canCityCost) {
    for (const v of b.vertices) {
      if (canBuildCity(s, v.id, s.current)) {
        out.push({
          id: `build-city-v${v.id}`,
          label: `升级城市在顶点 v${v.id}`,
          hint: cityHint(b, v.id),
          action: { type: 'BUILD_CITY', v: v.id },
        });
      }
    }
  }
  // 买发展卡
  if (canAfford(me, COSTS.dev) && s.devDeck.length > 0) {
    out.push({ id: 'buy-dev', label: '购买发展卡', action: { type: 'BUY_DEV' } });
  }
  // 打发展卡（一回合限一张）
  if (!s.devPlayed) {
    if (me.devCards.includes('骑士')) {
      out.push({
        id: 'play-knight',
        label: `打出 ${DEV_LABEL.骑士} 卡（移动强盗+偷牌）`,
        action: { type: 'PLAY_KNIGHT' },
      });
    }
    if (me.devCards.includes('修路')) {
      out.push({
        id: 'play-road-building',
        label: `打出 ${DEV_LABEL.修路} 卡（免费 2 条路）`,
        action: { type: 'PLAY_ROAD_BUILDING' },
      });
    }
    if (me.devCards.includes('丰收')) {
      // 无序对（含重复）：5*(5+1)/2 = 15 条
      for (let i = 0; i < RESOURCES.length; i++) {
        for (let j = i; j < RESOURCES.length; j++) {
          const r1 = RESOURCES[i];
          const r2 = RESOURCES[j];
          out.push({
            id: `yop-${r1}-${r2}`,
            label: `打出 ${DEV_LABEL.丰收}：拿 ${RESOURCE_LABEL[r1]} + ${RESOURCE_LABEL[r2]}`,
            action: { type: 'PLAY_YEAR_OF_PLENTY', r1, r2 },
          });
        }
      }
    }
    if (me.devCards.includes('垄断')) {
      for (const r of RESOURCES) {
        out.push({
          id: `monopoly-${r}`,
          label: `打出 ${DEV_LABEL.垄断}：抢光所有人的 ${RESOURCE_LABEL[r]}`,
          action: { type: 'PLAY_MONOPOLY', r },
        });
      }
    }
  }
  // 银行/港口兑换
  for (const give of RESOURCES) {
    const ratio = tradeRatio(b, s, s.current, give);
    if (me.resources[give] < ratio) continue;
    for (const receive of RESOURCES) {
      if (receive === give) continue;
      if (s.bank[receive] < 1) continue;
      out.push({
        id: `bank-${give}-to-${receive}`,
        label: `银行 ${ratio}:1 兑换：${ratio}×${RESOURCE_LABEL[give]} → 1×${RESOURCE_LABEL[receive]}`,
        action: { type: 'BANK_TRADE', give, receive },
      });
    }
  }
  // 结束回合永远可选
  out.push({ id: 'end-turn', label: '结束回合', action: { type: 'END_TURN' } });
  return out;
}

export type { LegalAction } from './types';
