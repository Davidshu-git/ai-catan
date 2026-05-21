// ============================================================
// 棋盘几何与随机生成
// 指尖朝上(pointy-top)六边形，半径 2 → 19 块地块
// ============================================================

import type { Board, Hex, VertexGeo, EdgeGeo, Terrain, Port } from './types';

const SIZE = 58; // 六边形外接圆半径(px)
const PAD = 60;

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function hexCenter(q: number, r: number) {
  const x = SIZE * Math.sqrt(3) * (q + r / 2);
  const y = SIZE * 1.5 * r;
  return { x, y };
}

function corner(cx: number, cy: number, i: number) {
  const angle = (Math.PI / 180) * (60 * i - 30);
  return { x: cx + SIZE * Math.cos(angle), y: cy + SIZE * Math.sin(angle) };
}

/** 生成一张全新的随机棋盘 */
export function generateBoard(): Board {
  // 1) 轴向坐标列出 19 块地块
  const axials: { q: number; r: number }[] = [];
  for (let q = -2; q <= 2; q++) {
    for (let r = -2; r <= 2; r++) {
      const s = -q - r;
      if (Math.max(Math.abs(q), Math.abs(r), Math.abs(s)) <= 2) axials.push({ q, r });
    }
  }

  // 2) 地形与数字标记
  const terrainPool: Terrain[] = [
    ...Array(4).fill('木'),
    ...Array(3).fill('砖'),
    ...Array(4).fill('羊'),
    ...Array(4).fill('麦'),
    ...Array(3).fill('矿'),
    '沙漠',
  ];
  const terrains = shuffle(terrainPool);
  const numberPool = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];

  // 计算地块两两相邻关系（共享 2 个角点 → 相邻）
  const rawCenters = axials.map((a) => hexCenter(a.q, a.r));
  let minX = Infinity,
    minY = Infinity;
  rawCenters.forEach((c) => {
    minX = Math.min(minX, c.x - SIZE);
    minY = Math.min(minY, c.y - SIZE);
  });
  const offX = -minX + PAD;
  const offY = -minY + PAD;

  const hexes: Hex[] = axials.map((a, i) => {
    const c = hexCenter(a.q, a.r);
    const cx = c.x + offX;
    const cy = c.y + offY;
    const poly = Array.from({ length: 6 }, (_, k) => corner(cx, cy, k));
    return {
      id: i,
      q: a.q,
      r: a.r,
      terrain: terrains[i],
      number: null,
      cx,
      cy,
      corners: [],
      poly,
    };
  });

  // 3) 顶点去重（按四舍五入像素坐标）
  const vKey = (x: number, y: number) => `${Math.round(x)},${Math.round(y)}`;
  const vMap = new Map<string, VertexGeo>();
  const vertices: VertexGeo[] = [];

  for (const h of hexes) {
    for (let k = 0; k < 6; k++) {
      const p = h.poly[k];
      const key = vKey(p.x, p.y);
      let v = vMap.get(key);
      if (!v) {
        v = {
          id: vertices.length,
          x: p.x,
          y: p.y,
          hexes: [],
          neighbors: [],
          port: null,
        };
        vMap.set(key, v);
        vertices.push(v);
      }
      if (!v.hexes.includes(h.id)) v.hexes.push(h.id);
      h.corners[k] = v.id;
    }
  }

  // 4) 边去重
  const eKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const eMap = new Map<string, EdgeGeo>();
  const edges: EdgeGeo[] = [];

  for (const h of hexes) {
    for (let k = 0; k < 6; k++) {
      const v1 = h.corners[k];
      const v2 = h.corners[(k + 1) % 6];
      const key = eKey(v1, v2);
      if (!eMap.has(key)) {
        const a = vertices[v1];
        const b = vertices[v2];
        const e: EdgeGeo = {
          id: edges.length,
          v1,
          v2,
          x1: a.x,
          y1: a.y,
          x2: b.x,
          y2: b.y,
        };
        eMap.set(key, e);
        edges.push(e);
        if (!a.neighbors.includes(v2)) a.neighbors.push(v2);
        if (!b.neighbors.includes(v1)) b.neighbors.push(v1);
      }
    }
  }

  // 5) 数字标记：随机分配给非沙漠地块，尽量避免红色数字(6/8)相邻
  const nonDesert = hexes.filter((h) => h.terrain !== '沙漠');
  // 地块相邻表
  const adj = new Map<number, number[]>();
  for (const h of hexes) adj.set(h.id, []);
  for (let i = 0; i < hexes.length; i++) {
    for (let j = i + 1; j < hexes.length; j++) {
      const shared = hexes[i].corners.filter((c) => hexes[j].corners.includes(c));
      if (shared.length === 2) {
        adj.get(hexes[i].id)!.push(hexes[j].id);
        adj.get(hexes[j].id)!.push(hexes[i].id);
      }
    }
  }

  let best: number[] | null = null;
  let bestClash = Infinity;
  for (let attempt = 0; attempt < 80; attempt++) {
    const nums = shuffle(numberPool);
    const assign = new Map<number, number>();
    nonDesert.forEach((h, idx) => assign.set(h.id, nums[idx]));
    let clash = 0;
    for (const h of nonDesert) {
      const n = assign.get(h.id)!;
      if (n === 6 || n === 8) {
        for (const nb of adj.get(h.id)!) {
          const m = assign.get(nb);
          if (m === 6 || m === 8) clash++;
        }
      }
    }
    if (clash < bestClash) {
      bestClash = clash;
      best = nonDesert.map((h) => assign.get(h.id)!);
      if (clash === 0) break;
    }
  }
  nonDesert.forEach((h, idx) => {
    h.number = best![idx];
  });

  // 6) 港口：在外圈边上均匀放 9 个
  // 外圈边 = 只属于一个地块的边
  const edgeHexCount = new Map<number, number>();
  for (const h of hexes) {
    for (let k = 0; k < 6; k++) {
      const id = eMap.get(eKey(h.corners[k], h.corners[(k + 1) % 6]))!.id;
      edgeHexCount.set(id, (edgeHexCount.get(id) ?? 0) + 1);
    }
  }
  const boardCx = hexes.reduce((s, h) => s + h.cx, 0) / hexes.length;
  const boardCy = hexes.reduce((s, h) => s + h.cy, 0) / hexes.length;
  const perimeter = edges
    .filter((e) => edgeHexCount.get(e.id) === 1)
    .map((e) => {
      const mx = (e.x1 + e.x2) / 2;
      const my = (e.y1 + e.y2) / 2;
      return { e, ang: Math.atan2(my - boardCy, mx - boardCx) };
    })
    .sort((a, b) => a.ang - b.ang);

  const portTypes: Port[] = shuffle([
    '木',
    '砖',
    '羊',
    '麦',
    '矿',
    '通用',
    '通用',
    '通用',
    '通用',
  ]);
  const step = perimeter.length / 9;
  for (let i = 0; i < 9; i++) {
    const { e } = perimeter[Math.floor(i * step) % perimeter.length];
    const pt = portTypes[i];
    vertices[e.v1].port = pt;
    vertices[e.v2].port = pt;
  }

  let width = 0,
    height = 0;
  vertices.forEach((v) => {
    width = Math.max(width, v.x + PAD);
    height = Math.max(height, v.y + PAD);
  });

  return { hexes, vertices, edges, width, height };
}
