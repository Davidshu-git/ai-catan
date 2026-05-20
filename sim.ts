// 无头自动对局压测：4 个 AI 互相对战，逐步校验不变量，用于发现 bug
// 运行：docker run --rm -v "$PWD":/app -w /app node:20-alpine npx --yes tsx sim.ts

import { createGame } from './shared/state';
import { reduce } from './shared/reducer';
import { aiNextAction } from './shared/ai';
import { totalVP } from './shared/rules';
import { RESOURCES } from './shared/types';

const GAMES = 60;
const MAX_STEPS = 20000;

let failures = 0;
const turnsPerGame: number[] = [];
const winners: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
let noWinner = 0;

function check(cond: boolean, msg: string, gi: number, step: number): boolean {
  if (!cond) {
    failures++;
    console.log(`❌ [game ${gi} step ${step}] ${msg}`);
    return false;
  }
  return true;
}

for (let gi = 0; gi < GAMES; gi++) {
  const g = createGame();
  g.state.players.forEach((p) => (p.isAI = true)); // 全 AI 驱动

  let board = g.board;
  let state = g.state;
  let step = 0;
  let lastSig = '';
  let sigRepeat = 0;
  let broke = false;

  while (state.phase !== 'gameOver' && step < MAX_STEPS) {
    const action = aiNextAction(board, state);
    if (!action) {
      check(false, `aiNextAction 返回 null 但未结束（phase=${state.phase}, cur=${state.current}）`, gi, step);
      broke = true;
      break;
    }

    let next;
    try {
      next = reduce(board, state, action);
    } catch (e) {
      check(false, `reduce 抛异常 action=${action.type}: ${(e as Error).message}`, gi, step);
      broke = true;
      break;
    }

    // 不变量校验
    for (const r of RESOURCES) {
      let total = next.bank[r];
      if (!check(next.bank[r] >= 0, `银行 ${r} 为负: ${next.bank[r]}`, gi, step)) broke = true;
      for (const p of next.players) {
        if (!check(p.resources[r] >= 0, `玩家${p.id} ${r} 为负: ${p.resources[r]}`, gi, step))
          broke = true;
        total += p.resources[r];
      }
      if (!check(total === 19, `资源 ${r} 不守恒: 总量=${total}（应为19）`, gi, step)) broke = true;
    }
    for (const p of next.players) {
      if (!check(totalVP(next, p.id) <= 13, `玩家${p.id} 分数异常: ${totalVP(next, p.id)}`, gi, step))
        broke = true;
    }
    if (broke) break;

    // 死循环检测：状态指纹长时间不变
    const sig = `${next.turn}|${next.phase}|${next.current}|${
      Object.keys(next.buildings).length
    }|${Object.keys(next.roads).length}|${next.players
      .map((p) => RESOURCES.reduce((t, r) => t + p.resources[r], 0))
      .join(',')}|${next.devDeck.length}`;
    if (sig === lastSig) {
      if (++sigRepeat > 600) {
        check(false, `疑似死循环：状态 600 步未变化（phase=${next.phase}）`, gi, step);
        broke = true;
        break;
      }
    } else {
      sigRepeat = 0;
      lastSig = sig;
    }

    state = next;
    board = g.board;
    step++;
  }

  if (broke) continue;

  if (state.phase === 'gameOver' && state.winner != null) {
    winners[state.winner]++;
    turnsPerGame.push(state.turn);
  } else {
    noWinner++;
    console.log(`⚠️  [game ${gi}] ${MAX_STEPS} 步内无人获胜（turn=${state.turn}）`);
  }
}

const avg = turnsPerGame.length
  ? (turnsPerGame.reduce((a, b) => a + b, 0) / turnsPerGame.length).toFixed(1)
  : 'N/A';

console.log('\n================ 压测结果 ================');
console.log(`对局数: ${GAMES}`);
console.log(`正常结束(有胜者): ${turnsPerGame.length}  |  无胜者: ${noWinner}`);
console.log(`不变量/异常失败计数: ${failures}`);
console.log(`平均回合数: ${avg}`);
console.log(`胜者分布: P0=${winners[0]} P1=${winners[1]} P2=${winners[2]} P3=${winners[3]}`);
console.log(failures === 0 && noWinner === 0 ? '✅ 全部通过' : '⚠️  存在问题，见上方日志');

process.exit(failures === 0 ? 0 : 1);
