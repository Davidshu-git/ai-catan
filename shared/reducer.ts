// ============================================================
// 状态机：动作 → 新状态（纯函数，返回克隆后的新状态）
// ============================================================

import type { Board, GameState, Resource, ResMap } from './types';
import { COSTS, RESOURCE_LABEL, RESOURCES } from './types';
import {
  canAfford,
  canBuildCity,
  canBuildRoad,
  canBuildSettlement,
  canPlaceRoadSetup,
  canPlaceSettlementFree,
  handSize,
  longestRoadLength,
  produceResources,
  totalVP,
  tradeRatio,
  updateLargestArmy,
  updateLongestRoad,
} from './rules';

export type Action =
  | { type: 'ROLL' }
  | { type: 'PLACE_SETTLEMENT'; v: number }
  | { type: 'PLACE_ROAD'; e: number }
  | { type: 'BUILD_SETTLEMENT'; v: number }
  | { type: 'BUILD_CITY'; v: number }
  | { type: 'BUILD_ROAD'; e: number }
  | { type: 'BUY_DEV' }
  | { type: 'PLAY_KNIGHT' }
  | { type: 'PLAY_ROAD_BUILDING' }
  | { type: 'PLAY_YEAR_OF_PLENTY'; r1: Resource; r2: Resource }
  | { type: 'PLAY_MONOPOLY'; r: Resource }
  | { type: 'MOVE_ROBBER'; hex: number }
  | { type: 'STEAL'; target: number }
  | { type: 'DISCARD'; player: number; cards: Partial<ResMap> }
  | { type: 'BANK_TRADE'; give: Resource; receive: Resource }
  | { type: 'OFFER_TRADE'; to: number; give: ResMap; receive: ResMap }
  | { type: 'TRADE_EXECUTE'; from: number; to: number; give: ResMap; receive: ResMap }
  | { type: 'RESPOND_TRADE'; accept: boolean }
  | { type: 'END_TURN' };

function log(s: GameState, text: string, turnMark = false, player?: number) {
  s.log.push({ text, turnMark, player });
}

/** 支付建造/购买成本：从玩家扣除并归还银行（保持资源守恒） */
function spend(s: GameState, p: number, cost: Partial<ResMap>) {
  const pl = s.players[p];
  for (const r of RESOURCES) {
    const c = cost[r] ?? 0;
    pl.resources[r] -= c;
    s.bank[r] += c;
  }
}

function resStr(m: Partial<ResMap>): string {
  const parts = RESOURCES.filter((r) => (m[r] ?? 0) > 0).map(
    (r) => `${RESOURCE_LABEL[r]}×${m[r]}`,
  );
  return parts.length ? parts.join(' ') : '无';
}

function checkVictory(s: GameState, p: number) {
  if (totalVP(s, p) >= 10) {
    s.winner = p;
    s.phase = 'gameOver';
    log(s, `🏆 ${s.players[p].name} 达到 10 分，获得胜利！`, false, p);
  }
}

/** 强盗落点后，可被偷的对手 id 列表 */
export function robberCandidates(b: Board, s: GameState): number[] {
  const hex = b.hexes[s.robber];
  const set = new Set<number>();
  for (const v of hex.corners) {
    const bld = s.buildings[v];
    if (bld && bld.owner !== s.current && handSize(s.players[bld.owner]) > 0) {
      set.add(bld.owner);
    }
  }
  return [...set];
}

function finishRobber(b: Board, s: GameState) {
  const cands = robberCandidates(b, s);
  if (cands.length === 0) {
    s.phase = s.robberReturn;
  } else {
    s.phase = 'steal';
  }
}

function advanceSetup(b: Board, s: GameState) {
  s.setupIndex++;
  if (s.setupIndex >= s.setupOrder.length) {
    s.phase = 'roll';
    s.current = s.setupOrder[0];
    s.turn = 1;
    s.lastSettlement = null;
    updateLongestRoad(b, s);
    log(s, `——— 第 1 回合 · ${s.players[s.current].name} ———`, true, s.current);
    return;
  }
  s.current = s.setupOrder[s.setupIndex];
  s.setupStep = 'settlement';
  s.phase = s.setupIndex < 4 ? 'setup1' : 'setup2';
}

