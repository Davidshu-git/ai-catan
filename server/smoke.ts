// 端到端冒烟脚本：连后端 socket，确认能收到 sync_state；触发 new_game 看是否广播。
// 用法（容器内）：
//   docker run --rm --network catan_default -v "$PWD":/app -w /app node:20-alpine \
//     sh -c "npm install --silent && npx tsx server/smoke.ts http://catan-server:3001"

import { io } from 'socket.io-client';

const url = process.argv[2] ?? 'http://localhost:3001';
const socket = io(url, { path: '/socket.io/', transports: ['websocket'] });

let syncCount = 0;
const TIMEOUT_MS = 8000;
const timer = setTimeout(() => {
  console.error(`❌ ${TIMEOUT_MS}ms 内未完成预期事件（syncCount=${syncCount}）`);
  process.exit(1);
}, TIMEOUT_MS);

socket.on('connect', () => {
  console.log(`✅ 已连接 ${url}（sid=${socket.id}）`);
});

socket.on('sync_state', (g) => {
  syncCount++;
  console.log(
    `📦 sync_state #${syncCount}: phase=${g.state.phase} current=${g.state.current} turn=${g.state.turn} players=${g.state.players.length}`,
  );
  if (syncCount === 1) {
    // 收到初始状态后触发 new_game，应该再收到一次 sync_state
    console.log('→ 发送 new_game');
    socket.emit('new_game');
  } else if (syncCount === 2) {
    console.log('✅ new_game 广播收到，链路通畅');
    clearTimeout(timer);
    socket.disconnect();
    process.exit(0);
  }
});

socket.on('connect_error', (err) => {
  console.error(`❌ 连接失败: ${err.message}`);
  clearTimeout(timer);
  process.exit(1);
});
