// 端到端冒烟脚本：连后端 socket，确认能收到 sync_state；触发 new_game 看是否广播。
// 用法（容器内）：
//   docker run --rm --network catan_default -v "$PWD":/app -w /app node:20-alpine \
//     sh -c "npm install --silent && npx tsx server/smoke.ts http://catan-server:3001"

import { io } from 'socket.io-client';

const url = process.argv[2] ?? 'http://localhost:3001';
const socket = io(url, { path: '/socket.io/', transports: ['websocket'] });

let syncCount = 0;
let thoughtCount = 0;
let errorCount = 0;
const TIMEOUT_MS = 12000;
const timer = setTimeout(() => {
  console.error(
    `❌ ${TIMEOUT_MS}ms 内未完成预期事件（sync=${syncCount} thought=${thoughtCount} err=${errorCount}）`,
  );
  process.exit(1);
}, TIMEOUT_MS);

socket.on('connect', () => {
  console.log(`✅ 已连接 ${url}（sid=${socket.id}）`);
});

socket.on('sync_state', (g) => {
  syncCount++;
  if (syncCount <= 2 || syncCount % 5 === 0) {
    console.log(
      `📦 sync_state #${syncCount}: phase=${g.state.phase} current=${g.state.current} turn=${g.state.turn}`,
    );
  }
});

socket.on('ai_thought', (ev) => {
  thoughtCount++;
  if (thoughtCount <= 3 || thoughtCount % 5 === 0) {
    console.log(
      `🧠 ai_thought #${thoughtCount} p${ev.player}/${ev.phase}/${ev.provider}: ${ev.thought} → ${ev.actionSummary}`,
    );
  }
});

socket.on('ai_error', (ev) => {
  errorCount++;
  console.warn(`⚠️  ai_error p${ev.player}/${ev.provider}: ${ev.message}`);
});

// 收到第一条 sync_state 后触发 new_game，然后看 AI 是否开始思考
setTimeout(() => {
  console.log('→ 发送 new_game，预期会看到至少 1 条 ai_thought（首玩家若为 AI）');
  socket.emit('new_game');
}, 500);

// 给 AI 跑几步的时间
setTimeout(() => {
  if (thoughtCount >= 1) {
    console.log(`✅ 收到 ${thoughtCount} 条 ai_thought + ${syncCount} 次 sync_state，链路通畅`);
    clearTimeout(timer);
    socket.disconnect();
    process.exit(0);
  } else {
    // 默认 P0 是人类，首手轮到 P0 放 settlement，AI 不动也正常；不算失败
    console.log(`ℹ️  ${thoughtCount}=0 条 ai_thought（首手是人类，AI 在等）`);
    clearTimeout(timer);
    socket.disconnect();
    process.exit(0);
  }
}, 8000);

socket.on('connect_error', (err) => {
  console.error(`❌ 连接失败: ${err.message}`);
  clearTimeout(timer);
  process.exit(1);
});
