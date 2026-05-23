# AI 社交房间 设计文档（常驻谈判 + 关系记忆 + 桌面政治）

> 本文是 [`ai-catan-llm-roadmap.md`](./ai-catan-llm-roadmap.md) 第三阶段"AI 谈判"的深化落地方案。
> 目标形态：把现在"以回合发起者为中心的星型双边谈判"演进为**常驻社交房间**——
> AI 之间能多轮互相反应、结盟/威胁/嘴炮，且交互结果写回关系记忆、影响后续决策。

## 0. 一句话定位

不是字面意义的"随时自由闲聊"（LLM 延迟扛不住），而是：

> **一条常驻的房间时间线 + 一套确定性关系账本 + 事件触发、预算封顶的社交发言。**

交易仍然只经 `TRADE_EXECUTE` 落到 `reduce`，社交层是旁路，绝不直接改游戏状态。

---

## 1. 现状盘点（动手前的事实基线）

### 1.1 现在是"星型顺序双边"，不是聊天室

`server/trading/negotiationManager.ts` `maybeRunAiNegotiation`：

- 只有**当前回合玩家**（initiator）能在 `main` 阶段开 session
- 发起者抛**一个**报价 → 各 participant **按固定顺序、每人一次** ACCEPT/REJECT/COUNTER
- 第一个 ACCEPT 即成交关闭；有人 COUNTER → 发起者回应一次（不能再还价）
- participant 之间**不互相反应**（共享 `history()`，但顺序确定、各只说一次）
- 限额：`{ sessionsPerTurn:2, messagesPerSession:8, offersPerSession:2, counterOffersPerSession:1, repliesPerPlayer:2 }`

### 1.2 人类与 AI 是两条平行谈判引擎（重要技术债）

| 路径 | 文件 | 入口 |
|---|---|---|
| AI 发起 ↔ AI | `server/trading/negotiationManager.ts` | `scheduleAI` 里调 `maybeRunAiNegotiation` |
| 人类发起 ↔ AI | `server/trading/humanTrade.ts` + `index.ts` 编排 | `human_trade_start/say/finalize/end` |

两套各有自己的 session 结构、限额、成交逻辑。**社交房间的一个顺带收益就是把它们合并成一套。**

### 1.3 基础设施已经 ~80% 是聊天室

协议层（`shared/protocol.ts`）几乎是按聊天室设计的，可直接复用：

- `TradeChatMessageEvent`：消息流，`speaker: number | null`（null=系统）
- `TradeDecisionEvent = PROPOSE | CHAT | ACCEPT | REJECT | COUNTER_OFFER | SYSTEM`（已含 `CHAT`）
- `TradeOfferEvent.to: number | null`：`null` = 向全场广播的开放报价
- `TradeLimitsEvent.repliesByPlayer` / `repliesMaxPerPlayer`：已是按人限流
- 服务端已有最近 80 条交易事件环形 buffer + 晚到客户端补拉
- 前端已有"交易谈判"tab 渲染这条消息流

### 1.4 Agent 运行时已具备记忆位

`server/agents/types.ts` `AiAgentRuntime`：`{ playerId, name, providerName, personality, memory: string[], decisionCount, currentTurnGoal, stance }`，`MAX_AGENT_MEMORY=12`。memory 已经被注入 prompt。**关系账本可作为 memory 之外的结构化补充。**

---

## 2. 延迟约束（Qwen 已大幅缓解，但护栏仍要在）

MiniMax 单次决策 15–25s 时，"多 AI 互相反应"几乎不可行。**实测 Qwen 3.6 单次 3–6s**，把这道墙基本拆了：`O(轮数 × 人数)` 的社交对话在 Qwen 下节奏可接受。

但"可接受"不等于"放任"——自由聊天最大的风险是 **token 用量突然暴增、控不住**。因此社交房间必须同时具备**硬预算**和**实时开关**：

**三条节流铁律：**

1. **社交发言只在白名单事件上触发**，绝不轮询"你想说话吗"
2. **"谁有资格开口"用规则门控**（零 LLM），不是再开一次模型调用去判断
3. **关系账本更新 100% 确定性**（零 LLM）；纯社交味道走便宜模型（qwen36）

**实时可控（用户明确要求，最高优先）：**

