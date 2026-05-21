// ============================================================
// SVG 棋盘渲染与交互（手绘哥特纸片风）
// ============================================================

import type { Board as BoardT, GameState, Hex } from '../../shared/types';
import { TERRAIN_COLOR, pips } from '../../shared/types';
import {
  INK,
  PAPER,
  PAPER_DARK,
  PORT_BADGE_ASSET,
  ROBBER_ASSET,
  TERRAIN_ART,
  TERRAIN_TILE_ASSETS,
} from '../art/theme';
import {
  canBuildCity,
  canBuildRoad,
  canBuildSettlement,
  canPlaceRoadSetup,
  canPlaceSettlementFree,
} from '../../shared/rules';
import type { Action } from '../../shared/reducer';

export type BoardMode = 'road' | 'settlement' | 'city' | 'robber' | null;

interface Props {
  board: BoardT;
  state: GameState;
  mode: BoardMode;
  onVertex: (v: number) => void;
  onEdge: (e: number) => void;
  onHex: (h: number) => void;
  highlightAction?: Action | null;
  highlightPlayer?: number | null;
}

const PORT_SHORT: Record<string, string> = {
  木: '木', 砖: '砖', 羊: '羊', 麦: '麦', 矿: '矿', 通用: '3:1',
};

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255,
    g = (n >> 8) & 255,
    b = n & 255;
  r = Math.max(0, Math.min(255, Math.round(r * f)));
  g = Math.max(0, Math.min(255, Math.round(g * f)));
  b = Math.max(0, Math.min(255, Math.round(b * f)));
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

function edgeLabelPosition(
  e: { x1: number; y1: number; x2: number; y2: number },
  cx: number,
  cy: number,
): { x: number; y: number } {
  const mx = (e.x1 + e.x2) / 2;
  const my = (e.y1 + e.y2) / 2;
  const dx = e.x2 - e.x1;
  const dy = e.y2 - e.y1;
  const len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len;
  let ny = dx / len;

  // 编号稍微偏到棋盘外侧，避免直接压在道路线上。
  if (nx * (mx - cx) + ny * (my - cy) < 0) {
    nx = -nx;
    ny = -ny;
  }

  return { x: mx + nx * 9, y: my + ny * 9 };
}

