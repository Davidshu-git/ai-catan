// ============================================================
// 社交聊天调度冒烟：默认关→无发言；开→预算内发言、超每回合/整局上限即停、
// 运行中熄火即止。注入模板生成器，不烧 token、不经游戏循环。
// 运行：docker run --rm -v "$PWD":/app -w /app node:20-alpine npx --yes tsx server/social/socialChatSmoke.ts
// ============================================================

import { createGame } from '../../shared/state';
import type { GameState } from '../../shared/types';
import { createRelationshipLedger, type RelationshipEvent } from './relationshipLedger';
import {
  SOCIAL_LIMITS,
  createSocialBudget,
  maybeRunSocialChat,
  type SocialLineFn,
} from './socialChat';

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failures++;
}

function makeState(turn: number): GameState {
  const { state } = createGame();
  state.players.forEach((p) => (p.isAI = true));
  state.turn = turn;
  state.phase = 'main';
  return state;
}

// near-win 事件：主角 actor，其余三家是潜在 speaker
function nearWinEvent(actor: number): RelationshipEvent {
  return {
    type: 'near-win',
    actor,
    actorName: `P${actor}`,
    affected: [0, 1, 2, 3].filter((p) => p !== actor),
    note: `P${actor}已8分逼近胜利`,
  };
}

const genLine: SocialLineFn = async () => ({ kind: 'chat', message: '场面话', provider: 'template' });
const allTrue = () => true;

async function run() {
  const ledger = createRelationshipLedger(makeState(5));

  // A) 关闭 → 0 发言
  {
    const emitted: number[] = [];
    await maybeRunSocialChat(makeState(5), ledger, [nearWinEvent(3)], createSocialBudget(), genLine, () => undefined, () => false, () => emitted.push(1));
    check('A 关闭时无任何社交发言', emitted.length === 0);
  }

  // B) 开启 + 单事件 → 恰 1 条，预算正确累加
  {
    const emitted: unknown[] = [];
    const budget = createSocialBudget();
    await maybeRunSocialChat(makeState(5), ledger, [nearWinEvent(3)], budget, genLine, () => undefined, allTrue, (e) => emitted.push(e));
    check('B 单事件发 1 条', emitted.length === 1);
    check('B 预算 linesThisTurn=1', budget.linesThisTurn === 1);
    check('B 预算 linesThisGame=1', budget.linesThisGame === 1);
  }

  // C) 每回合上限：同一回合喂多个事件，发言数 ≤ linesPerTurn
  {
    const emitted: unknown[] = [];
    const budget = createSocialBudget();
    const events = [nearWinEvent(3), nearWinEvent(0), nearWinEvent(1), nearWinEvent(2)];
    await maybeRunSocialChat(makeState(5), ledger, events, budget, genLine, () => undefined, allTrue, (e) => emitted.push(e));
    check(`C 每回合上限封顶（${emitted.length} ≤ ${SOCIAL_LIMITS.linesPerTurn}）`, emitted.length <= SOCIAL_LIMITS.linesPerTurn);
    check('C 同一 agent 不在同回合连说（冷却）', emitted.length === new Set((emitted as Array<{ player: number }>).map((e) => e.player)).size);
  }

  // D) 整局上限：预算已达 linesPerGame → 不再发言
  {
    const emitted: unknown[] = [];
    const budget = createSocialBudget();
    budget.linesThisGame = SOCIAL_LIMITS.linesPerGame;
    await maybeRunSocialChat(makeState(5), ledger, [nearWinEvent(3)], budget, genLine, () => undefined, allTrue, (e) => emitted.push(e));
    check('D 整局上限到顶后不再发言', emitted.length === 0);
  }

  // E) 运行中熄火：第一条后 isEnabled 翻 false → 不超过 1 条
  {
    const emitted: unknown[] = [];
    let calls = 0;
    const flip = () => {
      calls++;
      return calls <= 2; // 头两次查（首次入口 + 第一条前）为真，之后熄火
    };
    const events = [nearWinEvent(3), nearWinEvent(0), nearWinEvent(1)];
    await maybeRunSocialChat(makeState(5), ledger, events, createSocialBudget(), genLine, () => undefined, flip, (e) => emitted.push(e));
    check('E 运行中熄火即止（≤1 条）', emitted.length <= 1);
  }

  console.log(failures === 0 ? '\n✅ 社交聊天冒烟全部通过' : `\n❌ ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