- 自由聊天**默认关闭**（`SOCIAL_CHAT=0`）。
- 提供**运行时开关** `set_social_chat`（socket 事件，像 `set_ai_autoplay`/`set_ai_hint` 那样），观察者可随时一键熄火，不必重启容器。
- 开关状态进 `AiControlState`，前端控制面板常显，token 一冒头就能立刻关。
- 关闭时：不再触发任何社交 LLM 调用；进行中的社交决策返回后作废（参照 autoplay 关闭时丢弃在途决策的做法）。

预算参数（建议初值，全部走环境变量可调）：

| 参数 | 初值 | 含义 |
|---|---|---|
| `SOCIAL_CHAT` | `0`（关） | 自由社交发言总开关；运行时可由 `set_social_chat` 覆盖 |
| `SOCIAL_LINES_PER_TURN` | 2 | 每个游戏回合全场社交发言上限（硬封顶） |
| `SOCIAL_COOLDOWN_TURNS` | 1 | 单个 agent 社交发言冷却回合数 |
| `SOCIAL_LINES_PER_GAME` | 40 | 整局社交发言总上限（兜底，防失控累积） |
| `ROOM_ROUNDS_MAX` | 2 | 一次交易 session 内"互相反应"的最大轮数 |
| `SOCIAL_PROVIDER` | `qwen36` | 社交味道默认走的便宜 provider |

> 注：关系账本（第 2 层）零 LLM，**不受 `SOCIAL_CHAT` 开关影响**，始终在后台累积；开关只管第 3 层的自由发言。

---

## 3. 架构：三层，从地基往上

```
第3层  事件触发社交发言（嘴炮/结盟/威胁）   ← 锦上添花，最贵
第2层  关系账本 relationshipLedger          ← 灵魂，零额外 LLM
第1层  统一房间引擎 roomManager（多轮）     ← 地基，顺手还债
─────────────────────────────────────────
        shared/reducer.ts（唯一状态权威，不动）
```

### 3.1 第 1 层：统一房间引擎（多轮 + 合并两条路径）

新增 `server/trading/roomManager.ts`，把 `negotiationManager.ts` 与 `humanTrade.ts` 合并：

```ts
type Participant =
  | { kind: 'ai'; player: number }
  | { kind: 'human'; player: number };

interface RoomSession {
  sessionId: string;
  turn: number;
  initiator: number;          // 可以是 AI 或人类
  participants: number[];
  currentOffer: TradeOfferEvent | null;
  messages: TradeChatMessageEvent[];
  stances: Record<number, ParticipantStance>;   // 复用 humanTrade 已有结构
  round: number;
  counters: SessionCounters;
  status: 'open' | 'closed';
  busy: boolean;
}
```

关键变化：
- **多轮**：把现在"每人回应一次"的单层 `for` 改为 `while (round < ROOM_ROUNDS_MAX && 仍有进展)`，每轮让上一轮**没成交**的 participant 看见别人的还价后再决策一次。
- **结算原子性**：每轮收集所有 ACCEPT/COUNTER，**择优只成交一笔**（开放报价时按 `participantScore` 取最优），其余作废；`dryRunTrade`→`TRADE_EXECUTE` 守住资源恒 19。
- **人类是一等参与者**：人类发言通过现有 `human_trade_say` 注入同一条 `messages`；AI 通过 `tradeDecide` 注入。两边共用 `closeAccepted` / `deriveStandingDeals`。

> 兼容：保留 `human_trade_*` 与 `propose_human_trade` 事件名作为入口，内部路由到 `roomManager`，前端无需大改。

### 3.2 第 2 层：关系账本（零额外 LLM，价值最高）

新增 `server/social/relationshipLedger.ts`。**纯服务端编排状态，不进 `shared/state.ts`**（与谈判状态同等定位）。

```ts
interface Relationship {
  trust: number;      // -100..100：公平成交↑，被坑/被偷↓
  threat: number;     // 0..100：对方逼近胜利 / 拿最长路最大军队↑
  debt: number;       // 有符号：谁欠谁人情（让利、答应又反悔）
  recent: string[];   // 最近 3~4 条交互摘要，给 prompt 用的自然语言
}

// session 级：opinion[viewer][target]
type RelationshipLedger = Record<number, Record<number, Relationship>>;
```

**确定性更新规则**（在 `index.ts` 每次 `reduce` 后 diff 新旧状态触发）：

