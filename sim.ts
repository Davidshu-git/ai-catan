// 无头自动对局压测：4 个 AI 互相对战，逐步校验不变量，用于发现 bug
// 运行（容器内）：
//   AI_PROVIDER=rule  docker run --rm -v "$PWD":/app -w /app node:20-alpine npx --yes tsx sim.ts
//   AI_PROVIDER=mock  docker run --rm -v "$PWD":/app -w /app node:20-alpine npx --yes tsx sim.ts
// 默认 rule。所有 Provider 都走 server/llm/controller 的完整链路
// （catalog + view + checker），借此回归"LLM 链路不破坏不变量"。

import { createGame } from './shared/state';
import { totalVP } from './shared/rules';
import { RESOURCES } from './shared/types';
import type { AiDecisionProvider } from './server/llm/types';
import { decideAiStep } from './server/llm/controller';
import { createRuleProvider } from './server/llm/ruleProvider';
import { createMockProvider } from './server/llm/mockProvider';

const GAMES = Number(process.env.SIM_GAMES ?? 60);
const MAX_STEPS = Number(process.env.SIM_MAX_STEPS ?? 20000);
const PROVIDER_NAME = (process.env.AI_PROVIDER ?? 'rule').toLowerCase();

function makeProvider(board: ReturnType<typeof createGame>['board'], state: ReturnType<typeof createGame>['state']): AiDecisionProvider {
  if (PROVIDER_NAME === 'mock') return createMockProvider();
  if (PROVIDER_NAME === 'rule') return createRuleProvider(board, state);
  // 其他名字（llm 等）—— 当前没接，退到 rule，给出警告
  console.warn(`未知 AI_PROVIDER="${PROVIDER_NAME}"，回退到 rule`);
  return createRuleProvider(board, state);
}

let failures = 0;
const turnsPerGame: number[] = [];
const winners: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
let noWinner = 0;
let forcedEndTurns = 0;
let aiErrors = 0;

function check(cond: boolean, msg: string, gi: number, step: number): boolean {
  if (!cond) {
    failures++;
    console.log(`❌ [game ${gi} step ${step}] ${msg}`);
    return false;
  }
  return true;
}

async function runOneGame(gi: number) {
  const g = createGame();
  g.state.players.forEach((p) => (p.isAI = true)); // 全 AI 驱动

  let board = g.board;
  let state = g.state;
  let step = 0;
  let lastSig = '';
  let sigRepeat = 0;
  let broke = false;

  while (state.phase !== 'gameOver' && step < MAX_STEPS) {
    const provider = makeProvider(board, state);
    const outcome = await decideAiStep(board, state, provider);

    if (outcome.kind === 'human-turn') {
      check(false, `controller 返回 human-turn 但全 AI 局面（phase=${state.phase}, cur=${state.current}）`, gi, step);
      broke = true;
      break;
    }
    if (outcome.kind === 'game-over') break;

    if (outcome.kind === 'forced-end-turn') forcedEndTurns++;
    aiErrors += outcome.errors.length;

    const next = outcome.nextState;

    // 资源守恒 / 非负 / VP 上限不变量
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

  if (broke) return;

  if (state.phase === 'gameOver' && state.winner != null) {
    winners[state.winner]++;
    turnsPerGame.push(state.turn);
  } else {
    noWinner++;
    console.log(`⚠️  [game ${gi}] ${MAX_STEPS} 步内无人获胜（turn=${state.turn}）`);
  }
}

async function main() {
  console.log(`========== 压测启动 ==========`);
  console.log(`Provider: ${PROVIDER_NAME}   Games: ${GAMES}   MaxSteps: ${MAX_STEPS}`);
  for (let gi = 0; gi < GAMES; gi++) {
    await runOneGame(gi);
  }

  const avg = turnsPerGame.length
    ? (turnsPerGame.reduce((a, b) => a + b, 0) / turnsPerGame.length).toFixed(1)
    : 'N/A';

  console.log('\n================ 压测结果 ================');
  console.log(`Provider: ${PROVIDER_NAME}`);
  console.log(`对局数: ${GAMES}`);
  console.log(`正常结束(有胜者): ${turnsPerGame.length}  |  无胜者: ${noWinner}`);
  console.log(`不变量/异常失败计数: ${failures}`);
  console.log(`平均回合数: ${avg}`);
  console.log(`胜者分布: P0=${winners[0]} P1=${winners[1]} P2=${winners[2]} P3=${winners[3]}`);
  console.log(`AI 错误总数（Provider+checker 失败次数）: ${aiErrors}`);
  console.log(`强制 END_TURN 次数: ${forcedEndTurns}`);
  console.log(failures === 0 && noWinner === 0 ? '✅ 全部通过' : '⚠️  存在问题，见上方日志');

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('sim crashed:', err);
  process.exit(2);
});
