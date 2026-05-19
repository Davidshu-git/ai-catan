// ============================================================
// SVG 棋盘渲染与交互（明亮扁平卡通风）
// ============================================================

import type { Board as BoardT, GameState, Hex } from '../game/types';
import { TERRAIN_COLOR, pips } from '../game/types';
import {
  canBuildCity,
  canBuildRoad,
  canBuildSettlement,
  canPlaceRoadSetup,
  canPlaceSettlementFree,
} from '../game/rules';

export type BoardMode = 'road' | 'settlement' | 'city' | 'robber' | null;

interface Props {
  board: BoardT;
  state: GameState;
  mode: BoardMode;
  onVertex: (v: number) => void;
  onEdge: (e: number) => void;
  onHex: (h: number) => void;
}

const PORT_SHORT: Record<string, string> = {
  wood: '木', brick: '砖', sheep: '羊', wheat: '麦', ore: '矿', any: '3:1',
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

/** 每种地形的卡通装饰（裁剪在六边形内） */
function Motif({ h }: { h: Hex }) {
  const x = h.cx;
  const y = h.cy;
  const dark = shade(TERRAIN_COLOR[h.terrain], 0.7);
  switch (h.terrain) {
    case 'wood': {
      const tree = (tx: number, ty: number, s: number) => (
        <g key={`${tx},${ty}`}>
          <rect x={tx - 2 * s} y={ty} width={4 * s} height={9 * s} rx={1.5} fill="#7a4a25" />
          <circle cx={tx} cy={ty - 3 * s} r={9 * s} fill="#2f9d4e" />
          <circle cx={tx - 5 * s} cy={ty + 2 * s} r={6 * s} fill="#37ad59" />
          <circle cx={tx + 5 * s} cy={ty + 2 * s} r={6 * s} fill="#37ad59" />
        </g>
      );
      return (
        <g opacity={0.92}>
          {tree(x - 17, y - 6, 0.95)}
          {tree(x + 15, y - 10, 0.8)}
          {tree(x - 2, y + 12, 1.05)}
        </g>
      );
    }
    case 'brick': {
      const rows = [0, 1, 2, 3];
      return (
        <g opacity={0.9}>
          {rows.map((ri) =>
            [0, 1, 2].map((ci) => (
              <rect
                key={`${ri}-${ci}`}
                x={x - 24 + ci * 17 + (ri % 2) * 8}
                y={y - 16 + ri * 9}
                width={15}
                height={7}
                rx={1.5}
                fill={shade('#e8895a', 0.92)}
                stroke={dark}
                strokeWidth={1}
              />
            )),
          )}
        </g>
      );
    }
    case 'sheep': {
      const sheep = (sx: number, sy: number, s: number) => (
        <g key={`${sx},${sy}`}>
          <ellipse cx={sx} cy={sy} rx={11 * s} ry={8 * s} fill="#fbf7ef" />
          <circle cx={sx + 9 * s} cy={sy - 3 * s} r={5 * s} fill="#5a4636" />
          <rect x={sx - 9 * s} y={sy + 5 * s} width={2.5} height={5 * s} fill="#5a4636" />
          <rect x={sx + 6 * s} y={sy + 5 * s} width={2.5} height={5 * s} fill="#5a4636" />
        </g>
      );
      return (
        <g opacity={0.96}>
          {sheep(x - 11, y - 4, 1)}
          {sheep(x + 12, y + 9, 0.85)}
        </g>
      );
    }
    case 'wheat': {
      const stalk = (sx: number) => (
        <g key={sx} stroke={shade('#e0a800', 0.9)} strokeWidth={2}>
          <line x1={sx} y1={y + 16} x2={sx} y2={y - 14} />
          {[-10, -4, 2, 8].map((o) => (
            <g key={o}>
              <line x1={sx} y1={y + o} x2={sx - 7} y2={y + o - 6} />
              <line x1={sx} y1={y + o} x2={sx + 7} y2={y + o - 6} />
            </g>
          ))}
          <circle cx={sx} cy={y - 16} r={3} fill="#f6d743" stroke="none" />
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
    case 'ore': {
      return (
        <g opacity={0.92}>
          <polygon points={`${x - 24},${y + 16} ${x - 6},${y - 16} ${x + 10},${y + 16}`} fill={shade('#8a98aa', 0.85)} />
          <polygon points={`${x - 6},${y - 16} ${x - 12},${y + 16} ${x + 2},${y + 16}`} fill="#cfd8e3" />
          <polygon points={`${x + 2},${y + 16} ${x + 16},${y - 4} ${x + 26},${y + 16}`} fill={shade('#8a98aa', 0.95)} />
          <polygon points={`${x + 16},${y - 4} ${x + 11},${y + 16} ${x + 21},${y + 16}`} fill="#e3eaf2" />
        </g>
      );
    }
    case 'desert': {
      return (
        <g opacity={0.85}>
          <path d={`M ${x - 26} ${y + 14} Q ${x - 10} ${y + 2} ${x + 4} ${y + 12} T ${x + 28} ${y + 10}`} stroke={shade('#e9d28c', 0.85)} strokeWidth={4} fill="none" strokeLinecap="round" />
          <g>
            <rect x={x - 3} y={y - 12} width={6} height={20} rx={3} fill="#5fa86b" />
            <rect x={x - 11} y={y - 4} width={5} height={11} rx={2.5} fill="#5fa86b" />
            <rect x={x + 6} y={y - 7} width={5} height={13} rx={2.5} fill="#5fa86b" />
          </g>
        </g>
      );
    }
    default:
      return null;
  }
}

export function Board({ board, state, mode, onVertex, onEdge, onHex }: Props) {
  const isSetup = state.phase === 'setup1' || state.phase === 'setup2';
  const p = state.current;
  const bcx = board.width / 2;
  const bcy = board.height / 2;

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
          <stop offset="0%" stopColor="#7ed4fb" />
          <stop offset="100%" stopColor="#3fa9e8" />
        </radialGradient>
        {Object.keys(TERRAIN_COLOR).map((t) => (
          <radialGradient id={`g-${t}`} key={t} cx="42%" cy="38%" r="78%">
            <stop offset="0%" stopColor={shade(TERRAIN_COLOR[t as keyof typeof TERRAIN_COLOR], 1.18)} />
            <stop offset="100%" stopColor={TERRAIN_COLOR[t as keyof typeof TERRAIN_COLOR]} />
          </radialGradient>
        ))}
        <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="2.5" stdDeviation="2" floodColor="#1f3a52" floodOpacity="0.35" />
        </filter>
        {board.hexes.map((h) => (
          <clipPath id={`clip-${h.id}`} key={h.id}>
            <polygon points={h.poly.map((c) => `${c.x},${c.y}`).join(' ')} />
          </clipPath>
        ))}
      </defs>

      <rect x={0} y={0} width={board.width} height={board.height} fill="url(#sea)" />
      {/* 海浪 */}
      {Array.from({ length: 7 }).map((_, i) => (
        <path
          key={`w-${i}`}
          d={`M 0 ${60 + i * ((board.height - 80) / 6)} q 22 -10 44 0 t 44 0 t 44 0 t 44 0 t 44 0 t 44 0 t 44 0 t 44 0 t 44 0 t 44 0 t 44 0 t 44 0`}
          stroke="rgba(255,255,255,0.16)"
          strokeWidth={3}
          fill="none"
        />
      ))}

      {/* 地块 */}
      {board.hexes.map((h) => {
        const legal = hexLegal(h.id);
        const pts = h.poly.map((c) => `${c.x},${c.y}`).join(' ');
        return (
          <g
            key={`hex-${h.id}`}
            className={legal ? 'hex-clickable' : undefined}
            onClick={legal ? () => onHex(h.id) : undefined}
          >
            <polygon points={pts} fill={`url(#g-${h.terrain})`} />
            <g clipPath={`url(#clip-${h.id})`}>
              <Motif h={h} />
            </g>
            <polygon
              points={pts}
              fill="none"
              stroke={legal ? '#fff' : shade(TERRAIN_COLOR[h.terrain], 0.6)}
              strokeWidth={legal ? 5 : 3}
              strokeLinejoin="round"
            />
            {h.number != null && (
              <g filter="url(#soft)">
                <circle cx={h.cx} cy={h.cy} r={16} fill="#fff6e2" stroke="#caa667" strokeWidth={2} />
                <text
                  x={h.cx}
                  y={h.cy + 1}
                  textAnchor="middle"
                  fontSize={15}
                  fontWeight={800}
                  fill={h.number === 6 || h.number === 8 ? '#d83a2f' : '#5a4326'}
                >
                  {h.number}
                </text>
                {Array.from({ length: pips(h.number) }).map((_, i, arr) => (
                  <circle
                    key={i}
                    cx={h.cx - (arr.length - 1) * 2.6 + i * 5.2}
                    cy={h.cy + 10}
                    r={1.7}
                    fill={h.number === 6 || h.number === 8 ? '#d83a2f' : '#7a5c33'}
                  />
                ))}
              </g>
            )}
            {state.robber === h.id && (
              <g filter="url(#soft)" transform={`translate(${h.cx + 19}, ${h.cy - 17})`}>
                <ellipse cx={0} cy={13} rx={11} ry={4} fill="rgba(0,0,0,0.25)" />
                <path d="M 0 -11 C 9 -11 11 -2 11 8 L -11 8 C -11 -2 -9 -11 0 -11 Z" fill="#3a3a44" />
                <circle cx={0} cy={-8} r={6.5} fill="#2f2f38" />
                <circle cx={-2.3} cy={-8} r={1.4} fill="#fff" />
                <circle cx={2.3} cy={-8} r={1.4} fill="#fff" />
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
          const px = v.x + (dx / d) * 18;
          const py = v.y + (dy / d) * 18;
          return (
            <g key={`port-${v.id}`} filter="url(#soft)">
              <line x1={v.x} y1={v.y} x2={px} y2={py} stroke="#b9885a" strokeWidth={2.5} />
              <rect x={px - 14} y={py - 11} width={28} height={22} rx={7} fill="#fff6e2" stroke="#caa667" strokeWidth={2} />
              <text x={px} y={py + 4} textAnchor="middle" fontSize={11} fontWeight={800} fill="#7a5c33">
                {PORT_SHORT[v.port!]}
              </text>
            </g>
          );
        })}

      {/* 道路 */}
      {board.edges.map((e) => {
        const road = state.roads[e.id];
        const legal = edgeLegal(e.id);
        return (
          <g
            key={`edge-${e.id}`}
            className={legal ? 'edge-hit' : undefined}
            onClick={legal ? () => onEdge(e.id) : undefined}
          >
            {road && (
              <g className="svg-pop">
                <line x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke="rgba(0,0,0,0.28)" strokeWidth={10} strokeLinecap="round" />
                <line
                  x1={e.x1}
                  y1={e.y1}
                  x2={e.x2}
                  y2={e.y2}
                  stroke={state.players[road.owner].color}
                  strokeWidth={7}
                  strokeLinecap="round"
                />
                <line x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke="rgba(255,255,255,0.4)" strokeWidth={2} strokeLinecap="round" />
              </g>
            )}
            {legal && (
              <line
                className="hit"
                x1={e.x1}
                y1={e.y1}
                x2={e.x2}
                y2={e.y2}
                stroke="rgba(255,255,255,0.4)"
                strokeWidth={9}
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
        const col = bld ? state.players[bld.owner].color : '';
        return (
          <g
            key={`v-${v.id}`}
            className={legal ? 'vertex-hit' : undefined}
            onClick={legal ? () => onVertex(v.id) : undefined}
          >
            {bld && bld.type === 'settlement' && (
              <g className="svg-pop" filter="url(#soft)" transform={`translate(${v.x}, ${v.y})`}>
                <rect x={-8} y={-1} width={16} height={11} rx={1.5} fill={col} stroke="#2c2014" strokeWidth={1.5} />
                <polygon points={`-10,-1 0,-11 10,-1`} fill={shade(col || '#999', 0.75)} stroke="#2c2014" strokeWidth={1.5} strokeLinejoin="round" />
                <rect x={-2.5} y={3} width={5} height={7} rx={1} fill="#2c2014" />
              </g>
            )}
            {bld && bld.type === 'city' && (
              <g className="svg-pop" filter="url(#soft)" transform={`translate(${v.x}, ${v.y})`}>
                <rect x={-11} y={-2} width={11} height={14} rx={1.5} fill={col} stroke="#2c2014" strokeWidth={1.5} />
                <rect x={-1} y={-11} width={12} height={23} rx={1.5} fill={shade(col || '#999', 0.85)} stroke="#2c2014" strokeWidth={1.5} />
                <polygon points={`-1,-11 5,-17 11,-11`} fill={shade(col || '#999', 0.7)} stroke="#2c2014" strokeWidth={1.5} strokeLinejoin="round" />
                <rect x={-8} y={2} width={4} height={4} fill="#fff6e2" />
                <rect x={2} y={-5} width={3.5} height={3.5} fill="#fff6e2" />
                <rect x={6.5} y={-5} width={3.5} height={3.5} fill="#fff6e2" />
                <rect x={2} y={2} width={3.5} height={3.5} fill="#fff6e2" />
                <rect x={6.5} y={2} width={3.5} height={3.5} fill="#fff6e2" />
              </g>
            )}
            {legal && (
              <circle
                className="hit"
                cx={v.x}
                cy={v.y}
                r={8}
                fill="rgba(255,255,255,0.65)"
                stroke="#fff"
                strokeWidth={2}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}
