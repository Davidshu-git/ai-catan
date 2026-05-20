# AI 卡坦岛 LLM 演进计划

本文档用于承接当前已完成的前后端分离架构，规划后续“可观察的 AI 卡坦岛”实现路径。目标是让多名 AI 能在同一局卡坦岛中决策、交易、展示思考过程，同时保留人类玩家参与能力。

## 总体原则

- `shared/` 继续只放纯函数游戏内核，不接 LLM、不接网络、不依赖 Node 或 DOM。
- `server/` 持有权威状态，负责 AI 调度、LLM 调用、动作校验、交易谈判和事件广播。
- `src/` 前端只负责渲染、转发人类动作、展示 AI 思考日志和交易聊天。
- 不修改 `reducer.ts` “非法动作静默 no-op”的契约。服务端在 reducer 外层实现 Maker-Checker。
- 短期支持规则 AI / Mock LLM / 真实 LLM 混用，避免一开始就把整套系统绑定到单一模型供应商。
- 所有最终改变游戏状态的行为都必须落到现有 `Action`，并经由 `reduce(board, state, action)` 执行。

## 第二阶段：LLM Controller

目标：让后端能够把当前棋局翻译成大模型能理解的输入，并安全接收大模型返回的决策。

### 2.1 新增服务端 LLM 控制层

建议新增目录：

```text
server/llm/
  types.ts              LLM 输入输出、思考日志、控制器接口
  stateTranslator.ts    Board + State -> 当前玩家视角
  actionCatalog.ts      当前玩家当前阶段的合法动作枚举
  actionChecker.ts      JSON 解析、白名单校验、dry-run reducer 校验
  ruleBasedProvider.ts  把现有 aiNextAction 包成 Provider
  mockLlmProvider.ts    本地假 LLM，便于无 API 调试
  llmProvider.ts        后续接真实模型 API
```

核心接口建议：

```ts
export interface AiDecisionProvider {
  decide(input: LlmDecisionInput): Promise<LlmDecisionOutput>;
}
```

这样 `scheduleAI()` 只依赖统一的 Provider 接口，后续可以按玩家配置不同 AI：

- 规则 AI
- Mock LLM
- 真实 LLM
- 混合模式：普通局面用规则 AI，关键局面用 LLM

### 2.2 状态翻译器

不要把完整 `FullGame` 原样塞给 LLM。LLM 输入应是“当前玩家视角”的精简 JSON。

建议包含：

- 当前玩家编号、阶段、回合数、骰子状态。
- 当前玩家资源、建筑、发展卡、港口、公开分和总分。
- 其他玩家公开信息：公开 VP、道路/房屋/城市数量、资源总数、发展卡数量。
- 地图摘要：hex id、地形、数字、强盗位置。
- 当前阶段说明。
- 当前可执行动作列表。

关键设计：让 LLM 从服务端生成的合法动作列表中选择 `actionId`，不要让它自由编坐标和动作参数。

示例输入：

```json
{
  "phase": "main",
  "player": 2,
  "resources": { "wood": 2, "brick": 1, "wheat": 0 },
  "legalActions": [
    {
      "id": "build-road-e17",
      "label": "在边 e17 建路",
      "action": { "type": "BUILD_ROAD", "edge": 17 }
    },
    {
      "id": "end-turn",
      "label": "结束回合",
      "action": { "type": "END_TURN" }
    }
  ]
}
```

建议 LLM 输出：

```json
{
  "thought": "我现在有木和砖，可以向 6 点麦田方向扩张，优先建路。",
  "actionId": "build-road-e17"
}
```

### 2.3 合法动作目录

优先实现 `actionCatalog.ts`。它负责根据 `board + state + currentPlayer` 产出当前可选动作。

第一版覆盖现有阶段即可：

- `setup1` / `setup2`：可建定居点、可接续建路。
- `roll`：掷骰、可用骑士卡。
- `discard`：可弃牌组合，第一版可先给规则 AI 兜底。
- `moveRobber` / `steal`：可移动强盗位置、可偷取对象。
- `main`：建路、建房、建城、买发展卡、银行交易、出发展卡、结束回合。

注意：动作目录要尽量复用 `shared/rules.ts` 里的判定函数，不要在服务端复制一套规则。

### 2.4 Maker-Checker

服务端动作校验分三层：

1. JSON schema 校验：必须有 `thought: string` 和 `actionId: string`。
2. 白名单校验：`actionId` 必须存在于本次 `legalActions`。
3. dry-run reducer 校验：复制当前 state，调用 `reduce(board, state, action)`，再对比状态指纹。若状态完全没变，判定为无效动作。

不要让 `reducer.ts` 抛异常，也不要改变它的静默 no-op 契约。

