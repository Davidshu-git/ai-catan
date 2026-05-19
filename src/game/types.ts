// ============================================================
// 卡坦岛 类型定义
// ============================================================

export type Resource = 'wood' | 'brick' | 'sheep' | 'wheat' | 'ore';
export const RESOURCES: Resource[] = ['wood', 'brick', 'sheep', 'wheat', 'ore'];

export type Terrain = Resource | 'desert';

export type DevCard = 'knight' | 'victory' | 'roadBuilding' | 'yearOfPlenty' | 'monopoly';

/** 港口类型：某资源 2:1，或 'any' 表示通用 3:1 */
export type Port = Resource | 'any';

export type ResMap = Record<Resource, number>;

export function emptyRes(): ResMap {
  return { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
}

// ---- 静态棋盘（生成后不再变化） ----

export interface Hex {
  id: number;
  q: number;
  r: number;
  terrain: Terrain;
  /** 沙漠为 null */
  number: number | null;
  cx: number;
  cy: number;
  /** 6 个角点顶点 id（按角索引顺序） */
  corners: number[];
  /** 6 个角点的像素坐标，用于绘制多边形 */
  poly: { x: number; y: number }[];
}

export interface VertexGeo {
  id: number;
  x: number;
  y: number;
  /** 相邻的地块 id（1~3 个） */
  hexes: number[];
  /** 通过一条边直接相连的顶点 id */
  neighbors: number[];
  /** 该顶点所属港口（无则 null） */
  port: Port | null;
}

export interface EdgeGeo {
  id: number;
  v1: number;
  v2: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Board {
  hexes: Hex[];
  vertices: VertexGeo[];
  edges: EdgeGeo[];
  /** viewBox 尺寸 */
  width: number;
  height: number;
}

// ---- 可变游戏状态 ----

export interface Building {
  type: 'settlement' | 'city';
  owner: number;
}

export interface Road {
  owner: number;
}

export interface Player {
  id: number;
  name: string;
  color: string;
  isAI: boolean;
  resources: ResMap;
  /** 手上可用的发展卡 */
  devCards: DevCard[];
  /** 本回合刚买、尚不能使用的发展卡 */
  newDevCards: DevCard[];
  knightsPlayed: number;
  /** 已打出的胜利点卡数量（计入分数） */
  vpCards: number;
}

export type Phase =
  | 'setup1' // 顺序放第一个房屋+路
  | 'setup2' // 逆序放第二个房屋+路
  | 'roll' // 当前玩家需掷骰
  | 'discard' // 掷出 7，超 7 张的玩家弃牌
  | 'moveRobber' // 当前玩家移动强盗
  | 'steal' // 选择偷牌目标
  | 'main' // 建造/交易/发展卡阶段
  | 'gameOver';

export interface TradeOffer {
  from: number;
  to: number;
  give: ResMap;
  receive: ResMap;
}

export interface GameState {
  players: Player[];
  current: number;
  phase: Phase;
  /** setup 阶段子步骤 */
  setupStep: 'settlement' | 'road';
  setupOrder: number[];
  setupIndex: number;
  /** setup 阶段刚放置的房屋顶点（用于约束随后放路） */
  lastSettlement: number | null;

  dice: [number, number] | null;
  buildings: Record<number, Building>; // vertexId -> Building
  roads: Record<number, Road>; // edgeId -> Road
  robber: number; // hexId

  bank: ResMap;
  devDeck: DevCard[];

  longestRoad: { player: number | null; len: number };
  largestArmy: { player: number | null; size: number };

  turn: number;
  /** 本回合是否已打出发展卡 */
  devPlayed: boolean;
  /** 可免费建造的路数量（路建卡 / setup） */
  freeRoads: number;
  /** 移动强盗后应返回的阶段 */
  robberReturn: Phase;
  /** 各玩家本次需弃掉的牌数 */
  discardLeft: Record<number, number>;
  /** AI 发给玩家、待玩家应答的交易 */
  pendingTrade: TradeOffer | null;

  log: { text: string; turnMark?: boolean }[];
  winner: number | null;
}

export interface FullGame {
  board: Board;
  state: GameState;
}

// ---- 建造成本 ----

export const COSTS = {
  road: { wood: 1, brick: 1 } as Partial<ResMap>,
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 } as Partial<ResMap>,
  city: { wheat: 2, ore: 3 } as Partial<ResMap>,
  dev: { sheep: 1, wheat: 1, ore: 1 } as Partial<ResMap>,
};

export const PIECE_LIMIT = { settlement: 5, city: 4, road: 15 };
export const VICTORY_POINTS = 10;

export const RESOURCE_LABEL: Record<Resource, string> = {
  wood: '木材',
  brick: '砖',
  sheep: '羊',
  wheat: '麦',
  ore: '矿',
};

export const TERRAIN_COLOR: Record<Terrain, string> = {
  wood: '#2f7d32',
  brick: '#c0673b',
  sheep: '#7cc36b',
  wheat: '#e3b748',
  ore: '#7d8a99',
  desert: '#d8c79a',
};

export const RESOURCE_COLOR: Record<Resource, string> = {
  wood: '#2f7d32',
  brick: '#c0673b',
  sheep: '#7cc36b',
  wheat: '#e3b748',
  ore: '#7d8a99',
};

export const DEV_LABEL: Record<DevCard, string> = {
  knight: '骑士',
  victory: '胜利点',
  roadBuilding: '修路',
  yearOfPlenty: '丰收',
  monopoly: '垄断',
};

/** 数字标记的概率点数（出现概率，2/12=1 … 6/8=5） */
export function pips(n: number | null): number {
  if (n == null) return 0;
  return 6 - Math.abs(7 - n);
}
