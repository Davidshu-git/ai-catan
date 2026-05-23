# 持久化与决策可观测性 设计文档（断线续盘 + trace 落盘/查询）

> 承接「AI 卡坦岛」当前形态（4 AI 观察局 + LLM 决策 + 社交房间）的两块基础设施缺口：
> **① 断线续盘 / 持久化**（server 重启状态全丢）与 **② 决策 trace 落盘 / 调试接口**（只有内存环形 buffer，不可查询、不落盘）。
> 二者本质同源——都是「把内存里的东西落到磁盘 + 重启后还能用回来 / 查得到」，故合并为一份设计。
>
> 范围声明：**身份绑定（player binding）不在本文范围**。当前处于调试期，刻意保持「任何 socket 都可介入当前玩家」的可操作状态，待真人正式入座再单独设计。

## 0. 一句话定位

> **`game`（权威态）+ 关系/记忆（编排态）落 JSON 快照 → 重启自动续盘；AI 决策 trace 追加写 JSONL + 只读 HTTP 查询接口。全是旁路，绝不碰 `reducer` 与 `shared/`。**

两块都做成**环境变量开关、默认关**，调试期零负担；需要时一键开。

---

## 1. 现状盘点（动手前的事实基线）

### 1.1 状态全在内存，重启即丢

`server/index.ts`：

- `const sessions = new Map<string, Session>()`（`:194`）——进程内存，无任何落盘。
- `getSession(roomId)`（`:196`）首次访问时 `createServerGame()` 新建，**没有「先查磁盘快照」这一步**。
- `Session` 结构（`:157`）字段可分三类（决定要不要持久化）：

| 类别 | 字段 | 持久化策略 |
|---|---|---|
| **权威态（必存）** | `game: FullGame`（board + state） | 存。单这一项就能续盘 |
| **编排态（值得存，丢了可惜不致命）** | `relationships`（恩怨账本）、`agents`（各 AI 的 `memory`/`decisionCount`/`providerName`）、`version`、`aiProvider`/`aiHint`/`aiAutoplay`/`socialChatEnabled` | 存 |
| **可观测 buffer（可选存）** | `aiEvents`/`tradeEvents`/`socialEvents` | 存则重启后前端补拉历史不断档 |
| **运行时句柄（必须重置，不能存）** | `aiTimer`(→null)、`aiBusy`/`socialBusy`(→false)、`humanTrade`(→null，在途谈判无法跨重启)、`tradeLedger`/`socialBudget`（每回合态，重建即可） | 不存，恢复时重置 |

> 关键观察：`game` / `relationships` / `agents.memory` 全是 `structuredClone` 友好的纯数据（无函数、无循环引用），**直接 `JSON.stringify` 可序列化**。`AiAgentRuntime` 的 `personality` 是确定性生成的，可不存、恢复时按 playerId 重建后再覆盖回 `memory`。

### 1.2 trace 只有内存环形 buffer，不可查不落盘

- 三个环形 buffer：`AI_EVENT_BUFFER=60` / `TRADE_EVENT_BUFFER=80` / `SOCIAL_EVENT_BUFFER=60`（`:97-99`），`pushAiEvent`/`pushTradeEvent`（`:337/344`）只 `push` 进内存数组并裁剪。
- 唯一对外出口是 socket 补拉（新连接在 `sync_state` 后补发历史事件）。**没有 HTTP 查询接口、不落盘、重启即清空。**
- `AiEventLogEntry`（`:146`）= `{ kind:'thought'|'error', data: AiThoughtEvent|AiErrorEvent }`；`AiThoughtEvent` **已携带 `modelContext`（完整模型输入）与 `timing`（各阶段耗时）**——这意味着 trace 落盘后即可离线做**成本 / 时延 / 失败输入**分析，无需额外埋点。
- HTTP 层只有一个 `createServer` handler（`:983`），仅响应 `GET /health`，其余 404。

### 1.3 落盘位置已天然就绪

`docker-compose.yml`：`catan-server` 已 bind-mount `.:/app`。**写到 `./.data/` 即落在宿主工作树**，容器重启/重建不丢（named volume 只用于 `node_modules`）。无需新增挂载，只需 `.gitignore` 掉 `.data/`。

---

## 2. 设计

### 2.1 断线续盘 / 持久化

#### 新增 `server/persist.ts`（纯 I/O，不进 `shared/`）

```ts
const SCHEMA_VERSION = 1;            // 快照结构版本；不匹配则丢弃重开，绝不崩
interface SessionSnapshot {
  schemaVersion: number;
  ts: number;
  roomId: string;
  version: number;                  // Session.version，用于诊断
  game: FullGame;                   // 权威态
  relationships: RelationshipLedger;
  agents: Record<number, { memory: string[]; decisionCount: number; providerName: string }>;
  flags: { aiProvider: string; aiHint: boolean; aiAutoplay: boolean; socialChatEnabled: boolean };
  buffers?: { ai: AiEventLogEntry[]; trade: TradeEventLogEntry[]; social: SocialChatEvent[] };
}

export function snapshotPath(roomId: string): string;          // `${PERSIST_DIR}/sessions/${roomId}.json`
export async function saveSnapshot(roomId: string, s: Session): Promise<void>;   // 原子写：tmp → rename
export function loadSnapshot(roomId: string): SessionSnapshot | null;            // 同步读，启动期一次
```