| 触发 | 更新 |
|---|---|
| 公平成交（双方净值接近） | 双方 `trust += k` |
| 倾斜成交（一方明显占便宜） | 吃亏方对占便宜方 `trust -= k`、`debt` 记账 |
| 强盗落到我地块 / 偷我牌 | 我对操作者 `trust -= k`、`threat += k` |
| 有人拿下最长路 / 最大军队 | 全场对他 `threat += k` |
| 有人 `publicVP >= 8` | 全场对他 `threat += k`（领先者会被孤立） |
| 答应又反悔（第 3 层结盟食言） | `trust` 大幅下降、`debt` 记账 |

**喂给 prompt**：在 trade 决策 prompt 里塞一小段"你对各家的看法"，例如
`P1：信任偏低（上轮强盗砸你）；P2：可结盟（多次公平成交）；P3：警惕（已 8 分，最长路在手）`。
这一步**直接改变后续交易决策**（对头不给好价、联手压制领先者），就实现了"写回记忆影响后续"，且几乎免费。

### 3.3 第 3 层：事件触发的社交发言（桌面政治）

只在**白名单事件**触发，且**规则门控谁能开口**：

```ts
type SocialTrigger =
  | 'ROBBER_ON_ME' | 'STOLEN_FROM'
  | 'RIVAL_LONGEST_ROAD' | 'RIVAL_LARGEST_ARMY'
  | 'RIVAL_NEAR_WIN'      // publicVP >= 8
  | 'TRADE_CLOSED';       // 我参与的成交
```

流程（接在 `index.ts` `reduce` 后的 diff 检测里，不阻塞主 AI 循环）：

1. diff 新旧 state → 产出 `SocialTrigger[]`
2. 规则门控：只有**被该事件实质影响**的 agent 有资格说，且满足冷却 + 全场回合预算
3. 过门控者调一次 `SOCIAL_PROVIDER`（便宜模型）生成一句话（`decision: 'CHAT'`），可附带"我提议结盟压制 P3"之类意图
4. 发言 emit 成 `trade_chat_message`（`speaker=该玩家, decision='CHAT', offer 可空`），写入房间时间线
5. 若发言含可机器识别的意图（结盟/记仇），按规则同步更新关系账本

> 第 3 层是纯增量，可独立开关（`SOCIAL_CHAT=0` 完全关闭），不影响 1/2 层。

---

## 4. 协议变更（`shared/protocol.ts`）

尽量复用，最小新增：

- **复用** `TradeChatMessageEvent` 承载社交发言（`decision:'CHAT'`，`speaker` 为玩家、`offer` 省略）。
- **新增** `set_social_chat`（C→S，`{enabled:boolean}` + ack）：运行时开关自由聊天；关闭即作废在途社交决策。
- **扩展** `AiControlState`：加 `socialChatEnabled: boolean`，前端控制面板常显开关与状态。
- **新增（可选）** `RelationshipSnapshotEvent`：仅供观察者面板可视化关系账本（**不下发给会影响公平性的对象**——观察局全公开无所谓，未来隐私化推送时再裁剪）。
  ```ts
  interface RelationshipSnapshotEvent {
    ledger: Array<{ viewer: number; target: number; trust: number; threat: number; debt: number }>;
    ts: number;
  }
  ```
- 现有 `trade_chat_started/message/closed`、`human_trade_*` 事件名**保持不变**。

---

## 5. 文件改动清单

| 文件 | 改动 |
|---|---|
| `server/social/relationshipLedger.ts` | **新增**：账本结构 + 确定性更新规则 + prompt 文案生成 |
| `server/trading/roomManager.ts` | **新增**：统一多轮房间引擎（吸收 negotiationManager + humanTrade 编排） |
| `server/trading/negotiationManager.ts` | 收敛：核心逻辑迁入 roomManager，或保留为其薄封装 |
| `server/trading/humanTrade.ts` | 收敛：会话结构并入 roomManager，保留无副作用推导函数 |
| `server/llm/tradeProvider.ts` | 扩展：新增"社交发言生成"与"看法注入" prompt；接受关系账本上下文 |
| `server/agents/types.ts` | 可选：`AiAgentRuntime` 加 `lastSocialTurn` 字段做冷却 |
| `server/index.ts` | diff 检测触发器、关系账本注入、社交调度、统一房间接线、新事件广播 |
| `shared/protocol.ts` | 可选新增 `RelationshipSnapshotEvent` |
| `src/App.tsx` / `components/` | 谈判面板升级为常驻房间；可加关系账本小面板（**沿用墨线哥特风，勿做现代聊天软件风**） |
| `docs/ai-catan-llm-roadmap.md` | 同步状态 |

