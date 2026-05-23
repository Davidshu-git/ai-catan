// ============================================================
// 会话持久化：把 server 编排态旁路落 JSON 快照
// ------------------------------------------------------------
// 只负责 I/O 和 schema 守卫，不进入 shared/，不改 reducer 行为。
// 默认由 PERSIST=0 关闭；打开后写到 PERSIST_DIR/sessions/<room>.json。
// ============================================================

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  AiErrorEvent,
  AiThoughtEvent,
  SocialChatEvent,
  TradeChatClosedEvent,
  TradeChatMessageEvent,
  TradeChatStartedEvent,
} from '../shared/protocol';
import type { FullGame } from '../shared/types';
import type { AiAgentRuntime } from './agents/types';
import type { RelationshipLedger } from './social/relationshipLedger';

export const SNAPSHOT_SCHEMA_VERSION = 1;

export interface AiEventLogEntry {
  kind: 'thought' | 'error';
  data: AiThoughtEvent | AiErrorEvent;
}

export interface TradeEventLogEntry {
  kind: 'started' | 'message' | 'closed';
  data: TradeChatStartedEvent | TradeChatMessageEvent | TradeChatClosedEvent;
}

export interface AgentSnapshot {
  memory: string[];
  decisionCount: number;
  providerName: string;
  currentTurnGoal?: string;
  stance?: string;
}

export interface SessionSnapshot {
  schemaVersion: number;
  ts: number;
  roomId: string;
  version: number;
  game: FullGame;
  relationships: RelationshipLedger;
  agents: Record<number, AgentSnapshot>;
  flags: {
    aiProvider: string;
    aiHint: boolean;
    aiAutoplay: boolean;
    socialChatEnabled: boolean;
  };
  buffers?: {
    ai: AiEventLogEntry[];
    trade: TradeEventLogEntry[];
    social: SocialChatEvent[];
  };
}

export interface SessionPersistSource {
  version: number;
  game: FullGame;
  relationships: RelationshipLedger;
  agents: Record<number, AiAgentRuntime>;
  aiProvider: string;
  aiHint: boolean;
  aiAutoplay: boolean;
  socialChatEnabled: boolean;
  aiEvents: AiEventLogEntry[];
  tradeEvents: TradeEventLogEntry[];
  socialEvents: SocialChatEvent[];
}

export function persistEnabled(): boolean {
  return process.env.PERSIST === '1';
}

export function persistDir(): string {
  return path.resolve(process.cwd(), process.env.PERSIST_DIR ?? './.data');
}

export function persistDebounceMs(): number {
  const n = Number(process.env.PERSIST_DEBOUNCE_MS ?? 1500);
  return Number.isFinite(n) && n >= 0 ? n : 1500;
}

function safeRoomId(roomId: string): string {
  return roomId.replace(/[^a-zA-Z0-9_.-]/g, '_') || 'default';
}

export function snapshotPath(roomId: string): string {
  return path.join(persistDir(), 'sessions', `${safeRoomId(roomId)}.json`);
}

function agentSnapshot(agent: AiAgentRuntime): AgentSnapshot {
  return {
    memory: [...agent.memory],
    decisionCount: agent.decisionCount,
    providerName: agent.providerName,
    currentTurnGoal: agent.currentTurnGoal,
    stance: agent.stance,
  };
}

export function buildSnapshot(roomId: string, session: SessionPersistSource): SessionSnapshot {
  const agents: Record<number, AgentSnapshot> = {};
  for (const [id, agent] of Object.entries(session.agents)) {
    agents[Number(id)] = agentSnapshot(agent);
  }
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    ts: Date.now(),
    roomId,
    version: session.version,
    game: session.game,
    relationships: session.relationships,
    agents,
    flags: {
      aiProvider: session.aiProvider,
      aiHint: session.aiHint,
      aiAutoplay: session.aiAutoplay,
      socialChatEnabled: session.socialChatEnabled,
    },
    buffers: {
      ai: session.aiEvents,
      trade: session.tradeEvents,
      social: session.socialEvents,
    },
  };
}

export async function saveSnapshot(roomId: string, session: SessionPersistSource): Promise<void> {
  if (!persistEnabled()) return;
  const target = snapshotPath(roomId);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const data = JSON.stringify(buildSnapshot(roomId, session), null, 2);
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, target);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function isSnapshot(v: unknown): v is SessionSnapshot {
  if (!isObject(v)) return false;
  if (v.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return false;
  return (
    typeof v.roomId === 'string' &&
    typeof v.version === 'number' &&
    isObject(v.game) &&
    isObject(v.relationships) &&
    isObject(v.agents) &&
    isObject(v.flags)
  );
}

export function loadSnapshot(roomId: string): SessionSnapshot | null {
  if (!persistEnabled()) return null;
  const file = snapshotPath(roomId);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!isSnapshot(parsed)) {
      console.warn(`[persist] 快照 schema 不匹配或结构不完整，忽略：${file}`);
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn(`[persist] 读取快照失败，忽略：${file}`, err);
    return null;
  }
}
