import type { Resource, Terrain } from '../../shared/types';

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
  木: {
    base: '#3f5f3e',
    light: '#667b4e',
    dark: '#243922',
    ink: INK,
    hatch: '#1f321e',
  },
  砖: {
    base: '#874638',
    light: '#aa6650',
    dark: '#512820',
    ink: INK,
    hatch: '#3a1b16',
  },
  羊: {
    base: '#7a8655',
    light: '#a1a875',
    dark: '#495234',
    ink: INK,
    hatch: '#3a432b',
  },
  麦: {
    base: '#b59645',
    light: '#d4b86a',
    dark: '#735a26',
    ink: INK,
    hatch: '#5a441c',
  },
  矿: {
    base: '#5d6370',
    light: '#858b94',
    dark: '#2e333c',
    ink: INK,
    hatch: '#20242b',
  },
  沙漠: {
    base: '#bca77a',
    light: '#d8c99e',
    dark: '#756344',
    ink: INK,
    hatch: '#6a583a',
  },
};

export const TERRAIN_TILE_ASSETS: Record<Terrain, string> = {
  木: '/assets/terrain-wood.png',
  砖: '/assets/terrain-brick.png',
  羊: '/assets/terrain-sheep.png',
  麦: '/assets/terrain-wheat.png',
  矿: '/assets/terrain-ore.png',
  沙漠: '/assets/terrain-desert.png',
};

/** 棋盘海洋背景贴图（手绘哥特墨线海面） */
export const SEA_ASSET = '/assets/sea.png';

/** 强盗棋子贴图（透明 PNG） */
export const ROBBER_ASSET = '/assets/robber-token.png';

/** 港口交易徽章贴图（透明 PNG） */
export const PORT_BADGE_ASSET = '/assets/port-badge.png';

export const RESOURCE_ART: Record<Resource, string> = {
  木: TERRAIN_ART.木.base,
  砖: TERRAIN_ART.砖.base,
  羊: TERRAIN_ART.羊.base,
  麦: TERRAIN_ART.麦.base,
  矿: TERRAIN_ART.矿.base,
};

export { PLAYER_ART_COLORS } from '../../shared/state';