---

## 6. 红线与不变量（不可破）

- **社交层是旁路**：绝不碰游戏状态；改状态只能经 `TRADE_EXECUTE` → `reduce`。
- **资源恒 19**：多人同时接受时**原子地只成一笔**，其余作废；`sim.ts` 不变量照跑。
- **reducer 纯函数契约不变**：非法动作静默 no-op，不为社交加 throw。
- **关系账本不进 `shared/`**：与谈判状态同等，留在 server 内存（断线丢失可接受，与现状一致）。
- **App.tsx Hook 顺序铁律**：前端加面板若引入新 hook，必须在 `if (!game) return` 之前，肉眼复查。

---

## 7. 分阶段落地（建议 PR 划分）

按"价值最高 + 风险最低"优先，依赖顺序 A → B → C：

- **Phase A — 关系账本（独立、最便宜）✅ 已实现（2026-05-23）**
  `server/social/relationshipLedger.ts` + 确定性更新（成交记账 + 强盗/最长路/最大军队/逼近胜利 diff）+ 注入 4 个 trade prompt builder（initiate/propose/respond/chat）。不动谈判架构。
  接线：`Session.relationships`；3 个状态提交点（applyAction / AI step / 谈判 close）调 `applyTransition`；AI 成交（`acceptedTrade`）、人类 finalize、legacy propose 三处调 `applyTradeOutcome`；`agentPromptContextFor` 统一注入 viewer 视角看法。
  验证：双 typecheck 零错；`server/social/ledgerSmoke.ts` 专测账本（成交互信→可结盟、强盗→嫌隙、最长路→警惕、中立→空串）全过；sim rule 60/60、mock 59/60（1 局触 MAX_STEPS 上限属弱启发式变异、不变量失败 0），仅确认未碰坏 `shared/` 内核（sim 只跑内核、不经 server，**触不到账本**；Phase A 唯一 sim 可达改动是 `AgentPromptContext` 的可选字段，无运行时影响）。
  *产出：AI 气质随恩怨变化，对头/结盟苗头出现。*

- **Phase B — 多轮房间式谈判 ✅ 已实现（2026-05-23，AI↔AI 部分）**
  `negotiationManager.maybeRunAiNegotiation` 由"每人回应一次"改为多轮：参与方每轮看完整 history 互相反应、发起方每轮对最优还价回应一次、同轮多人接受时 `pickBestForInitiator` 竞争择优**原子只成交一笔**。`ROOM_ROUNDS_MAX`（默认 2）+ `messagesPerSession`（12）双重封顶 LLM 调用；预算放宽（counterOffers 4、repliesPerPlayer 3）支持多轮。
  验证：`server/trading/negotiationSmoke.ts`（竞争择优+守恒、还价成交、多轮反应）11 项全过；双 typecheck 零错；rule sim 60/60、不变量失败 0。
  *产出：AI 看到别人出价后再调整，房间感成型。*

- **Phase B.2 — 统一交易房间原语 ✅ 已实现（2026-05-23）**
  新增 `server/trading/roomCore.ts`，把 AI↔AI 与 人↔AI 两个引擎重复的资源/成交原语收敛为单一实现：`cloneRes` / `cloneOffer` / `resTotal` / `resStr` / `hasResources` / `resourceSignature` / **`dryRunTrade`（资源守恒不变量的唯一入口）**。`negotiationManager` 与 `humanTrade` 均改为消费 roomCore；`humanTrade` re-export 资源助手保持 `server/index.ts` 旧导入不变；`human_trade_*` / `propose_human_trade` 兼容入口不动，前端零改。
  **范围说明**：两个驱动的控制流本质不同（AI↔AI 同步多轮 vs 人↔AI 等人输入的交互式异步），强行合并为单一 driver 风险高、收益低，故**只统一原语、保留两个 driver**——这正是消除"守恒逻辑各写一份会漂移"这一真实债务的部分。
  验证：纯抽取无行为变化；negotiation/ledger/social 三冒烟全过；server typecheck 零错；rule sim 60/60、不变量失败 0。

