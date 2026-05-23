// ============================================================
// 关系账本冒烟：直接驱动 relationshipLedger 的确定性更新，断言结果。
// sim.ts 只跑 shared/ 内核、不经 server，所以触不到账本；这里补上。
// 运行：docker run --rm -v "$PWD":/app -w /app node:20-alpine npx --yes tsx server/social/ledgerSmoke.ts
// ============================================================

import { createGame } from '../../shared/state';
import type { GameState, ResMap } from '../../shared/types';
import {
  applyTradeOutcome,
  applyTransition,
  createRelationshipLedger,
  describeRelationships,
} from './relationshipLedger';

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failures++;
}

function res(partial: Partial<ResMap>): ResMap {
  return { 木: 0, 砖: 0, 羊: 0, 麦: 0, 矿: 0, ...partial };
}

const { board, state } = createGame();
const ledger = createRelationshipLedger(state);

// --- 1) 成交：双方互信 + ---
applyTradeOutcome(ledger, state, 0, 1, res({ 麦: 1 }), res({ 矿: 1 }));
check('成交后 P0→P1 信任 > 0', ledger[0][1].trust > 0);
check('成交后 P1→P0 信任 > 0', ledger[1][0].trust > 0);
check('成交写入 recent', ledger[0][1].recent.length === 1);

// 多次公平成交应跨过"可结盟"阈值（trust>=12）
applyTradeOutcome(ledger, state, 0, 1, res({ 羊: 1 }), res({ 砖: 1 }));
const view01 = describeRelationships(ledger, 0, state);
check('P0 看法里出现"可结盟"P1', view01.includes('可结盟'));
console.log(`   P0 看法：${view01}`);

// --- 2) 强盗砸到 P2 家门口：P2 对操作者 P3 信任↓、警惕↑ ---
// 找一个有 P2 建筑的地块；没有则手动放一个，再把强盗移过去。
const targetHex = board.hexes[0];
const corner = targetHex.corners[0];
const prev: GameState = structuredClone(state);
const next: GameState = structuredClone(state);
prev.current = 3; // 操作强盗的是 P3
next.current = 3;
next.buildings[corner] = { type: 'settlement', owner: 2 };
prev.buildings[corner] = { type: 'settlement', owner: 2 };
prev.robber = board.hexes.length - 1; // 强盗原本在别处
next.robber = targetHex.id; // 移到 P2 门口

applyTransition(ledger, board, prev, next);
check('强盗后 P2→P3 信任 < 0', ledger[2][3].trust < 0);
check('强盗后 P2→P3 警惕 > 0', ledger[2][3].threat > 0);
const view2 = describeRelationships(ledger, 2, state);
check('P2 看法里对 P3 有负面标签', /信任很低|有嫌隙|提防/.test(view2));
console.log(`   P2 看法：${view2}`);

// --- 3) 最长路易主：全场对新持有者 P1 警惕↑ ---
const prevLR: GameState = structuredClone(state);
const nextLR: GameState = structuredClone(state);
prevLR.longestRoad = { player: null, len: 0 };
nextLR.longestRoad = { player: 1, len: 5 };
const beforeThreat = ledger[0][1].threat;
applyTransition(ledger, board, prevLR, nextLR);
check('最长路易主后 P0→P1 警惕上升', ledger[0][1].threat > beforeThreat);
check('最长路易主后 P3→P1 警惕上升', ledger[3][1].threat > 0);

// --- 4) 中立关系不写进 prompt（避免噪声）---
const fresh = createRelationshipLedger(state);
check('全中立时 describe 返回空串', describeRelationships(fresh, 0, state) === '');

console.log(failures === 0 ? '\n✅ 关系账本冒烟全部通过' : `\n❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