### 2.5 重试与兜底

每次 AI 决策流程：

```text
生成玩家视角
生成合法动作列表
调用 Provider
解析输出
校验 actionId
dry-run reducer
成功：广播 ai_thought，applyAction
失败：把错误、合法动作、上次输出反馈给 Provider，最多重试 2-3 次
仍失败：fallback 到规则 AI 或 END_TURN
```

兜底策略必须明确：

- JSON 解析失败：重试。
- 选择非法 actionId：重试。
- dry-run 无状态变化：重试。
- LLM 超时：fallback 规则 AI。
- 连续失败：`END_TURN`。
- 状态指纹连续不变过多：沿用当前 `scheduleAI()` 的强制 `END_TURN` 保护。

### 2.6 改造 `scheduleAI()`

当前 `server/index.ts` 中的 `scheduleAI()` 是接入点。

改造后流程：

```text
scheduleAI()
  -> 判断当前玩家是否 AI
  -> AiController.decide()
  -> 广播 ai_thought / ai_error
  -> applyAction()
  -> sync_state
  -> 递归 scheduleAI()
```

新增 Socket 事件：

| 方向 | 事件 | payload | 说明 |
|---|---|---|---|
| S -> C | `ai_thought` | `{player, phase, thought, actionId?, action?, status}` | AI 决策思考流 |
| S -> C | `ai_error` | `{player, message, rawOutput?}` | LLM 输出非法、重试或 fallback 信息 |

新增事件后同步更新 `AGENTS.md` / `CLAUDE.md` 内的 Socket 协议表。

## 第三阶段：交易子系统

目标：让 LLM AI 之间可以自然语言谈判，但主游戏状态仍由 reducer 结算。

### 3.1 服务端交易编排层

建议新增：

```text
server/trading/
  types.ts
  negotiationManager.ts
  tradeMessageParser.ts
  tradeSettlement.ts
```

谈判状态暂时只放在 server 内存，不进入 `shared/state.ts`：

```ts
export type NegotiationSession = {
  id: string;
  initiator: PlayerId;
  participants: PlayerId[];
  status: 'open' | 'accepted' | 'rejected' | 'expired';
  messages: TradeChatMessage[];
  proposedTrade: TradeOffer;
};
```

交易谈判属于服务端编排，不建议第一版就把它塞进 `shared/reducer.ts` 的主状态机。

### 3.2 结构化交易优先

自然语言用于展示，结构化字段用于结算。第一版不要只解析自然语言。

建议交易响应格式：

```json
{
  "message": "我愿意给你 1 个木头，但我要 1 个砖。",
  "decision": "COUNTER_OFFER",
  "offer": {
    "from": 1,
    "to": 2,
    "give": { "wood": 1 },
    "receive": { "brick": 1 }
  }
}
```

支持的 `decision`：

- `ACCEPT`
- `REJECT`
- `COUNTER_OFFER`

### 3.3 谈判流程

当某个 AI 决策输出发起交易意图时：

```text
主 AI 循环暂停
创建 NegotiationSession
广播 trade_chat_started
并发询问其他 AI
广播每条 trade_chat_message
若有人 ACCEPT：dry-run TRADE_EXECUTE，成功则结算
若有人 COUNTER_OFFER：发起者再判断接受/拒绝
超时或全拒绝：关闭谈判
广播 trade_chat_closed
恢复主 AI 循环
```

交易结算必须最终走已有动作：

```ts
{ type: 'TRADE_EXECUTE', ... }
```

结算前仍要做资源校验和 dry-run reducer 校验。

### 3.4 人类参与交易室

当前已有两条交易路径：

- 人类 -> AI：`propose_human_trade`
- AI -> 人类：`OFFER_TRADE` + `RESPOND_TRADE`

后续可以统一到谈判系统：

| 方向 | 事件 | 说明 |
|---|---|---|
| S -> C | `trade_chat_started` | 新谈判开始 |
| S -> C | `trade_chat_message` | AI 或人类发言 |
| C -> S | `human_trade_message` | 人类参与谈判 |
| C -> S | `human_trade_response` | 接受 / 拒绝 / 还价 |
| S -> C | `trade_chat_closed` | 谈判结束 |

建议分两步做：

1. 第一版只让人类旁观 AI 互聊。
2. 第二版允许人类加入谈判、接受、拒绝、还价。

## 第四阶段：前端 UI 升级

目标：让玩家看到 AI “怎么想、怎么聊、怎么玩”。

### 4.1 Thought Log 面板

在 `src/App.tsx` 中维护思考日志：

```ts
const [thoughtLog, setThoughtLog] = useState<AiThoughtEvent[]>([]);
```

监听：

