// 一次性调 MiniMax 验证 LLM Provider 链路。
// 用法（容器内、网络外，因为 MiniMax 是公网端点）：
//   docker run --rm --env-file .env -v "$PWD":/app -w /app node:20-alpine \
//     sh -c "npm install --no-fund --no-audit --silent && npx tsx server/llmSmoke.ts"

import { createLlmProvider } from './llm/llmProvider';
import type { LegalAction, LlmDecisionInput } from './llm/types';
import type { PlayerView } from './llm/stateTranslator';
import { COSTS } from '../shared/types';

const apiKey = process.env.MINIMAX_API_KEY;
if (!apiKey) {
  console.error('❌ 缺 MINIMAX_API_KEY（请确认 .env / 容器 --env-file）');
  process.exit(1);
}

const provider = createLlmProvider({ apiKey });

// 伪造一个 main 阶段的最小 view + 3 个 legalActions
const view: PlayerView = {
  phase: 'main',
  turn: 5,
  current: 1,
  dice: [3, 4],
  me: 1,
  self: {
    id: 1,
    name: '蓝',
    resources: { 木: 1, 砖: 1, 羊: 0, 麦: 2, 矿: 3 },
    handSize: 7,
    discardOnSeven: 0,
    devCards: [],
    newDevCards: [],
    knightsPlayed: 0,
    vpCards: 0,
    publicVP: 2,
    totalVP: 2,
    tradeRatio: { 木: 4, 砖: 4, 羊: 4, 麦: 4, 矿: 4 },
  },
  others: [],
  bank: { 木: 18, 砖: 18, 羊: 19, 麦: 17, 矿: 16 },
  robber: 9,
  hexes: [],
  ports: [],
  myBuildings: {
    settlements: [10, 22],
    cities: [],
    roads: [3, 5],
    settlementSummaries: ['v10→麦8(5产出点) 矿6(5产出点)', 'v22→木3(2产出点)'],
    citySummaries: [],
    roadSummaries: ['e3: v10[麦8,矿6]↔v11[麦8]', 'e5: v22[木3]↔v23[木3,砖4]'],
  },
  costs: {
    road: { ...COSTS.road },
    settlement: { ...COSTS.settlement },
    city: { ...COSTS.city },
    dev: { ...COSTS.dev },
  },
  recentLog: ['你的回合开始', '你掷出 7 → 已结算'],
  pendingTradeForMe: null,
};

const legalActions: LegalAction[] = [
  {
    id: 'build-city-v10',
    label: '升级城市在顶点 v10',
    action: { type: 'BUILD_CITY', v: 10 },
  },
  {
    id: 'buy-dev',
    label: '购买发展卡',
    action: { type: 'BUY_DEV' },
  },
  {
    id: 'end-turn',
    label: '结束回合',
    action: { type: 'END_TURN' },
  },
];

async function main() {
  const input: LlmDecisionInput = { view, legalActions };
  const t0 = Date.now();
  try {
    const out = await provider.decide(input);
    const dt = Date.now() - t0;
    console.log(`✅ ${dt}ms`);
    console.log(`thought:  ${out.thought}`);
    console.log(`actionId: ${out.actionId}`);
    // actionId 必须命中我们给的三个之一
    const ok = legalActions.some((a) => a.id === out.actionId);
    console.log(`actionId 是否合法: ${ok ? '✅' : '❌'}`);
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.error(`❌ ${Date.now() - t0}ms`, err);
    process.exit(1);
  }
}

main();