#### 接线（`server/index.ts`，全部旁路）

1. **恢复**：`getSession` 新建分支里，先 `loadSnapshot(roomId)`；命中且 `schemaVersion` 匹配 → 用快照重建 Session：
   - `game` / `relationships` 直接装载；
   - `agents = createAgentRuntimes(...)` 后把快照里的 `memory`/`decisionCount`/`providerName` 覆盖回去（personality 重新生成）；
   - **运行时句柄强制重置**：`aiTimer=null`、`aiBusy=false`、`socialBusy=false`、`humanTrade=null`、`tradeLedger`/`socialBudget` 重建；
   - `buffers` 有则装载（前端补拉不断档）。
   - 装载后 `version` 沿用快照值，避免在途异步 LLM 决策的版本判断错乱。
2. **保存**：在唯一的状态提交点 `applyAction`（`:324`，每次 `reduce` 后）触发**去抖保存**（debounce ~1.5s，盖过 ~460ms 的 AI tick，避免狂写）。AI↔AI 谈判 close、社交跃迁后也经此路径，无需额外接。
3. **优雅退出**：监听 `SIGTERM`/`SIGINT`，`await saveSnapshot` 后再退，吃掉「正好崩在去抖窗口内」的丢失。
4. **`new_game`**（`:1416`）：重置后立即覆盖写快照（旧局快照作废）。

#### 开关与配置（env，默认关）

| env | 默认 | 含义 |
|---|---|---|
| `PERSIST` | `0`（关） | 续盘总开关；调试期默认不写盘 |
| `PERSIST_DIR` | `./.data` | 快照 + trace 根目录（已在宿主 bind-mount 内） |
| `PERSIST_DEBOUNCE_MS` | `1500` | 状态变更后去抖保存间隔 |

> 续盘只对「单房间 `default`」生效即可，与现状一致；多房间是另一项缺口，本文不展开。

### 2.2 决策 trace 落盘 / 调试接口

#### 落盘：追加写 JSONL（append-only）

- 新增 `server/trace.ts`：`appendTrace(roomId, gameId, entry)`，把每条 `AiEventLogEntry`（含 `modelContext`+`timing`）**异步 `fs.appendFile` 追加一行 JSON** 到 `${PERSIST_DIR}/traces/${gameId}-ai.jsonl`（按 `gameId` 分文件，天然按局滚动）。
- 接在现有 `pushAiEvent` 之后（fire-and-forget，**绝不 `await`、绝不阻塞 `scheduleAI` 主循环**；写失败仅 `console.warn`）。
- 交易 / 社交 trace 同理可选落 `*-trade.jsonl` / `*-social.jsonl`，第一版可只落 AI。

#### 查询：扩展现有 HTTP handler（只读）

在 `createServer` handler（`:983`）的 `/health` 之后加只读 JSON 路由（复用内存 buffer，零新状态）：

| 方法 | 路径 | 返回 |
|---|---|---|
| `GET` | `/api/sessions` | 各房间摘要：`{ roomId, turn, phase, current, provider, version }[]` |
| `GET` | `/api/traces/ai?room=default&limit=N` | 最近 N 条 `aiEvents`（默认全 buffer） |
| `GET` | `/api/traces/trade?room=default&limit=N` | 最近 N 条 `tradeEvents` |
| `GET` | `/api/traces/social?room=default&limit=N` | 最近 N 条 `socialEvents` |

> 全文历史（超出 buffer）从 `traces/*.jsonl` 文件读，调试期直接 `cat`/`jq` 即可，无需第一版就做文件读接口。

#### 开关（env，默认关）

| env | 默认 | 含义 |
|---|---|---|
| `TRACE_FILE` | `0`（关） | JSONL 落盘开关 |
| `TRACE_HTTP` | `0`（关） | `/api/traces*` 查询接口开关（仅本地网络，**勿暴露公网**：modelContext 含完整 prompt） |

---

## 3. 文件改动清单

| 文件 | 改动 |
|---|---|
| `server/persist.ts` | **新增**：快照结构 + 原子读写（tmp→rename）+ schemaVersion 守卫 |
| `server/trace.ts` | **新增**：JSONL 追加写（异步、失败不抛） |
| `server/index.ts` | `getSession` 加恢复分支；`applyAction` 加去抖保存；`new_game` 覆盖写；`SIGTERM/SIGINT` 优雅落盘；`createServer` handler 加只读 `/api/*` 路由；`pushAiEvent` 后挂 `appendTrace` |
| `docker-compose.yml` | 可选：把 `PERSIST` / `TRACE_FILE` / `TRACE_HTTP` 加进注释清单（挂载已就绪，无需改 volume） |
| `.gitignore` | **新增** `.data/`（快照 + trace 不入库） |
| `.env.example` | 补 `PERSIST` / `PERSIST_DIR` / `TRACE_FILE` / `TRACE_HTTP` 说明 |
| `server/persistSmoke.ts` | **新增**：写快照→清 `sessions`→`loadSnapshot` 重建→断言 `game`/`relationships` 一致、资源恒 19 |
| `CLAUDE.md` | 落地后同步 socket/HTTP 协议与「已知缺口」清单 |

