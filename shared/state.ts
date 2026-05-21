// ============================================================
// 初始游戏状态
// ============================================================

import { generateBoard } from './board';
import type { DevCard, FullGame, GameState, Player } from './types';
import { emptyRes } from './types';

// 玩家配色：这是游戏状态的一部分（每个 Player 自带 color 字段），
// 因此放在 shared 层；前端 art/theme.ts 直接从这里 re-export，避免双写。
export const PLAYER_ART_COLORS = ['#a83836', '#3e668f', '#526b3b', '#a06a32'];

const PLAYER_DEFS = [
  { name: '你', color: PLAYER_ART_COLORS[0], isAI: false },
  { name: '', color: PLAYER_ART_COLORS[1], isAI: true },
  { name: '', color: PLAYER_ART_COLORS[2], isAI: true },
  { name: '', color: PLAYER_ART_COLORS[3], isAI: true },
];

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeDevDeck(): DevCard[] {
  return shuffle([
    ...Array<DevCard>(14).fill('骑士'),
    ...Array<DevCard>(5).fill('胜利点'),
    ...Array<DevCard>(2).fill('修路'),
    ...Array<DevCard>(2).fill('丰收'),
    ...Array<DevCard>(2).fill('垄断'),
  ]);
}

export function createGame(): FullGame {
  const board = generateBoard();
  const desert = board.hexes.find((h) => h.terrain === '沙漠')!;

  const players: Player[] = PLAYER_DEFS.map((d, i) => ({
    id: i,
    name: d.name,
    color: d.color,
    isAI: d.isAI,
    resources: emptyRes(),
    devCards: [],
    newDevCards: [],
    knightsPlayed: 0,
    vpCards: 0,
  }));

  // setup 顺序：正序一轮 + 逆序一轮
  const order = [...players.map((p) => p.id)];
  const setupOrder = [...order, ...order.slice().reverse()];

  const state: GameState = {
    players,
    current: setupOrder[0],
    phase: 'setup1',
    setupStep: 'settlement',
    setupOrder,
    setupIndex: 0,
    lastSettlement: null,
    dice: null,
    buildings: {},
    roads: {},
    robber: desert.id,
    bank: { 木: 19, 砖: 19, 羊: 19, 麦: 19, 矿: 19 },
    devDeck: makeDevDeck(),
    longestRoad: { player: null, len: 0 },
    largestArmy: { player: null, size: 0 },
    turn: 0,
    devPlayed: false,
    freeRoads: 0,
    robberReturn: 'main',
    discardLeft: {},
    pendingTrade: null,
    log: [{ text: '游戏开始！请按蛇形顺序放置初始的房屋与道路。' }],
    winner: null,
  };

  return { board, state };
}