/** 每种地形的卡通装饰（裁剪在六边形内） */
function Motif({ h }: { h: Hex }) {
  const x = h.cx;
  const y = h.cy;
  const art = TERRAIN_ART[h.terrain];
  switch (h.terrain) {
    case '木': {
      const tree = (tx: number, ty: number, s: number) => (
        <g key={`${tx},${ty}`}>
          <path d={`M ${tx - 2 * s} ${ty + 13 * s} C ${tx - 5 * s} ${ty + 2 * s} ${tx + 5 * s} ${ty - 8 * s} ${tx + 1 * s} ${ty - 22 * s}`} stroke="#3a2318" strokeWidth={4 * s} fill="none" strokeLinecap="round" />
          <path d={`M ${tx} ${ty - 10 * s} C ${tx - 15 * s} ${ty - 19 * s} ${tx - 9 * s} ${ty - 31 * s} ${tx + 1 * s} ${ty - 25 * s} C ${tx + 13 * s} ${ty - 33 * s} ${tx + 19 * s} ${ty - 15 * s} ${tx + 6 * s} ${ty - 10 * s} Z`} fill={art.light} stroke={INK} strokeWidth={1.8} strokeLinejoin="round" />
          <path d={`M ${tx - 12 * s} ${ty - 17 * s} q ${8 * s} ${5 * s} ${16 * s} 0 M ${tx - 8 * s} ${ty - 23 * s} q ${8 * s} ${5 * s} ${18 * s} -1`} stroke={art.hatch} strokeWidth={1.2} fill="none" />
        </g>
      );
      return (
        <g opacity={0.95}>
          {tree(x - 17, y - 6, 0.95)}
          {tree(x + 15, y - 10, 0.8)}
          {tree(x - 2, y + 12, 1.05)}
        </g>
      );
    }
    case '砖': {
      return (
        <g opacity={0.9}>
          <path d={`M ${x - 31} ${y + 15} C ${x - 19} ${y - 19} ${x + 12} ${y - 23} ${x + 31} ${y + 13} Z`} fill={art.light} stroke={INK} strokeWidth={2} />
          {[-21, -6, 9].map((sx, i) => (
            <path key={sx} d={`M ${x + sx} ${y + 17 - i * 4} l ${10} ${-31} l ${13} ${31}`} stroke={art.hatch} strokeWidth={1.5} fill="none" />
          ))}
          {[-14, -2, 10].map((oy) => (
            <path key={oy} d={`M ${x - 26} ${y + oy} q ${20} ${-5} ${52} ${1}`} stroke={INK} strokeWidth={1.2} fill="none" opacity={0.7} />
          ))}
        </g>
      );
    }
    case '羊': {
      const sheep = (sx: number, sy: number, s: number) => (
        <g key={`${sx},${sy}`}>
          <path d={`M ${sx - 13 * s} ${sy} C ${sx - 13 * s} ${sy - 11 * s} ${sx + 12 * s} ${sy - 12 * s} ${sx + 15 * s} ${sy - 1 * s} C ${sx + 20 * s} ${sy + 10 * s} ${sx - 9 * s} ${sy + 14 * s} ${sx - 13 * s} ${sy} Z`} fill="#d8d3c4" stroke={INK} strokeWidth={1.6} />
          <circle cx={sx + 12 * s} cy={sy - 4 * s} r={5.5 * s} fill="#3b302c" stroke={INK} strokeWidth={1} />
          <circle cx={sx + 13.5 * s} cy={sy - 5.2 * s} r={1.2 * s} fill="#f4ead7" />
          <path d={`M ${sx - 8 * s} ${sy + 7 * s} l ${-2 * s} ${8 * s} M ${sx + 6 * s} ${sy + 8 * s} l ${2 * s} ${8 * s}`} stroke={INK} strokeWidth={1.7} strokeLinecap="round" />
        </g>
      );
      return (
        <g opacity={0.96}>
          {sheep(x - 11, y - 4, 1)}
          {sheep(x + 12, y + 9, 0.85)}
        </g>
      );
    }
    case '麦': {
      const stalk = (sx: number) => (
        <g key={sx} stroke={art.dark} strokeWidth={2}>
          <line x1={sx} y1={y + 16} x2={sx} y2={y - 14} />
          {[-10, -4, 2, 8].map((o) => (
            <g key={o}>
              <line x1={sx} y1={y + o} x2={sx - 7} y2={y + o - 6} />
              <line x1={sx} y1={y + o} x2={sx + 7} y2={y + o - 6} />
            </g>
          ))}
          <circle cx={sx} cy={y - 16} r={2.5} fill={art.light} stroke={INK} strokeWidth={0.8} />
        </g>
      );
      return (
        <g opacity={0.9}>
          {stalk(x - 14)}
          {stalk(x)}
          {stalk(x + 14)}
        </g>
      );
    }
    case '矿': {
      return (
        <g opacity={0.92}>
          <polygon points={`${x - 26},${y + 17} ${x - 7},${y - 24} ${x + 9},${y + 18}`} fill={art.dark} stroke={INK} strokeWidth={2} strokeLinejoin="round" />
          <polygon points={`${x - 7},${y - 24} ${x - 12},${y + 17} ${x + 3},${y + 18}`} fill={art.light} opacity={0.75} />
          <polygon points={`${x + 0},${y + 18} ${x + 17},${y - 7} ${x + 30},${y + 18}`} fill={art.base} stroke={INK} strokeWidth={1.8} strokeLinejoin="round" />
          <path d={`M ${x - 17} ${y + 8} l ${17} -6 M ${x + 10} ${y + 10} l ${11} -4`} stroke="#c4ccd1" strokeWidth={1.4} />
        </g>
      );
    }
    case '沙漠': {
      return (
        <g opacity={0.85}>
          <path d={`M ${x - 30} ${y + 17} Q ${x - 11} ${y + 2} ${x + 5} ${y + 12} T ${x + 31} ${y + 10}`} stroke={art.dark} strokeWidth={3} fill="none" strokeLinecap="round" />
          <path d={`M ${x - 15} ${y + 8} c ${7} ${-12} ${20} ${-11} ${27} ${1} c ${-9} ${9} ${-19} ${10} ${-27} ${-1} Z`} fill="#d6cfb6" stroke={INK} strokeWidth={1.8} />
          <circle cx={x - 5} cy={y + 5} r={1.5} fill={INK} />
          <circle cx={x + 5} cy={y + 6} r={1.5} fill={INK} />
          <path d={`M ${x - 22} ${y - 9} l ${13} ${6} M ${x - 14} ${y - 14} l ${-1} ${12} M ${x + 17} ${y - 13} l ${-9} ${12}`} stroke={INK} strokeWidth={1.5} strokeLinecap="round" />
        </g>
      );
    }
    default:
      return null;
  }
}