---

## 4. 红线与不变量（不可破）

- **纯旁路**：持久化与 trace **绝不碰游戏状态**；改状态只能经 `reduce`。续盘是「装载已有 `game`」，不是重算。
- **不进 `shared/`**：快照/trace 是 server 关注点，留在 `server/`；`shared/` 继续零 I/O、零 Node 依赖（`sim.ts` 触不到这两块，行为不变）。
- **reducer 契约不变**：不为续盘/trace 给 reducer 加任何 throw 或副作用。
- **资源恒 19**：续盘装载的 `game` 必须原样还原；`persistSmoke` 校验装载前后不变量一致。
- **不阻塞主循环**：trace 落盘 fire-and-forget；快照去抖异步；任何 I/O 失败只 `warn`，不影响对局推进。
- **运行时句柄不跨重启**：`aiTimer`/`aiBusy`/`humanTrade` 等恢复时一律重置，禁止把句柄/在途状态写进快照。
- **schema 不匹配宁可重开**：`schemaVersion` 对不上直接丢弃快照、`createServerGame()` 重来，绝不因旧快照崩溃。
- **trace 含 prompt，勿外泄**：`/api/traces*` 默认关、仅本地；`.data/` 必须 gitignore。

---

## 5. 分阶段落地（建议 PR 划分，互相独立、可回退）

- **Phase 1 — trace 查询接口（最便宜、零写盘风险）**
  仅扩展 `createServer` 加只读 `/api/sessions` + `/api/traces/*`，读现有内存 buffer。`TRACE_HTTP=1` 开。无新状态、无磁盘写。
  *产出：`curl localhost:3001/api/traces/ai | jq` 实时看 AI 决策（含 modelContext/timing），调 LLM 立刻有据可查。*

- **Phase 2 — trace JSONL 落盘**
  `server/trace.ts` + `pushAiEvent` 后异步追加。`TRACE_FILE=1` 开。超出 buffer 的历史可离线 `jq` 分析成本/时延。
  *产出：整局决策可回放、可统计 token 与各阶段耗时。*

- **Phase 3 — 断线续盘**
  `server/persist.ts` + `getSession` 恢复 + `applyAction` 去抖保存 + `SIGTERM` 落盘。`PERSIST=1` 开。
  *产出：25–40 分钟一局的 LLM 对战中途重启不再清零；恩怨账本与 AI 记忆延续。*

每个 Phase 独立可上线、可回退（对应 env 一关即恢复现状）。

---

## 6. 验证（每个 Phase 都跑）

```bash
# 双 typecheck —— 容器内
docker run --rm -v "$PWD":/app -w /app node:20-alpine \
  sh -c "npm install --no-fund --no-audit --silent && npm run typecheck && npm run typecheck:server"

# 续盘冒烟（Phase 3）：写快照→重建→断言一致 + 不变量
docker run --rm -v "$PWD":/app -w /app node:20-alpine npx --yes tsx server/persistSmoke.ts

# trace HTTP（Phase 1，需 stack 在跑）
curl -s http://localhost:3001/api/sessions | jq
curl -s 'http://localhost:3001/api/traces/ai?limit=5' | jq

# sim 不受影响（两块均为 server-only，sim 只跑 shared/ 内核）——回归确认即可
AI_PROVIDER=rule docker run --rm -e AI_PROVIDER=rule -v "$PWD":/app -w /app node:20-alpine npx --yes tsx sim.ts
```

- 持久化/trace **不应影响 sim 不变量**（资源恒 19、VP≤13、无死循环）——sim 触不到 server 这两块，但跑一遍确认未误碰内核。
- 容器内 `npm install` 会把 lockfile 写回宿主，跑完 `rm -f package-lock.json` 或提交前 `git status` 确认。
- 提交前确认 `.data/` 已被 gitignore，未误纳入。

---

## 7. 开放问题（动手前可拍板）

1. **快照频率**：去抖 1.5s 是保守起点；若磁盘写成瓶颈可改为「每 N 回合 + 退出时」存。
2. **trace 是否要交易/社交也落盘**：第一版只落 AI 决策足够调 LLM；社交/谈判 trace 可后补。
3. **`.jsonl` 滚动**：按 `gameId` 分文件天然滚动；长期跑需加按大小/天数清理（cron 或启动时清理 N 天前）。
4. **多房间续盘**：当前只 `default` 单房间；多房间是独立缺口，续盘按 `roomId` 分文件已为其留好结构。