- **Phase C — 事件触发社交发言 ✅ 后端已实现（2026-05-23）**
  `applyTransition` 回传 `RelationshipEvent[]`（强盗/最长路/最大军队/逼近胜利）；`server/social/socialChat.ts` 调度器按 **规则门控（对主角"威胁−信任"最高者发声）+ 冷却 + 每回合/整局硬预算** 挑人；`server/llm/socialProvider.ts` 生成话术（rule/mock 模板兜底、LLM 走便宜模型）。新增 `social_chat` / `relationship_state` 事件 + `set_social_chat` 开关 + `AiControlState.socialChatEnabled`。
  **熄火开关（用户要求）**：默认关（`SOCIAL_CHAT` 环境变量，默认 0）；`set_social_chat` 运行时切换；`maybeRunSocialChat` 每条发言前后查 `isEnabled()`，生成中途被关即丢弃；纯旁路不改游戏状态。
  验证：`server/social/socialChatSmoke.ts` 8 项全过（默认关→0、单事件→1、每回合封顶、整局封顶、冷却、运行中熄火）；双 typecheck 零错；rule sim 60/60。
  *产出：桌面政治、嘴炮、临时同盟压制领先者。*

- **前端 — 社交房间渲染 + 开关 ✅ 已实现（2026-05-23）**
  `App.tsx` 接 `social_chat` / `relationship_state`，新增「社交房间」侧栏 tab：`RoomContent`（社交发言时间线，按颜色/类型/对象渲染）+ `RelationshipMatrix`（行对列看法的信任绿/警惕红色块矩阵）。`AiControls` 加「社交聊天：开🔥/关」按钮 → `set_social_chat`，常显状态、随时熄火。新局以 gameId 变化清空社交流/关系快照。沿用墨线哥特风（`src/styles.css` 新增 `.room-tab` 等）。遵守 Hook 顺序铁律（新 useState 在 early return 前）。
  验证：前端 typecheck + `vite build` 均通过（build 的 rollup musl 报错为 npm 可选依赖 bug，装上 `@rollup/rollup-linux-x64-musl` 后构建通过）。

每个 Phase 独立可上线、可回退（环境变量开关）。

---

## 8. 验证（每个 Phase 都跑）

```bash
# 双 typecheck
docker run --rm -v "$PWD":/app -w /app node:20-alpine \
  sh -c "npm install --no-fund --no-audit --silent && npm run typecheck && npm run typecheck:server"

# 关系账本冒烟（Phase A）：sim 触不到账本，必须单独跑这个
docker run --rm -v "$PWD":/app -w /app node:20-alpine npx --yes tsx server/social/ledgerSmoke.ts

# sim 压测两个 provider（任何动 actionCatalog / fingerprint / 成交路径的改动都跑两遍）
AI_PROVIDER=rule docker run --rm -e AI_PROVIDER=rule -v "$PWD":/app -w /app node:20-alpine npx --yes tsx sim.ts
AI_PROVIDER=mock docker run --rm -e AI_PROVIDER=mock -v "$PWD":/app -w /app node:20-alpine npx --yes tsx sim.ts
```

- 关系账本/社交层**不应影响 sim 不变量**（资源恒 19、VP≤13、无死循环）——sim 走 rule/mock，不触发 LLM 社交，但成交路径若改了必须复跑。
- 容器内 `npm install` 会把 lockfile 写回宿主，跑完 `rm -f package-lock.json` 或提交前 `git status` 确认。

---

## 9. 开放问题（动手前需拍板）

1. **关系账本要不要可视化给观察者？** 观察局全公开建议加个小面板（很有看点）；未来人类入座做隐私化推送时再裁剪。
2. **结盟是否需要"约束力"？** 第一版建议结盟仅影响 prompt 倾向（软约束），不引入新的状态机机制；食言只扣 `trust`。
3. **社交发言用哪个模型？** 建议味道走 qwen36（便宜快），交易算账留强模型；provider 已支持按席位切换。
4. **多轮 vs 成本上限如何平衡？** `ROOM_ROUNDS_MAX=2` 是保守起点，观察实际时延再调。
