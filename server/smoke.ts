// 端到端冒烟脚本：连后端 socket，确认能收到 sync_state；
// SMOKE_DRIVE=1 时开启 AI 自动推进，并驱动 P0 人类完成首手 setup1，观察后续 AI 的 ai_thought 流。
//
// 用法（容器内，需 stack 在跑）：
//   # 基本：连接 + sync_state + new_game 通畅性
//   docker run --rm --network catan_default -v "$PWD":/app -w /app node:20-alpine \
//     sh -c "npm install --silent && npx tsx server/smoke.ts http://catan-server:3001"
//
//   # 进阶：代 P0 走两步，看 P1(AI) 通过 server 真实推理
//   docker run --rm --network catan_default -e SMOKE_DRIVE=1 -v "$PWD":/app -w /app node:20-alpine \
//     sh -c "npm install --silent && npx tsx server/smoke.ts http://catan-server:3001"

import { io } from 'socket.io-client';
import { canPlaceRoadSetup, canPlaceSettlementFree } from '../shared/rules';
import type { FullGame } from '../shared/types';

const url = process.argv[2] ?? 'http://localhost:3001';
const DRIVE = process.env.SMOKE_DRIVE === '1';
const REQUIRED_THOUGHTS = Number(process.env.SMOKE_THOUGHTS ?? 1);
const socket = io(url, { path: '/socket.io/', transports: ['websocket'] });

let syncCount = 0;
let thoughtCount = 0;
let errorCount = 0;
let driven = false;
let firstGame: FullGame | null = null;
let readyToDrive = !DRIVE;
let newGameSent = false;
let countThoughts = !DRIVE;

const HARD_TIMEOUT = DRIVE ? 120_000 : 12_000; // LLM 慢，给宽点
const timer = setTimeout(() => {
  console.error(
    `❌ ${HARD_TIMEOUT}ms 内未达预期（sync=${syncCount} thought=${thoughtCount} err=${errorCount}）`,
  );
  process.exit(1);
}, HARD_TIMEOUT);

socket.on('connect', () => {
  console.log(`✅ 已连接 ${url}（sid=${socket.id}）`);
});

socket.on('sync_state', (g: FullGame) => {
  syncCount++;
  if (syncCount <= 2 || syncCount % 5 === 0) {
    console.log(
      `📦 sync_state #${syncCount}: phase=${g.state.phase} current=${g.state.current} turn=${g.state.turn} setup=${g.state.setupIndex}/${g.state.setupOrder.length} step=${g.state.setupStep}`,
    );
  }
  if (!firstGame) firstGame = g;
  if (DRIVE && newGameSent && g.state.turn === 0 && g.state.phase === 'setup1') {
    countThoughts = true;
  }

  // SMOKE_DRIVE=1：若当前仍是人类席位，则代走首手；4 AI 观察局则让服务端自动推进。
  const currentIsHuman = g.state.players[g.state.current]?.isAI === false;
  if (DRIVE && readyToDrive && currentIsHuman && !driven && g.state.phase === 'setup1' && g.state.current === 0 && g.state.setupStep === 'settlement') {
    const v = g.board.vertices.find((vv) => canPlaceSettlementFree(g.board, g.state, vv.id));
    if (v) {
      console.log(`→ 代 P0 放定居点 v${v.id}`);
      socket.emit('dispatch', { type: 'PLACE_SETTLEMENT', v: v.id });
    }
  }
  if (DRIVE && readyToDrive && currentIsHuman && g.state.phase === 'setup1' && g.state.current === 0 && g.state.setupStep === 'road') {
    const e = g.board.edges.find((ee) => canPlaceRoadSetup(g.board, g.state, ee.id));
    if (e) {
      console.log(`→ 代 P0 放道路 e${e.id}`);
      socket.emit('dispatch', { type: 'PLACE_ROAD', e: e.id });
      driven = true;
    }
  }
});

socket.on('ai_thought', (ev) => {
  if (!countThoughts) return;
  thoughtCount++;
  console.log(
    `🧠 ai_thought #${thoughtCount} p${ev.player}/${ev.phase}/${ev.provider}\n   thought: ${ev.thought}\n   → ${ev.actionSummary}`,
  );
  if (thoughtCount >= REQUIRED_THOUGHTS || (!DRIVE && thoughtCount >= 1)) {
    console.log(`✅ 收到 ${thoughtCount} 条 ai_thought，LLM 链路通`);
    clearTimeout(timer);
    socket.disconnect();
    process.exit(0);
  }
});

socket.on('ai_error', (ev) => {
  errorCount++;
  console.warn(`⚠️  ai_error p${ev.player}/${ev.provider}: ${ev.message}`);
});

socket.on('ai_control_state', (ev) => {
  if (DRIVE) {
    console.log(
      `🎛️  ai_control autoplay=${ev.autoplay} queued=${ev.queued} busy=${ev.busy} canStep=${ev.canStep}`,
    );
  }
});

setTimeout(() => {
  if (DRIVE) {
    console.log('→ 开启 AI 自动推进，发送 new_game，准备代 P0 走首手');
    socket.emit('set_ai_autoplay', { autoplay: true });
    newGameSent = true;
    socket.emit('new_game');
    driven = false;
    readyToDrive = true;
  } else {
    console.log('→ 发送 new_game（基础冒烟，无代驱）');
    socket.emit('new_game');
  }
}, 500);

// 如果没在 timeout 之前收到 thoughtCount 阈值，也走收尾：基础冒烟阶段不强求 thought
if (!DRIVE) {
  setTimeout(() => {
    console.log(`ℹ️  收尾：sync=${syncCount} thought=${thoughtCount}（默认手动，不自动推进 AI）`);
    clearTimeout(timer);
    socket.disconnect();
    process.exit(0);
  }, 8000);
}

socket.on('connect_error', (err) => {
  console.error(`❌ 连接失败: ${err.message}`);
  clearTimeout(timer);
  process.exit(1);
});
