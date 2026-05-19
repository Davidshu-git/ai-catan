import type { Resource, Terrain } from '../game/types';

export interface TerrainArt {
  base: string;
  light: string;
  dark: string;
  ink: string;
  hatch: string;
}

export const INK = '#241d1a';
export const PAPER = '#efe3c8';
export const PAPER_DARK = '#b89a6d';

export const TERRAIN_ART: Record<Terrain, TerrainArt> = {
  wood: {
    base: '#3f5f3e',
    light: '#667b4e',
    dark: '#243922',
    ink: INK,
    hatch: '#1f321e',
  },
  brick: {
    base: '#874638',
    light: '#aa6650',
    dark: '#512820',
    ink: INK,
    hatch: '#3a1b16',
  },
  sheep: {
    base: '#7a8655',
    light: '#a1a875',
    dark: '#495234',
    ink: INK,
    hatch: '#3a432b',
  },
  wheat: {
    base: '#b59645',
    light: '#d4b86a',
    dark: '#735a26',
    ink: INK,
    hatch: '#5a441c',
  },
  ore: {
    base: '#5d6370',
    light: '#858b94',
    dark: '#2e333c',
    ink: INK,
    hatch: '#20242b',
  },
  desert: {
    base: '#bca77a',
    light: '#d8c99e',
    dark: '#756344',
    ink: INK,
    hatch: '#6a583a',
  },
};

export const TERRAIN_TILE_ASSETS: Record<Terrain, string> = {
  wood: '/assets/terrain-wood.png',
  brick: '/assets/terrain-brick.png',
  sheep: '/assets/terrain-sheep.png',
  wheat: '/assets/terrain-wheat.png',
  ore: '/assets/terrain-ore.png',
  desert: '/assets/terrain-desert.png',
};

/** 棋盘海洋背景贴图（手绘哥特墨线海面） */
export const SEA_ASSET = '/assets/sea.png';

/** 强盗棋子贴图（透明 PNG） */
export const ROBBER_ASSET = '/assets/robber-token.png';

export const RESOURCE_ART: Record<Resource, string> = {
  wood: TERRAIN_ART.wood.base,
  brick: TERRAIN_ART.brick.base,
  sheep: TERRAIN_ART.sheep.base,
  wheat: TERRAIN_ART.wheat.base,
  ore: TERRAIN_ART.ore.base,
};

export const PLAYER_ART_COLORS = ['#a83836', '#3e668f', '#526b3b', '#a06a32'];