export function Board({
  board,
  state,
  mode,
  onVertex,
  onEdge,
  onHex,
  highlightAction = null,
  highlightPlayer = null,
}: Props) {
  const isSetup = state.phase === 'setup1' || state.phase === 'setup2';
  const p = state.current;
  const bcx = board.width / 2;
  const bcy = board.height / 2;
  const focusColor =
    highlightPlayer != null ? state.players[highlightPlayer]?.color ?? PAPER : PAPER;
  const focusEdge =
    highlightAction?.type === 'BUILD_ROAD' || highlightAction?.type === 'PLACE_ROAD'
      ? highlightAction.e
      : null;
  const focusVertex =
    highlightAction?.type === 'BUILD_SETTLEMENT' ||
    highlightAction?.type === 'BUILD_CITY' ||
    highlightAction?.type === 'PLACE_SETTLEMENT'
      ? highlightAction.v
      : null;
  const focusHex = highlightAction?.type === 'MOVE_ROBBER' ? highlightAction.hex : null;

  const vertexLegal = (v: number): boolean => {
    if (mode !== 'settlement' && mode !== 'city') return false;
    if (mode === 'city') return canBuildCity(state, v, p);
    return isSetup
      ? canPlaceSettlementFree(board, state, v)
      : canBuildSettlement(board, state, v, p);
  };
  const edgeLegal = (e: number): boolean => {
    if (mode !== 'road') return false;
    return isSetup ? canPlaceRoadSetup(board, state, e) : canBuildRoad(board, state, e, p);
  };
  const hexLegal = (h: number): boolean => mode === 'robber' && h !== state.robber;

  return (
    <svg
      className="board-svg"
      viewBox={`0 0 ${board.width} ${board.height}`}
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <radialGradient id="sea" cx="50%" cy="45%" r="75%">
          <stop offset="0%" stopColor="#53666c" />
          <stop offset="58%" stopColor="#344b53" />
          <stop offset="100%" stopColor="#1f3038" />
        </radialGradient>
        {Object.keys(TERRAIN_COLOR).map((t) => (
          <radialGradient id={`g-${t}`} key={t} cx="38%" cy="30%" r="82%">
            <stop offset="0%" stopColor={TERRAIN_ART[t as keyof typeof TERRAIN_ART].light} />
            <stop offset="72%" stopColor={TERRAIN_ART[t as keyof typeof TERRAIN_ART].base} />
            <stop offset="100%" stopColor={TERRAIN_ART[t as keyof typeof TERRAIN_ART].dark} />
          </radialGradient>
        ))}
        {Object.entries(TERRAIN_ART).map(([terrain, art]) => (
          <pattern id={`hatch-${terrain}`} key={terrain} width="11" height="11" patternUnits="userSpaceOnUse" patternTransform="rotate(-23)">
            <path d="M 0 0 L 0 11" stroke={art.hatch} strokeWidth={1.1} opacity={0.28} />
          </pattern>
        ))}
        <filter id="soft" x="-35%" y="-35%" width="170%" height="170%">
          <feDropShadow dx="2.2" dy="4" stdDeviation="1.5" floodColor="#120f0d" floodOpacity="0.42" />
        </filter>
        <filter id="paper-warp" x="-8%" y="-8%" width="116%" height="116%">
          <feTurbulence type="fractalNoise" baseFrequency="0.025" numOctaves="2" seed="9" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="1.2" />
        </filter>
        {board.hexes.map((h) => (
          <clipPath id={`clip-${h.id}`} key={h.id}>
            <polygon points={h.poly.map((c) => `${c.x},${c.y}`).join(' ')} />
          </clipPath>
        ))}
      </defs>

      {/* 地块 */}
      {board.hexes.map((h) => {
        const legal = hexLegal(h.id);
        const focused = focusHex === h.id;
        const pts = h.poly.map((c) => `${c.x},${c.y}`).join(' ');
        const tileAsset = TERRAIN_TILE_ASSETS[h.terrain];
        return (
          <g
            key={`hex-${h.id}`}
            className={legal ? 'hex-clickable' : undefined}
            onClick={legal ? () => onHex(h.id) : undefined}
          >
            {tileAsset ? (
              <g clipPath={`url(#clip-${h.id})`}>
                <polygon points={pts} fill={`url(#g-${h.terrain})`} />
                <image
                  href={tileAsset}
                  x={h.cx - 69}
                  y={h.cy - 69}
                  width={138}
                  height={138}
                  preserveAspectRatio="xMidYMid slice"
                />
              </g>
            ) : (
              <>
                <polygon points={pts} fill={`url(#g-${h.terrain})`} />
                <g clipPath={`url(#clip-${h.id})`}>
                  <rect x={h.cx - 58} y={h.cy - 58} width={116} height={116} fill={`url(#hatch-${h.terrain})`} />
                  <Motif h={h} />
                </g>
              </>
            )}
            <polygon
              points={pts}
              fill="none"
              stroke={legal ? PAPER : INK}
              strokeWidth={legal ? 5 : 2.8}
              strokeLinejoin="round"
              filter="url(#paper-warp)"
            />
            {focused && (
              <polygon
                className="ai-board-focus"
                points={pts}
                fill="none"
                stroke={focusColor}
                strokeWidth={7}
                strokeLinejoin="round"
              />
            )}
            {h.number != null && (
              <g filter="url(#soft)">
                <circle cx={h.cx} cy={h.cy} r={16} fill={PAPER} stroke={INK} strokeWidth={2.2} />
                <text
                  x={h.cx}
                  y={h.cy + 1}
                  textAnchor="middle"
                  fontSize={13}
                  fontWeight={800}
                  fill={h.number === 6 || h.number === 8 ? '#8f2e29' : INK}
                >
                  {h.number}
                </text>
                {Array.from({ length: pips(h.number) }).map((_, i, arr) => (
                  <circle
                    key={i}
                    cx={h.cx - (arr.length - 1) * 2.2 + i * 4.4}
                    cy={h.cy + 6}
                    r={1.5}
                    fill={h.number === 6 || h.number === 8 ? '#8f2e29' : '#4b3927'}
                  />
                ))}
              </g>
            )}
            {state.robber === h.id && (
              <g className="svg-pop" filter="url(#soft)" transform={`translate(${h.cx}, ${h.cy})`}>
                <ellipse cx={0} cy={10} rx={9} ry={2.6} fill="rgba(0,0,0,0.34)" />
                <image
                  href={ROBBER_ASSET}
                  x={-11}
                  y={-30}
                  width={22}
                  height={40}
                  preserveAspectRatio="xMidYMid meet"
                />
              </g>
            )}
          </g>
        );
      })}

      {/* 港口徽章 */}
      {board.vertices
        .filter((v) => v.port)
        .map((v) => {
          const dx = v.x - bcx;
          const dy = v.y - bcy;
          const d = Math.hypot(dx, dy) || 1;
          const px = v.x + (dx / d) * 25;
          const py = v.y + (dy / d) * 25;
          return (
            <g key={`port-${v.id}`} filter="url(#soft)">
              <line x1={v.x} y1={v.y} x2={px} y2={py} stroke={PAPER_DARK} strokeWidth={2.5} strokeLinecap="round" />
              <image
                href={PORT_BADGE_ASSET}
                x={px - 24}
                y={py - 13}
                width={48}
                height={26}
                preserveAspectRatio="xMidYMid meet"
              />
              <text
                x={px}
                y={py + 4}
                textAnchor="middle"
                fontSize={10}
                fontWeight={900}
                fill={INK}
                stroke={PAPER}
                strokeWidth={0.9}
                paintOrder="stroke"
              >
                {PORT_SHORT[v.port!]}
              </text>
            </g>
          );
        })}

      {/* 道路 */}
      {board.edges.map((e) => {
        const road = state.roads[e.id];
        const legal = edgeLegal(e.id);
        const focused = focusEdge === e.id;
        return (
          <g
            key={`edge-${e.id}`}
            className={legal ? 'edge-hit' : undefined}
            onClick={legal ? () => onEdge(e.id) : undefined}
          >
            {road && (
              <g className="svg-pop">
                <line x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke="rgba(20,16,13,0.45)" strokeWidth={11} strokeLinecap="round" />
                <line
                  x1={e.x1}
                  y1={e.y1}
                  x2={e.x2}
                  y2={e.y2}
                  stroke={state.players[road.owner].color}
                  strokeWidth={7.5}
                  strokeLinecap="round"
                />
                <line x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke={INK} strokeWidth={1.4} strokeLinecap="round" strokeDasharray="4 5" opacity={0.8} />
              </g>
            )}
            {legal && (
              <line
                className="hit"
                x1={e.x1}
                y1={e.y1}
                x2={e.x2}
                y2={e.y2}
                stroke="rgba(239,227,200,0.5)"
                strokeWidth={9}
                strokeLinecap="round"
              />
            )}
            {focused && (
              <line
                className="ai-board-focus"
                x1={e.x1}
                y1={e.y1}
                x2={e.x2}
                y2={e.y2}
                stroke={focusColor}
                strokeWidth={13}
                strokeLinecap="round"
              />
            )}
          </g>
        );
      })}

      {/* 顶点：房屋 / 城市 / 可放置点 */}
      {board.vertices.map((v) => {
        const bld = state.buildings[v.id];
        const legal = vertexLegal(v.id);
        const focused = focusVertex === v.id;
        const col = bld ? state.players[bld.owner].color : '';
        return (
          <g
            key={`v-${v.id}`}
            className={legal ? 'vertex-hit' : undefined}
            onClick={legal ? () => onVertex(v.id) : undefined}
            >
            {bld && bld.type === 'settlement' && (
              <g className="svg-pop" filter="url(#soft)" transform={`translate(${v.x}, ${v.y})`}>
                <path d="M -9 9 L 8 9 L 7 -2 L -7 -2 Z" fill={col} stroke={INK} strokeWidth={1.7} strokeLinejoin="round" />
                <path d="M -11 -2 L -1 -13 L 11 -2 C 5 1 -4 1 -11 -2 Z" fill={shade(col || '#999', 0.72)} stroke={INK} strokeWidth={1.7} strokeLinejoin="round" />
                <path d="M -8 -2 q 8 4 17 0 M -5 2 l 10 0" stroke={INK} strokeWidth={1} opacity={0.65} />
                <rect x={-2.5} y={3} width={5} height={6.5} rx={0.8} fill={INK} />
              </g>
            )}
            {bld && bld.type === 'city' && (
              <g className="svg-pop" filter="url(#soft)" transform={`translate(${v.x}, ${v.y})`}>
                <path d="M -12 12 L -12 -2 L -7 -7 L -2 -2 L -2 12 Z" fill={col} stroke={INK} strokeWidth={1.7} strokeLinejoin="round" />
                <path d="M -1 12 L -1 -12 L 5 -19 L 12 -12 L 12 12 Z" fill={shade(col || '#999', 0.82)} stroke={INK} strokeWidth={1.7} strokeLinejoin="round" />
                <path d="M -8 2 l 3 0 l 0 4 l -3 0 Z M 3 -6 l 3 0 l 0 4 l -3 0 Z M 7 1 l 3 0 l 0 4 l -3 0 Z" fill={PAPER} stroke={INK} strokeWidth={0.8} />
                <path d="M -1 -12 l 13 0 M -12 -2 l 10 0" stroke={INK} strokeWidth={1} opacity={0.65} />
              </g>
            )}
            {legal && (
              <circle
                className="hit"
                cx={v.x}
                cy={v.y}
                r={8}
                fill="rgba(239,227,200,0.72)"
                stroke={PAPER}
                strokeWidth={2}
              />
            )}
            {focused && (
              <circle
                className="ai-board-focus"
                cx={v.x}
                cy={v.y}
                r={16}
                fill="none"
                stroke={focusColor}
                strokeWidth={5}
              />
            )}
          </g>
        );
      })}

      {/* 边 / 顶点编号调试层 */}
      <g pointerEvents="none">
        {board.edges.map((e) => {
          const pos = edgeLabelPosition(e, bcx, bcy);
          return (
            <text
              key={`edge-label-${e.id}`}
              x={pos.x}
              y={pos.y}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={8}
              fontWeight={900}
              fill="#31261f"
              stroke={PAPER}
              strokeWidth={2.4}
              paintOrder="stroke"
              opacity={0.88}
            >
              e{e.id}
            </text>
          );
        })}

        {board.vertices.map((v) => (
          <text
            key={`vertex-label-${v.id}`}
            x={v.x}
            y={v.y - 13}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={8}
            fontWeight={900}
            fill="#7d2f2b"
            stroke={PAPER}
            strokeWidth={2.6}
            paintOrder="stroke"
            opacity={0.92}
          >
            v{v.id}
          </text>
        ))}
      </g>
    </svg>
  );
}
