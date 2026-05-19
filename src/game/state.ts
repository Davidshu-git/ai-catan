// ============================================================
// 初始游戏状态
// ============================================================

import { generateBoard } from './board';
import type { DevCard, FullGame, GameState, Player } from './types';
import { emptyRes } from './types';

const PLAYER_DEFS = [
  { name: '你', color: '#e5484d', isAI: false },
  { name: 'AI · 蓝', color: '#4aa3ff', isAI: true },
  { name: 'AI · 绿', color: '#3ecf6a', isAI: true },
  { name: 'AI · 橙', color: '#e8a13a', isAI: true },
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
    ...Array<DevCard>(14).fill('knight'),
    ...Array<DevCard>(5).fill('victory'),
    ...Array<DevCard>(2).fill('roadBuilding'),
    ...Array<DevCard>(2).fill('yearOfPlenty'),
    ...Array<DevCard>(2).fill('monopoly'),
  ]);
}

export function createGame(): FullGame {
  const board = generateBoard();
  const desert = board.hexes.find((h) => h.terrain === 'desert')!;

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
    bank: { wood: 19, brick: 19, sheep: 19, wheat: 19, ore: 19 },
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
