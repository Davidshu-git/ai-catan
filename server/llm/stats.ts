// ============================================================
// LLM 调用次数 / token 使用全局累计
// ------------------------------------------------------------
// MVP：单进程单 session（默认房间），用 module-level 状态聚合即可，不按 room/agent 拆分。
// 3 个 call 函数（callQwen / callMinimax / callLlm）在 HTTP 返回后调用 recordLlmUsage 上报；
// server/index.ts 注册一个 listener，每次有更新就 emitAiControl 把最新统计推给前端。
// 重启不持久化（接受归零）；new_game 主动调 resetLlmStats。
// ============================================================

export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface LlmStats {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

const stats: LlmStats = {
  calls: 0,
  promptTokens: 0,
  completionTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

let listener: (() => void) | null = null;

export function onLlmStatsChange(cb: (() => void) | null) {
  listener = cb;
}

export function getLlmStats(): LlmStats {
  return { ...stats };
}

export function resetLlmStats() {
  stats.calls = 0;
  stats.promptTokens = 0;
  stats.completionTokens = 0;
  stats.cacheReadTokens = 0;
  stats.cacheCreationTokens = 0;
  listener?.();
}

export function recordLlmUsage(usage: LlmUsage) {
  stats.calls += 1;
  if (usage.promptTokens) stats.promptTokens += usage.promptTokens;
  if (usage.completionTokens) stats.completionTokens += usage.completionTokens;
  if (usage.cacheReadTokens) stats.cacheReadTokens += usage.cacheReadTokens;
  if (usage.cacheCreationTokens) stats.cacheCreationTokens += usage.cacheCreationTokens;
  listener?.();
}
