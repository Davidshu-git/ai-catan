// ============================================================
// AI 决策 trace 落盘：append-only JSONL
// ------------------------------------------------------------
// 默认 TRACE_FILE=0 关闭。打开后每条 ai_thought/ai_error 追加一行，
// 写失败只告警，不阻塞 AI 主循环。
// ============================================================

import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

import type { AiEventLogEntry } from './persist';

export function traceFileEnabled(): boolean {
  return process.env.TRACE_FILE === '1';
}

export function traceHttpEnabled(): boolean {
  return process.env.TRACE_HTTP === '1';
}

function traceDir(): string {
  return path.join(path.resolve(process.cwd(), process.env.PERSIST_DIR ?? './.data'), 'traces');
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_') || 'unknown';
}

export async function appendAiTrace(
  roomId: string,
  gameId: string,
  entry: AiEventLogEntry,
): Promise<void> {
  if (!traceFileEnabled()) return;
  try {
    const dir = traceDir();
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${safeFilePart(gameId)}-ai.jsonl`);
    const line = JSON.stringify({ ts: Date.now(), roomId, gameId, entry });
    await appendFile(file, `${line}\n`, 'utf8');
  } catch (err) {
    console.warn('[trace] 写 AI trace 失败:', err);
  }
}