```ts
socket.on('ai_thought', ...);
socket.on('ai_error', ...);
```

展示内容：

- 玩家编号、颜色或头像。
- 当前阶段。
- `thought` 文本。
- 选择的 `actionId` 和动作摘要。
- 成功、重试、fallback、错误状态。

注意 `App.tsx` 的 Hook 顺序约束：新增的 `useState` / `useEffect` 必须放在 `if (!game) return ...` 之前。

### 4.2 Trade Chat 面板

监听：

```ts
socket.on('trade_chat_started', ...);
socket.on('trade_chat_message', ...);
socket.on('trade_chat_closed', ...);
```

展示内容：

- 谈判发起者。
- 每个 AI 的自然语言回复。
- `ACCEPT` / `REJECT` / `COUNTER_OFFER` 标识。
- 最终成交或流局结果。

视觉风格沿用当前“手绘墨线 + 去饱和阴郁的哥特插画风”，不要做成现代聊天软件风格。

### 4.3 棋盘动作联动

收到 `ai_thought` 后，前端可以短暂高亮对应棋盘元素：

- 建路边。
- 建房点。
- 建城点。
- 强盗目标 hex。
- 被交易玩家。
- 银行交易资源。

这一步不影响核心逻辑，但对“观察 AI 游玩”价值很高。

## 第五阶段：稳定性与调试工具

目标：避免 LLM 接入后出现卡死、乱输出、成本失控、难复现。

### 5.1 决策记录

服务端保留最近 N 条 AI 决策：

```ts
export type AiDecisionTrace = {
  player: PlayerId;
  phase: Phase;
  inputSummary: unknown;
  rawOutput: string;
  parsedOutput?: LlmDecisionOutput;
  acceptedAction?: Action;
  error?: string;
  retries: number;
  timestamp: number;
};
```

第一版存在内存即可，后续可以落盘或提供调试接口。

### 5.2 Mock 模式优先

不要一开始用真实 LLM 跑压测。先让 Mock Provider 从 `legalActions` 中选择动作，确保完整链路稳定。

建议支持环境变量：

```bash
AI_PROVIDER=rule
AI_PROVIDER=mock
AI_PROVIDER=llm
```

第一阶段验证顺序：

```bash
AI_PROVIDER=rule  npx tsx sim.ts
AI_PROVIDER=mock  npx tsx sim.ts
AI_PROVIDER=llm   npx tsx sim.ts
```

真实 LLM 模式先少量跑局，稳定后再扩大。

### 5.3 验证命令

本项目要求一律在容器内跑验证。

改动 `shared/` 或核心 AI 流程后：

```bash
docker run --rm -v "$PWD":/app -w /app node:20-alpine \
  sh -c "npm install --no-fund --no-audit --silent && npm run typecheck && npm run typecheck:server"
```

```bash
docker run --rm -v "$PWD":/app -w /app node:20-alpine npx --yes tsx sim.ts
```

若验证命令产生 `package-lock.json`，提交前删除或确认没有误纳入。

## 推荐实施顺序

1. 实现 `server/llm/actionCatalog.ts`，先枚举当前阶段合法动作。
2. 实现 `server/llm/stateTranslator.ts`，输出当前玩家视角 JSON。
3. 实现 `server/llm/mockLlmProvider.ts`，从合法 `actionId` 中选择动作并生成假 thought。
4. 实现 `server/llm/actionChecker.ts`，完成 JSON 校验、白名单校验和 dry-run reducer 校验。
5. 改造 `server/index.ts` 的 `scheduleAI()`，从直调 `aiNextAction` 切到 `AiDecisionProvider`。
6. 增加 `ai_thought` / `ai_error` Socket 事件。
7. 在前端增加 Thought Log 面板，先展示 AI 思考和动作摘要。
8. 接入真实 LLM Provider，并加入超时、重试、fallback。
9. 增加 `server/trading/negotiationManager.ts`，实现 AI 之间结构化谈判。
10. 增加 Trade Chat 面板，展示谈判过程。
11. 扩展人类参与谈判：发言、接受、拒绝、还价。
12. 增加决策记录、调试接口和更细的压测模式。

## 关键技术取舍

最重要的取舍是：LLM 不直接生成任意 `Action`，而是从服务端生成的 `legalActions` 中选择 `actionId`。

这样可以同时满足三件事：

- LLM 可以输出可展示的 `thought`，方便前端观察 AI 决策过程。
- 服务端仍然是唯一状态权威，所有动作最终经由 reducer。
- 可以显著降低模型乱编坐标、乱填资源、破坏状态机的概率。

交易系统也遵循同样原则：自然语言负责氛围和可观察性，结构化字段负责结算，最终仍然派发受控的 `TRADE_EXECUTE` 动作。
