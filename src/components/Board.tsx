// ============================================================
// SVG 棋盘渲染与交互
// ============================================================

import type { Board as BoardT, GameState } from '../game/types';
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

const PORT_LABEL: Record<string, string> = {
  wood: '木 2:1',
  brick: '砖 2:1',
  sheep: '羊 2:1',
  wheat: '麦 2:1',
  ore: '矿 2:1',
  any: '3:1',
};

export function Board({ board, state, mode, onVertex, onEdge, onHex }: Props) {
  const isSetup = state.phase === 'setup1' || state.phase === 'setup2';
  const p = state.current;

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
      <rect x={0} y={0} width={board.width} height={board.height} fill="var(--sea)" />

      {/* 港口标记 */}
      {board.vertices
        .filter((v) => v.port)
        .map((v) => (
          <g key={`port-${v.id}`}>
            <circle cx={v.x} cy={v.y} r={11} fill="#10283f" stroke="#5a86b0" strokeWidth={1.2} />
            <text
              x={v.x}
              y={v.y + 3}
              textAnchor="middle"
              fontSize={8.5}
              fill="#cfe6ff"
              fontWeight={700}
            >
              {PORT_LABEL[v.port!].split(' ')[0]}
            </text>
          </g>
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
            <polygon
              points={pts}
              fill={TERRAIN_COLOR[h.terrain]}
              stroke={legal ? '#fff' : '#0d1b2a'}
              strokeWidth={legal ? 3 : 2}
            />
            {h.number != null && (
              <g>
                <circle
                  cx={h.cx}
                  cy={h.cy}
                  r={17}
                  fill="#f3ead2"
                  stroke="#1d1d1d"
                  strokeWidth={0.6}
                />
                <text
                  x={h.cx}
                  y={h.cy + 1}
                  textAnchor="middle"
                  fontSize={15}
                  fontWeight={800}
                  fill={h.number === 6 || h.number === 8 ? '#c0392b' : '#1d1d1d'}
                >
                  {h.number}
                </text>
                {Array.from({ length: pips(h.number) }).map((_, i, arr) => (
                  <circle
                    key={i}
                    cx={h.cx - (arr.length - 1) * 2.6 + i * 5.2}
                    cy={h.cy + 11}
                    r={1.7}
                    fill={h.number === 6 || h.number === 8 ? '#c0392b' : '#1d1d1d'}
                  />
                ))}
              </g>
            )}
            {state.robber === h.id && (
              <g>
                <circle cx={h.cx + 18} cy={h.cy - 16} r={10} fill="#15151a" stroke="#000" />
                <text
                  x={h.cx + 18}
                  y={h.cy - 12}
                  textAnchor="middle"
                  fontSize={11}
                  fill="#fff"
                >
                  贼
                </text>
              </g>
            )}
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
              <line
                x1={e.x1}
                y1={e.y1}
                x2={e.x2}
                y2={e.y2}
                stroke={state.players[road.owner].color}
                strokeWidth={7}
                strokeLinecap="round"
              />
            )}
            {legal && (
              <line
                className="hit"
                x1={e.x1}
                y1={e.y1}
                x2={e.x2}
                y2={e.y2}
                stroke="rgba(255,255,255,0.35)"
                strokeWidth={9}
                strokeLinecap="round"
              />
            )}
          </g>
        );
      })}

      {/* 顶点（房屋 / 城市 / 可放置点） */}
      {board.vertices.map((v) => {
        const bld = state.buildings[v.id];
        const legal = vertexLegal(v.id);
        return (
          <g
            key={`v-${v.id}`}
            className={legal ? 'vertex-hit' : undefined}
            onClick={legal ? () => onVertex(v.id) : undefined}
          >
            {bld && bld.type === 'settlement' && (
              <polygon
                points={`${v.x},${v.y - 9} ${v.x + 8},${v.y - 1} ${v.x + 8},${v.y + 7} ${
                  v.x - 8
                },${v.y + 7} ${v.x - 8},${v.y - 1}`}
                fill={state.players[bld.owner].color}
                stroke="#0d1b2a"
                strokeWidth={1.5}
              />
            )}
            {bld && bld.type === 'city' && (
              <rect
                x={v.x - 9}
                y={v.y - 9}
                width={18}
                height={18}
                rx={3}
                fill={state.players[bld.owner].color}
                stroke="#0d1b2a"
                strokeWidth={1.5}
              />
            )}
            {legal && (
              <circle
                className="hit"
                cx={v.x}
                cy={v.y}
                r={8}
                fill="rgba(255,255,255,0.55)"
                stroke="#fff"
                strokeWidth={1.5}
              />
            )}
          </g>
        );
      })}

    </svg>
  );
}