function endTurn(b: Board, s: GameState) {
  const p = s.players[s.current];
  p.devCards.push(...p.newDevCards);
  p.newDevCards = [];
  s.devPlayed = false;
  s.freeRoads = 0;
  s.dice = null;
  s.pendingTrade = null;
  s.current = (s.current + 1) % s.players.length;
  s.turn++;
  s.phase = 'roll';
  log(s, `——— 第 ${s.turn} 回合 · ${s.players[s.current].name} ———`, true, s.current);
  updateLongestRoad(b, s);
}

function doTrade(s: GameState, from: number, to: number, give: ResMap, receive: ResMap) {
  for (const r of RESOURCES) {
    s.players[from].resources[r] -= give[r];
    s.players[to].resources[r] += give[r];
    s.players[to].resources[r] -= receive[r];
    s.players[from].resources[r] += receive[r];
  }
  log(
    s,
    `${s.players[from].name} 与 ${s.players[to].name} 交易：给出 ${resStr(give)}，换得 ${resStr(receive)}`,
    false, from,
  );
}

export function reduce(b: Board, prev: GameState, a: Action): GameState {
  const s: GameState = structuredClone(prev);
  const me = s.players[s.current];

  switch (a.type) {
    // ---------- setup ----------
    case 'PLACE_SETTLEMENT': {
      if (s.phase !== 'setup1' && s.phase !== 'setup2') break;
      if (s.setupStep !== 'settlement') break;
      if (!canPlaceSettlementFree(b, s, a.v)) break;
      s.buildings[a.v] = { type: 'settlement', owner: s.current };
      s.lastSettlement = a.v;
      if (s.setupIndex >= 4) {
        // 第二个房屋：发放相邻地块资源
        const got: Partial<ResMap> = {};
        for (const hid of b.vertices[a.v].hexes) {
          const h = b.hexes[hid];
          if (h.terrain === '沙漠') continue;
          const r = h.terrain as Resource;
          me.resources[r]++;
          s.bank[r]--;
          got[r] = (got[r] ?? 0) + 1;
        }
        log(s, `${me.name} 放置第二个房屋，获得 ${resStr(got)}`, false, me.id);
      } else {
        log(s, `${me.name} 放置初始房屋`, false, me.id);
      }
      s.setupStep = 'road';
      break;
    }
    case 'PLACE_ROAD': {
      if (s.phase !== 'setup1' && s.phase !== 'setup2') break;
      if (s.setupStep !== 'road') break;
      if (!canPlaceRoadSetup(b, s, a.e)) break;
      s.roads[a.e] = { owner: s.current };
      log(s, `${me.name} 放置初始道路`, false, me.id);
      s.lastSettlement = null;
      advanceSetup(b, s);
      break;
    }

    // ---------- 掷骰 ----------
    case 'ROLL': {
      if (s.phase !== 'roll') break;
      const d1 = 1 + Math.floor(Math.random() * 6);
      const d2 = 1 + Math.floor(Math.random() * 6);
      s.dice = [d1, d2];
      const sum = d1 + d2;
      log(s, `${me.name} 掷出 ${d1} + ${d2} = ${sum}`, false, me.id);
      if (sum === 7) {
        s.robberReturn = 'main';
        s.discardLeft = {};
        for (const p of s.players) {
          const n = handSize(p);
          if (n > 7) s.discardLeft[p.id] = Math.floor(n / 2);
        }
        if (Object.keys(s.discardLeft).length > 0) {
          s.phase = 'discard';
          log(s, `掷出 7！手牌超过 7 张的玩家需弃掉一半`);
        } else {
          s.phase = 'moveRobber';
          log(s, `掷出 7！${me.name} 移动强盗`, false, me.id);
        }
      } else {
        const gains = produceResources(b, s, sum);
        for (const p of s.players) {
          const g = gains[p.id];
          if (RESOURCES.some((r) => g[r] > 0)) {
            log(s, `${p.name} 获得 ${resStr(g)}`, false, p.id);
          }
        }
        s.phase = 'main';
      }
      break;
    }

    // ---------- 弃牌 ----------
    case 'DISCARD': {
      if (s.phase !== 'discard') break;
      const need = s.discardLeft[a.player];
      if (need == null) break;
      const total = RESOURCES.reduce((t, r) => t + (a.cards[r] ?? 0), 0);
      if (total !== need) break;
      const pl = s.players[a.player];
      if (!RESOURCES.every((r) => pl.resources[r] >= (a.cards[r] ?? 0))) break;
      for (const r of RESOURCES) {
        const c = a.cards[r] ?? 0;
        pl.resources[r] -= c;
        s.bank[r] += c;
      }
      delete s.discardLeft[a.player];
      log(s, `${pl.name} 弃掉 ${resStr(a.cards)}`, false, pl.id);
      if (Object.keys(s.discardLeft).length === 0) {
        s.phase = 'moveRobber';
        log(s, `${me.name} 移动强盗`, false, me.id);
      }
      break;
    }

    // ---------- 强盗 ----------
    case 'MOVE_ROBBER': {
      if (s.phase !== 'moveRobber') break;
      if (a.hex === s.robber) break;
      s.robber = a.hex;
      log(s, `${me.name} 把强盗移到 ${b.hexes[a.hex].number ?? '沙漠'} 号地块`, false, me.id);
      finishRobber(b, s);
      break;
    }
    case 'STEAL': {
      if (s.phase !== 'steal') break;
      if (!robberCandidates(b, s).includes(a.target)) break;
      const victim = s.players[a.target];
      const pool: Resource[] = [];
      for (const r of RESOURCES) for (let i = 0; i < victim.resources[r]; i++) pool.push(r);
      if (pool.length > 0) {
        const r = pool[Math.floor(Math.random() * pool.length)];
        victim.resources[r]--;
        me.resources[r]++;
        log(s, `${me.name} 从 ${victim.name} 偷走 1 张牌`, false, me.id);
      }
      s.phase = s.robberReturn;
      break;
    }

    // ---------- 建造 ----------
    case 'BUILD_ROAD': {
      if (s.phase !== 'main') break;
      if (!canBuildRoad(b, s, a.e, s.current)) break;
      const free = s.freeRoads > 0;
      if (!free && !canAfford(me, COSTS.road)) break;
      if (free) s.freeRoads--;
      else spend(s, s.current, COSTS.road);
      s.roads[a.e] = { owner: s.current };
      log(s, `${me.name} 修建了一条道路${free ? '（免费）' : ''}`, false, me.id);
      updateLongestRoad(b, s);
      checkVictory(s, s.current);
      break;
    }
    case 'BUILD_SETTLEMENT': {
      if (s.phase !== 'main') break;
      if (!canBuildSettlement(b, s, a.v, s.current)) break;
      if (!canAfford(me, COSTS.settlement)) break;
      spend(s, s.current, COSTS.settlement);
      s.buildings[a.v] = { type: 'settlement', owner: s.current };
      log(s, `${me.name} 建造了一座房屋`, false, me.id);
      updateLongestRoad(b, s); // 可能截断对手的路
      checkVictory(s, s.current);
      break;
    }
    case 'BUILD_CITY': {
      if (s.phase !== 'main') break;
      if (!canBuildCity(s, a.v, s.current)) break;
      if (!canAfford(me, COSTS.city)) break;
      spend(s, s.current, COSTS.city);
      s.buildings[a.v] = { type: 'city', owner: s.current };
      log(s, `${me.name} 把房屋升级为城市`, false, me.id);
      checkVictory(s, s.current);
      break;
    }
    case 'BUY_DEV': {
      if (s.phase !== 'main') break;
      if (s.devDeck.length === 0) break;
      if (!canAfford(me, COSTS.dev)) break;
      spend(s, s.current, COSTS.dev);
      const card = s.devDeck.pop()!;
      if (card === '胜利点') {
        me.vpCards++;
        log(s, `${me.name} 购买了一张发展卡`, false, me.id);
        checkVictory(s, s.current);
      } else {
        me.newDevCards.push(card);
        log(s, `${me.name} 购买了一张发展卡`, false, me.id);
      }
      break;
    }

    // ---------- 发展卡 ----------
    case 'PLAY_KNIGHT': {
      if (s.phase !== 'main' && s.phase !== 'roll') break;
      if (s.devPlayed) break;
      const i = me.devCards.indexOf('骑士');
      if (i < 0) break;
      me.devCards.splice(i, 1);
      me.knightsPlayed++;
      s.devPlayed = true;
      log(s, `${me.name} 打出骑士卡`, false, me.id);
      updateLargestArmy(s);
      checkVictory(s, s.current);
      if (s.winner !== null) break;
      s.robberReturn = s.phase; // roll 或 main
      s.phase = 'moveRobber';
      break;
    }
    case 'PLAY_ROAD_BUILDING': {
      if (s.phase !== 'main' || s.devPlayed) break;
      const i = me.devCards.indexOf('修路');
      if (i < 0) break;
      me.devCards.splice(i, 1);
      s.devPlayed = true;
      s.freeRoads += 2;
      log(s, `${me.name} 打出修路卡，可免费修建 2 条路`, false, me.id);
      break;
    }
    case 'PLAY_YEAR_OF_PLENTY': {
      if (s.phase !== 'main' || s.devPlayed) break;
      const i = me.devCards.indexOf('丰收');
      if (i < 0) break;
      me.devCards.splice(i, 1);
      s.devPlayed = true;
      for (const r of [a.r1, a.r2]) {
        if (s.bank[r] > 0) {
          s.bank[r]--;
          me.resources[r]++;
        }
      }
      log(s, `${me.name} 打出丰收卡，获得 ${RESOURCE_LABEL[a.r1]}、${RESOURCE_LABEL[a.r2]}`, false, me.id);
      break;
    }
    case 'PLAY_MONOPOLY': {
      if (s.phase !== 'main' || s.devPlayed) break;
      const i = me.devCards.indexOf('垄断');
      if (i < 0) break;
      me.devCards.splice(i, 1);
      s.devPlayed = true;
      let got = 0;
      for (const p of s.players) {
        if (p.id === s.current) continue;
        got += p.resources[a.r];
        p.resources[a.r] = 0;
      }
      me.resources[a.r] += got;
      log(s, `${me.name} 打出垄断卡，垄断 ${RESOURCE_LABEL[a.r]}，共收取 ${got} 张`, false, me.id);
      break;
    }

    // ---------- 交易 ----------
    case 'BANK_TRADE': {
      if (s.phase !== 'main') break;
      const ratio = tradeRatio(b, s, s.current, a.give);
      if (me.resources[a.give] < ratio) break;
      if (s.bank[a.receive] < 1) break;
      me.resources[a.give] -= ratio;
      s.bank[a.give] += ratio;
      me.resources[a.receive] += 1;
      s.bank[a.receive] -= 1;
      log(
        s,
        `${me.name} 与银行 ${ratio}:1 兑换：${RESOURCE_LABEL[a.give]} → ${RESOURCE_LABEL[a.receive]}`,
        false, me.id,
      );
      break;
    }
    case 'OFFER_TRADE': {
      // AI → 人类：挂起待玩家应答
      if (s.phase !== 'main') break;
      s.pendingTrade = { from: s.current, to: a.to, give: a.give, receive: a.receive };
      log(
        s,
        `${s.players[s.current].name} 向你提议交易：给你 ${resStr(a.give)}，想换 ${resStr(a.receive)}`,
        false, s.current,
      );
      break;
    }
    case 'TRADE_EXECUTE': {
      // 校验双方资源充足后执行
      const okFrom = RESOURCES.every((r) => s.players[a.from].resources[r] >= a.give[r]);
      const okTo = RESOURCES.every((r) => s.players[a.to].resources[r] >= a.receive[r]);
      if (okFrom && okTo) doTrade(s, a.from, a.to, a.give, a.receive);
      s.pendingTrade = null;
      break;
    }
    case 'RESPOND_TRADE': {
      const t = s.pendingTrade;
      if (!t) break;
      if (a.accept) {
        const okFrom = RESOURCES.every((r) => s.players[t.from].resources[r] >= t.give[r]);
        const okTo = RESOURCES.every((r) => s.players[t.to].resources[r] >= t.receive[r]);
        if (okFrom && okTo) doTrade(s, t.from, t.to, t.give, t.receive);
      } else {
        log(s, `你拒绝了 ${s.players[t.from].name} 的交易提议`, false, t.from);
      }
      s.pendingTrade = null;
      break;
    }

    // ---------- 回合结束 ----------
    case 'END_TURN': {
      if (s.phase !== 'main') break;
      endTurn(b, s);
      break;
    }
  }

  return s;
}

/** 供 UI / AI 复用：玩家最长路长度 */
export { longestRoadLength };
