// 持久化冒烟：写快照 → 读快照 → 重建 agent 编排态 → 校验资源守恒。
// 运行：docker run --rm -v "$PWD":/app -w /app node:20-alpine npx --yes tsx server/persistSmoke.ts

import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createGame } from '../shared/state';
import { RESOURCES, type GameState } from '../shared/types';
import { createAgentRuntimes } from './agents/types';
import { buildSnapshot, loadSnapshot, saveSnapshot, type AgentSnapshot } from './persist';
import { createRelationshipLedger } from './social/relationshipLedger';

function check(label: string, cond: unknown): asserts cond {
  if (!cond) {
    console.error(`❌ ${label}`);
    process.exit(1);
  }
  console.log(`✅ ${label}`);
}

function resourceTotal(state: GameState, resource: (typeof RESOURCES)[number]): number {
  return (
    state.bank[resource] +
    state.players.reduce((sum, player) => sum + player.resources[resource], 0)
  );
}

function applyAgentSnapshot(
  agents: ReturnType<typeof createAgentRuntimes>,
  saved: Record<number, AgentSnapshot>,
) {
  for (const [idText, snap] of Object.entries(saved)) {
    const agent = agents[Number(idText)];
    if (!agent) continue;
    agent.providerName = snap.providerName;
    agent.memory = [...snap.memory];
    agent.decisionCount = snap.decisionCount;
    agent.currentTurnGoal = snap.currentTurnGoal;
    agent.stance = snap.stance;
  }
}

const tmp = path.join(os.tmpdir(), `catan-persist-smoke-${process.pid}`);
process.env.PERSIST = '1';
process.env.PERSIST_DIR = tmp;

const game = createGame();
for (const player of game.state.players) {
  player.isAI = true;
}
game.state.turn = 9;
game.state.current = 2;
game.state.log.push({ text: '持久化冒烟写入标记' });

const agents = createAgentRuntimes(game.state, 'mock');
agents[2].memory.push('第 1 次决策｜main｜冒烟｜保留记忆');
agents[2].decisionCount = 1;
agents[2].providerName = 'qwen36';
agents[2].currentTurnGoal = '冒烟续盘';
agents[2].stance = '经济扩张';

const source = {
  version: 17,
  game,
  relationships: createRelationshipLedger(game.state),
  agents,
  aiProvider: 'mock',
  aiHint: true,
  aiAutoplay: false,
  socialChatEnabled: false,
  aiEvents: [],
  tradeEvents: [],
  socialEvents: [],
};

await saveSnapshot('default', source);
const loaded = loadSnapshot('default');
check('能读回快照', loaded != null);
check('schema/version 正确', loaded.schemaVersion === 1 && loaded.version === source.version);
check('权威态 gameId 保持一致', loaded.game.state.gameId === game.state.gameId);
check('权威态 turn/current 保持一致', loaded.game.state.turn === 9 && loaded.game.state.current === 2);

const rebuiltAgents = createAgentRuntimes(loaded.game.state, loaded.flags.aiProvider);
applyAgentSnapshot(rebuiltAgents, loaded.agents);
check('agent provider/记忆恢复', rebuiltAgents[2].providerName === 'qwen36' && rebuiltAgents[2].memory.length === 1);
check('agent 意图恢复', rebuiltAgents[2].currentTurnGoal === '冒烟续盘' && rebuiltAgents[2].stance === '经济扩张');

for (const resource of RESOURCES) {
  check(`${resource} 资源总数恒为 19`, resourceTotal(loaded.game.state, resource) === 19);
}

const roundtrip = buildSnapshot('default', source);
check('buildSnapshot 保留 buffers 结构', Array.isArray(roundtrip.buffers?.ai));

await rm(tmp, { recursive: true, force: true });
console.log('persistSmoke 完成');
