# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

卡坦岛（Catan）Web 联机版：当前默认是 **4 个独立 AI Agent 观察局**（前端作为观察/控制台；后续再接人类玩家加入席位）。**前后端分离**：React + TypeScript + Vite 前端 + Node.js + socket.io 后端，共用 `shared/` 下的纯函数游戏内核；状态由后端持有并通过 WebSocket 推送给前端。源码与注释均为中文，沿用此约定。

> 架构演进背景：本项目最初是纯前端单机版（reducer 跑在浏览器、AI 也在浏览器循环）。2026-05-20 完成前后端分离改造，把上帝视角状态与 AI 驱动搬到 Node 后端，**目的是为后续"AI 接入 LLM 调度"与"AI 决策思考流可视化"打地基**。`shared/` 这层被前后端同时引用，是这次重构的关键。

## Commands

**一律在容器中跑，不要用宿主机本地环境**（宿主机不装 Node 工具链；本仓库**故意不提交 `package-lock.json`**，容器构建用 `npm install` 而非 `npm ci`）。

```bash
# 起停：单一栈，热加载（Vite HMR + tsx watch），前端 → http://<host>:8088
# 改 src/ 浏览器自动热更；改 server/ 或 shared/ 后端自动重启；node_modules 用 named volume 持久化
docker compose up -d
docker compose logs -f
docker compose down

# 类型检查（前端 + 后端）—— 容器内
docker run --rm -v "$PWD":/app -w /app node:20-alpine \
  sh -c "npm install --no-fund --no-audit --silent && npm run typecheck && npm run typecheck:server"

# 自动对局压测（事实上的测试套件，见下）—— 容器内
docker run --rm -v "$PWD":/app -w /app node:20-alpine npx --yes tsx sim.ts

# 服务端冒烟（连后端 socket，验证 sync_state / new_game 链路）—— 容器内、需 stack 在跑
docker run --rm --network catan_default -v "$PWD":/app -w /app node:20-alpine \
  sh -c "npm install --no-fund --no-audit --silent && npx tsx server/smoke.ts http://catan-server:3001"
```

> ⚠️ 容器内 `npm install` 会把 lockfile 写回宿主工作树（volume 挂载副作用）。每次跑完手工 `rm -f package-lock.json`，或在提交前用 `git status --short` 确认未被误纳入；不要 `git add .`。

### 内网反代入口

局域网域名入口为 `http://catan.home.arpa/`，DNS / hosts 需把 `catan.home.arpa` 指向反代容器的 macvlan IP `192.168.100.178`。宿主机本身通常不能直接访问这个 macvlan IP，这是 Docker macvlan 的正常限制；可从局域网其他设备访问，或在 `rproxy-caddy` 容器内用 `Host: catan.home.arpa` 验证。

反代配置不在本仓库，而在相邻项目 `/volume1/server/.openclaw/workspace/projects/reverse-proxy`：
- `Caddyfile`：`http://catan.home.arpa { reverse_proxy catan:5173 }`
- `docker-compose.yml`：`rproxy-caddy` 需要挂入外部网络 `catan_default`，否则不能按容器名访问 `catan:5173`
- 改完反代后在 reverse-proxy 项目内执行 `docker compose up -d`

Vite dev server 有 Host 白名单保护。通过 `catan.home.arpa` 反代访问时，`vite.config.ts` 的 `server.allowedHosts` 必须包含 `catan.home.arpa`，否则 Caddy 能转到前端容器但 Vite 会返回 `403 Forbidden`。

站点 favicon 位于 `public/favicon.ico`、`public/favicon-32x32.png`、`public/apple-touch-icon.png`，`index.html` 用带版本号的绝对路径引用。若浏览器仍显示旧图标，优先考虑浏览器或反代缓存。

无 lint、无单元测试框架。**`sim.ts` 是事实上的测试**：跑 60 局全 AI 对战，逐步校验不变量（每种资源 bank+玩家恒为 19、资源非负、VP ≤ 13）、检测死循环（状态指纹 600 步不变即失败），有问题 `exit 1`。改动 `shared/` 任何文件后都应在容器内跑一遍 typecheck + sim。

已验证基线（2026-05-20，容器内）：`tsc --noEmit`（前端 + 后端）零错误；压测 60/60 局正常结束、不变量失败 0、无死循环、平均约 130 回合；docker compose 起 stack 后 socket 冒烟通过。

## Architecture

### 目录布局

```
shared/                ← 纯函数游戏内核：前后端共用，不依赖 DOM / Node 任何运行时
  types.ts             包含 Resource/Terrain/Phase/Action 等所有领域类型 + 常量
  board.ts             generateBoard()：一次性生成 hex/vertex/edge/port 几何
  state.ts             createGame()：初始状态（含 PLAYER_ART_COLORS — 玩家颜色单一来源）
  rules.ts             无副作用判定与计分（canBuild* / tradeRatio / publicVP / totalVP 等）
  reducer.ts           reduce(board, state, action) — 唯一可变入口（structuredClone 复制）
  ai.ts                aiNextAction（轮到该玩家时的下一动作） + aiAcceptsTrade（接受人类报价?）
  protocol.ts          socket 事件 DTO：AiThoughtEvent / AiErrorEvent（前后端共用的"过线"类型）

server/                ← Node + socket.io 后端，持有上帝视角状态、驱动 AI、广播变更
  index.ts             socket.io 服务 + sessions Map（MVP 单房间）；scheduleAI 走 LLM controller
  persist.ts           PERSIST=1 时落 JSON 会话快照，重启自动续盘（server-only 旁路）
  trace.ts             TRACE_FILE=1 时把 AI 决策事件追加写 JSONL
  persistSmoke.ts      持久化冒烟：写快照→读快照→校验 agent 与资源守恒
  agents/              每个 AI 玩家独立 runtime（性格、短期记忆、provider 配置）
  smoke.ts             端到端冒烟脚本：连接→收 sync_state/ai_thought
  llm/                 LLM 决策层（Provider 抽象 + Maker-Checker）
    types.ts           AiDecisionProvider 接口、LegalAction、LlmDecisionInput/Output
    actionCatalog.ts   按 phase + current 枚举合法动作（不含 OFFER_TRADE、不含 discard）
    stateTranslator.ts board+state → 当前玩家视角的精简 JSON（裁掉他人隐藏信息）
    actionChecker.ts   三层校验：JSON schema → 白名单 actionId → dry-run reducer 状态指纹
    ruleProvider.ts    包 aiNextAction → 反查 actionId；同时充当 LLM 失败的兜底 Provider
    mockProvider.ts    按优先级（建城 > 房屋 > 路 > 买卡 > 银行兑换 > 发展卡 > END_TURN）选 actionId
    modelRegistry.ts   LLM 模型注册表（单一事实来源）：key/label/api 形态/model/endpoint/apiKeyEnv/别名；buildProvider、callLlm、前端选项、别名归一全从此派生。加/停模型只动这里
    llmProvider.ts     anthropic 兼容 adapter（裸 fetch + JSON 严格输出 + 多策略解析）。原 MiniMax 用；MiniMax 已退役但 adapter 保留给后续 anthropic 形态模型
    qwenProvider.ts    openai 兼容 adapter；阿里 Qwen（qwen3.6-plus 默认，当前默认 LLM）+ DeepSeek V4 Flash 复用同一 adapter，按 labelPrefix 区分 provider 名
    controller.ts      decideAiStep：编排 catalog → view → provider → check → apply，含重试 + fallback
  llmSmoke.ts          单次 LLM 调用冒烟（不走游戏循环，仅验证 API 链路）
  Dockerfile           生产镜像（node:20-alpine + tsx 直跑 TS）
  tsconfig.json        独立 TS 配置（include shared/ + server/）

src/                   ← Vite + React 前端，纯渲染 + 通过 socket 转发用户动作
  App.tsx              模块级 socket = io(...)，game = useState<FullGame | null>(null)
  components/Board.tsx SVG 棋盘 + 交互
  art/theme.ts         美术资源 / 调色（PLAYER_ART_COLORS re-export 自 shared/state.ts）
  vite-env.d.ts        import.meta.env 类型（VITE_SERVER_URL）

sim.ts                 ← 无头压测，直接 import shared/，跑 60 局全 AI
docker-compose.yml     ← 两个服务：catan-server（后端 tsx watch）+ catan（前端 Vite dev，宿主端口 8088）
```

### 数据流（重要）

```
观察者点击 AI 控制 → set_ai_autoplay / step_ai
                                  ↓
                  server: scheduleAI(...) 按当前玩家取独立 Agent runtime
                                  ↓
                  Agent personality + memory + playerView + legalActions → Provider
                                  ↓
                          AI 该动 → reduce(...) → 再次 sync_state（每 ~460ms）
                                  ↓
                          手动暂停 / 非 AI 席位 / gameOver → AI 自然停
                                  ↓
                       前端 socket.on('sync_state', setGame)
```

### App.tsx 的 Hook 顺序约束（踩过的坑）

`App` 组件用 `const [game, setGame] = useState<FullGame | null>(null)` 作为"等待 server sync_state"的占位。**所有 `useState` / `useEffect` / `useMemo` / `useRef` / `useCallback` 必须写在 `if (!game) return ...` 这条 early return 之前**——这是 React Rules of Hooks 的硬要求：

- 首次渲染 game=null → 命中 early return，return 之后的 hook 全部不执行
- sync_state 到达后 game≠null → 不再 early return，return 之后的 hook 才执行
- 两次渲染的 hook 数量不一致 → React 抛 `Rendered more hooks than during the previous render` → 整棵树 unmount → **白屏，没有报错弹窗**

修法：把 hook 全部上移；若内部要访问 `game` 字段，用可空表达式（`game?.state.phase`）并在 hook 内部判空。**改 App.tsx 时如果新加了 hook 或挪了 early return，肉眼检查一遍这条规则**——typecheck 不会捕获它。

### 资源 / 地形 / 发展卡命名约定

**ID 全部是单字中文**（2026-05-21 起），既是 TS 字面量类型成员，也是对象 key，也是序列化给 LLM 的 JSON 字段名——一份枚举走通前后端 + LLM。

- `Resource = '木' | '砖' | '羊' | '麦' | '矿'`
- `Terrain = Resource | '沙漠'`
- `Port = Resource | '通用'`（`'通用'` = 3:1 港口）
- `DevCard = '骑士' | '胜利点' | '修路' | '丰收' | '垄断'`

新增 Provider / prompt / 持久化层时**不要把这些翻译回英文**。源头就在 `shared/types.ts`，其余地方一律消费它。

LLM prompt / hint 里的骰点概率权重统一叫**产出点**，不要再写英文 `pip`。示例：`麦8(5产出点)`、`总产出 12产出点`。产出点不是资源数量，而是骰子概率权重（6/8 最高）。

例外：
- **贴图路径** `/assets/terrain-wood.png` 等仍是英文文件名（不重打包），`TERRAIN_TILE_ASSETS` 做中→英映射。
- **actionId 前缀**与枚举解耦：`play-knight` / `play-road-building` / `monopoly-` / `yop-` / `bank-` 是稳定字符串，mockProvider 按这些前缀匹配；资源后缀部分会跟随枚举变成中文（`monopoly-木` / `yop-木-砖` / `bank-木-to-砖`）。
- `RESOURCE_LABEL` / `DEV_LABEL` 现为身份映射，保留作为 ID↔显示文本的单点扩展位。

### 不变量与契约

**状态机仍然是纯函数。** `reduce(board, state, action)` 在 `shared/reducer.ts`，用 `structuredClone` 复制旧状态、返回新状态，从不就地修改。**非法动作静默 no-op（直接 `break`，不抛异常）**——这是被 AI 和 UI 依赖的契约，不要为非法动作加 throw。后端的 `applyAction` 直接信任 reducer 的这层保护。

**Board 与 State 分离。** `board`（hex/vertex/edge 几何 + 港口）由 `generateBoard()` 一次性生成、整局不可变；`state` 是可变游戏状态。约定 `FullGame = { board, state }`，函数签名一律 `(board, state, ...)`。`rules.ts` 是无副作用的判定/计分（`produceResources` 例外，由 reducer 在副本上调用）。

**Phase 驱动一切。** `Phase` 类型（setup1/setup2/roll/discard/moveRobber/steal/main/gameOver）同时驱动 `aiNextAction` 和前端 UI 的分支。Setup 是子状态机：`setupOrder`（蛇形顺序）+ `setupIndex` + `setupStep`（settlement→road）。

**AI 驱动循环在 `server/index.ts` 的 `scheduleAI()` → `decideAiStep()`（在 `server/llm/controller.ts`）。** 当前默认 `PLAYER_MODE=all-ai`：server 创建新局后把 4 个席位都设为 AI，并在 `Session.agents` 里为 P0/P1/P2/P3 各建一个独立 `AiAgentRuntime`（性格、短期记忆、providerName、decisionCount）。流程：①按当前玩家取对应 agent → ②生成 legalActions（actionCatalog）+ playerView（stateTranslator）+ agent personality/memory → ③喂给 `AiDecisionProvider`（由 agent.providerName 初始化自 `AI_PROVIDER`，可按玩家拆分）→ ④用 `actionChecker` 三层校验 → ⑤校验过则 apply 新状态 + 广播 `ai_thought`，并把 thought/action 写回该 agent 的 memory；不过则带反馈重试最多 2 次 → ⑥仍不过 fallback 到 ruleProvider；最终极端兜底强制 `END_TURN`。**discard 阶段不喂 Provider**：组合爆炸，直接走规则 AI 兜底。**含状态指纹防卡死兜底**：连续 8 次同指纹则强制 `END_TURN`（sim.ts 用同样指纹、阈值 600）。**改 AI 的铁律：`aiMain` 必须始终推进或最终 `END_TURN`，绝不能持续返回一个会被 reducer no-op 的动作。**

**Provider 抽象（重要）：**
- **模型注册表 `llm/modelRegistry.ts` 是 LLM 模型的单一事实来源。** 每个模型一条 `LlmModelSpec`：`key` / `label` / `api`（`anthropic`|`openai`，决定走哪个 adapter）/ `model` / `endpoint` / `apiKeyEnv` / `aliases` / `enableThinking` / `labelPrefix`（决定 `AiDecisionProvider.name` 与 `providerLabel` 前缀，省略时按 api 推断）。`buildProvider`（决策）、`tradeProvider.callLlm`（交易/社交）、前端 provider 选项（`llmModelOptions`）、别名归一（`resolveProviderKey`）、`isLlmProvider` / `isLlmAdapterName` 全部从这里派生。**加模型 = 加一条（复用现有 adapter，新 API 形态才写 adapter）；停模型 = 删/注释该条。** rule/mock 是内置非 LLM provider，不在表里。
- `rule` Provider：包 `aiNextAction`，把动作 deep-equal 反查到 `legalActions` 中的 actionId。
- `mock` Provider：按优先级从 legalActions 里挑，不接 LLM 也能跑通整条链路；用于压测和无 API 调试。
- `qwen36` Provider（**当前默认 LLM**）：openai 兼容 adapter（`qwenProvider.ts`），调阿里 `qwen3.6-plus`，端点 `https://coding.dashscope.aliyuncs.com/v1/chat/completions`，读取 `ALI_CODING_PLAN_KEY`。前端玩家卡片上可按 AI 席位独立切换 provider。
- `deepseek` Provider：openai 兼容 adapter（复用 `qwenProvider.ts`，`labelPrefix='deepseek'`），调 DeepSeek `deepseek-v4-flash`，端点 `https://api.deepseek.com/v1/chat/completions`，读取 `DEEPSEEK_API_KEY`。`enable_thinking` 是 Qwen 私有字段，DeepSeek 不接收（adapter 按 labelPrefix 判定是否发送）。
- `minimax` Provider（anthropic 兼容 adapter `llmProvider.ts`）：**已退役（订阅失效，2026-05-25），从注册表移除**——`AI_PROVIDER=minimax`/`llm` 现归一到 `rule`。adapter 代码保留；重启用见 `modelRegistry.ts` 里注释掉的那条 + `.env.example`。
- 任何 LLM 缺对应 `apiKeyEnv` 时 `buildProvider` 自动降级到 rule 并打 warn，stack 不会因此挂。
- LLM 不直接生成 `Action`，**永远是从 server 生成的 `legalActions` 里挑 `actionId`**。这是降低乱编坐标 / 破坏状态机风险的关键设计，新增 Provider 时不要绕过这条约束。

**LLM 输入与诊断可视化（2026-05-21，提交 `f69c0c1`）。** `AiThoughtEvent` / `AiErrorEvent` 现在可携带 `modelContext` 与 `timing`：前端 `AI 思考流` 每条新事件下方会显示可折叠的“模型输入 / Provider 输入”和“时延”面板。真实 LLM 显示实际发送的 `system` + `user` prompt；rule/mock 显示结构化 provider input。`timing` 会拆出 queue / catalog / view / context / provider / checker / fallback / commit 等阶段，用来定位慢点。旧历史事件没有这些字段是正常的。

**LLM 成本与规则提示。** `stateTranslator.ts` 的 `PlayerView` 包含 `costs`：道路=木1+砖1、房屋=木1+砖1+羊1+麦1、城市=麦2+矿3、发展卡=羊1+麦1+矿1；`llmProvider.ts` 的系统 prompt 也有同样的中文速查。建房/初始放房屋必须遵守距离规则：任何房屋或城市的相邻顶点都不能再建房屋；`legalActions` 已过滤违规顶点，`settlementHint` 会写“距离规则已满足：相邻顶点均无建筑”。

**道路 hint 的关键语义。** `roadHint()` 不要把道路端点周边资源直接当收益。修路后端点常因距离规则无法建村，真正价值通常是从路端再修一条路后的"隔点候选"。当前实现会模拟修完候选路，再列出"修完即可建"和"隔点候选：经 vX 再修 eY 到 vZ→资源/产出点"。若"隔点候选"目标已经能从既有路网（不含本候选）1 步可达，会追加`（⚠️ 既有路网 1 步可达，本路对此目标重复）`，避免 LLM 在 setup 阶段把两条 free road 都指向同一个最佳发展点。改道路评估时必须保留这个语义，避免 LLM 误判道路价值。

**棋盘调试编号。** `Board.tsx` 现在在 SVG 顶层显示只读边/顶点编号：`e{id}` / `v{id}`，`pointerEvents="none"`，用于对照 LLM actionId、hint 和棋盘位置；不要让编号层影响点击命中。

**`actionChecker.ts` 指纹的设计要点**：必须捕获仅靠"资源总数 / 建筑数"看不出的小变化——`devPlayed` / `freeRoads` / 每玩家的 `devCards.length` + `knightsPlayed` + `vpCards` / `longestRoad+largestArmy` 等都要在指纹里，否则像 PLAY_MONOPOLY（无人有该资源）、PLAY_ROAD_BUILDING、空 bank 的 PLAY_YEAR_OF_PLENTY 会被误判为 `NO_STATE_CHANGE`。改 `Action` 含义或新增字段时，记得同步更新 `fingerprint()`。

**资源守恒不变量。** bank + 所有玩家的每种资源恒为 19。`spend()` 把成本退回 bank；`produceResources` 有银行短缺规则（需求 > 库存且 >1 人需要时本次无人获得）。任何移动资源的新代码都必须维持该不变量，`sim.ts` 会校验。

**两个计分函数，注意信息隐藏。** `publicVP`（建筑 + 最长路 + 最大军队，公开）vs `totalVP`（再加隐藏胜利点卡，用于 `>= 10` 判负）。前端 UI 对人类显示 `totalVP`、对 AI 显示 `publicVP`——**不要在 sync_state 里裁剪 AI 的隐藏 VP**（reducer 不知道谁在看），裁剪在前端渲染层做。后期若做隐私化推送（按玩家分发不同视角），再在 server 加裁剪层。

**交易两条路径**（前后端各管一段）：
- **AI → 人类**：reducer 的 `OFFER_TRADE` 设 `state.pendingTrade`；前端弹 `PendingTrade` 卡，人类点接受/拒绝触发 `RESPOND_TRADE`。
- **人类 → AI**：当前主路径是 `human_trade_start` / `human_trade_say` / `human_trade_finalize` / `human_trade_end` 多轮谈判；对话展示复用 `trade_chat_*`，实时操作态走 `human_trade_state`，最终成交只走 `TRADE_EXECUTE`。旧的一次性 `propose_human_trade` 事件仍保留为兼容入口，前端操作区不再使用。**不要回退到前端跑 `aiAcceptsTrade`**——这违反"状态唯一权威在 server"原则，未来接 LLM AI 时会更乱。

**发展卡时序。** 购买进 `newDevCards`（本回合不可用），`endTurn` 时并入 `devCards`；`victory` 卡不进手牌、立即 `vpCards++`。每回合限打一张（`devPlayed`）。骑士卡可在 `roll`（掷骰前）或 `main` 阶段打出。

**持久化与 trace（2026-05-23）。** `PERSIST=1` 时服务端把 `game`、关系账本、agent 记忆/provider、控制开关与最近事件 buffer 去抖保存到 `./.data/sessions/<room>.json`，启动 `getSession()` 时 schema 匹配则自动续盘；`aiTimer`/`aiBusy`/`humanTrade` 等运行时句柄一律不恢复。`TRACE_FILE=1` 时 `ai_thought`/`ai_error` 追加写 `./.data/traces/<gameId>-ai.jsonl`，只告警不阻塞 AI 循环。`TRACE_HTTP=1` 时开放只读 `/api/sessions` 与 `/api/traces/{ai,trade,social}`，返回内存环形 buffer；trace 含完整 prompt/modelContext，勿暴露公网。以上均为 server-only 旁路，不碰 `shared/` 与 reducer。

### 已知缺口（本轮**没做**，后期要做）

- **玩家身份认证**：当前任意 socket 都能 `dispatch` 任意 action。reducer 按 `state.current` 归因，所以不能"代签其他玩家的回合"，但能干扰当前玩家。需要 player binding。
- **人类加入席位**：当前默认 4 AI 观察局；需要 player binding 后再把某个 seat 从 AI 切成 human（临时可用 `PLAYER_MODE=human0` 恢复 P0 人类旧模式）。
- **多房间 / 匹配**：sessions 是 Map 但只用 `'default'` 一个键。多人匹配需要房间列表 + 加入 / 离开协议。
- **持久化生产化**：当前只有 JSON 快照与 JSONL trace，默认关闭；长期运行还需要清理策略、快照迁移和多房间管理。
- **LLM AI 接入**：架构留好 `aiNextAction` 入口；接入时不要改 reducer，要在 server 加 "AI 决策提供者" 抽象层（规则 AI / LLM AI 可切换）。
- **AI 决策思考流可视化**：sync_state 现在是整包广播；未来可加 `ai_thinking` 事件让前端实时显示 LLM 推理。

## Socket 协议（当前事件清单）

| 方向 | 事件 | payload | 说明 |
|---|---|---|---|
| S → C | `sync_state` | `FullGame` | 全量游戏状态。连接时 / 每次 reduce 后广播 |
| C → S | `dispatch` | `Action` | 玩家动作；server reduce + 广播 + scheduleAI |
| C → S | `propose_human_trade` | `{target, give, receive}` + ack | 兼容保留的一次性人→AI 报价。新前端操作区使用 `human_trade_*` 多轮谈判 |
| C → S | `new_game` | —— | 清掉当前 session，重开一局，广播 |
| C → S | `set_ai_autoplay` | `{autoplay: boolean}` + ack | 开关服务端 AI 自动连续推进；关闭时取消排队中的 AI 步骤，并让进行中的 LLM 决策返回后失效 |
| C → S | `set_ai_hint` | `{hint: boolean}` + ack | 切换是否在 LLM prompt 里塞空间动作 hint（A/B 实验用）；仅影响 llm provider，rule/mock 忽略；不作废进行中的决策 |
| C → S | `set_ai_provider` | `{player?, provider}` + ack | 切换单个 AI 或全体 AI 的 provider（rule / mock / 注册表里的模型 key，当前 = qwen36；前端按玩家独立切换）；`provider:'human'` 且带 `player` 时把该席位切为真人 |
| C → S | `set_ai_thinking` | `{player, mode: 'auto'\|'on'\|'off'}` + ack | 单席位 thinking 模式三态：`on`/`off` 强制；`auto` 走 `server/llm/thinkingPolicy.ts`（setup1/setup2/moveRobber/steal 才开）。仅影响该 agent 决策路径（buildProvider→adapter）；交易/社交 LLM 仍读 spec 默认。前端「玩家卡 thinking 下拉」触发 |
| C → S | `set_social_chat` | `{enabled: boolean}` + ack | 自由社交聊天（嘴炮/结盟/威胁）总开关；默认开（`SOCIAL_CHAT=0` 显式关），运行时实时熄火（生成中途被关即丢弃）；只管社交发言，关系账本不受影响 |
| C → S | `step_ai` | ack | 手动推进一个 AI 动作；仅在当前有 AI 可行动且未 busy/queued 时成功 |
| C → S | `human_trade_start` | `{give, receive, message?, participants?}` + ack | 真人发起多轮交互谈判，可仅喊话或带结构化报价 |
| C → S | `human_trade_say` | `{message?, give?, receive?}` + ack | 真人继续喊话 / 改价，触发一轮 AI 回应 |
| C → S | `human_trade_finalize` | `{player}` + ack | 真人与某 AI 的 standing deal 一键成交（服务端走 `TRADE_EXECUTE`） |
| C → S | `human_trade_end` | ack | 真人主动结束当前谈判 |
| S → C | `ai_thought` | `AiThoughtEvent` | 一次 AI 决策的思考流（player/agentName/phase/thought/actionId/actionHint/action/modelContext/timing/provider/retries/status）；`action` 已通过 Maker-Checker，可用于前端棋盘高亮；`actionHint` 是最终选中动作的语义化情报；`modelContext` 展示完整模型输入 / Provider 输入；`timing` 展示服务端调用链路耗时 |
| S → C | `ai_error` | `AiErrorEvent` | Provider 输出非法 / 调用失败时广播；重试过程的错误也会发，含 agentName；错误事件也可带 `modelContext` 与 `timing` 方便分析失败输入和耗时 |
| S → C | `ai_control_state` | `AiControlState` | AI 控制状态（autoplay/queued/busy/canStep/hintEnabled/socialChatEnabled/provider/currentAgent/llmStats/thinkingByPlayer）；连接时与状态变化时广播（包括 phase 跃迁后，因 auto 模式的 effective 依赖当前 phase）；`llmStats` 是本次进程启动以来全部 LLM 调用（决策+交易+社交）累计的调用次数/输入输出 token/缓存命中，每次 LLM 调用完成都会增量广播，新局或服务端重启清零（不持久化）；`thinkingByPlayer[id]={mode,effective,supported}` 给前端玩家卡显示 thinking 下拉 |
| S → C | `social_chat` | `SocialChatEvent` | 一条 AI 社交发言（player/agentName/trigger/target/kind/message/turn）；由强盗/最长路/最大军队/逼近胜利等事件触发，受开关+预算约束；连接时补拉最近 60 条 |
| S → C | `relationship_state` | `RelationshipSnapshotEvent` | 关系账本扁平快照（各玩家对彼此的 trust/threat/debt）；连接时与每次社交跃迁后广播，供观察者「社交房间」面板可视化 |
| S → C | `human_trade_state` | `HumanTradeStateEvent` | 真人谈判实时态（当前报价、AI 接受/还价候选、发言限流、busy）；连接时与每次变化广播 |
| S → C | `trade_chat_started` | `TradeChatStartedEvent` | 交易谈判开始（AI-only 或真人多轮谈判共用；initiator/participants/proposedTrade/limits） |
| S → C | `trade_chat_message` | `TradeChatMessageEvent` | 谈判发言（PROPOSE / CHAT / ACCEPT / REJECT / COUNTER_OFFER / SYSTEM），可带结构化 offer |
| S → C | `trade_chat_closed` | `TradeChatClosedEvent` | 谈判结束（accepted/rejected/expired/invalid），成交时带 finalTrade |

`ai_thought` / `ai_error` / `ai_control_state` / `social_chat` / `relationship_state` 与 `trade_chat_*` 的 DTO 定义在 `shared/protocol.ts`。server 端有最近 60 条 AI 事件、80 条交易谈判事件、60 条社交发言环形 buffer：新连接的客户端会在 `sync_state` 之后立即补拉历史事件 + 关系账本快照。AI 自动推进默认关闭（`AI_AUTOPLAY=1` 可改默认开启），前端通过 AI 控制面板切换或单步推进。`PLAYER_MODE=human0` 可临时恢复 P0 人类 + 3 AI；默认 `all-ai`。

## HTTP 调试接口

`GET /health` 始终可用。`TRACE_HTTP=1` 时额外开放只读 JSON 接口：`/api/sessions` 返回房间摘要；`/api/traces/ai?room=default&limit=N`、`/api/traces/trade?...`、`/api/traces/social?...` 返回对应内存 buffer 最近 N 条。AI trace 事件可能带完整 prompt/modelContext，只用于本地调试，不要暴露公网。

**AI 社交房间（2026-05-23）。** 在交易/谈判之上叠了一层"社交"：
- **关系账本** `server/social/relationshipLedger.ts`：每个玩家对他人的 `{trust,threat,debt}`，由成交（互信）/强盗（嫌隙）/最长路·最大军队·逼近胜利（警惕）等事件**确定性更新（零 LLM）**，压成一句"你对各家的看法"注入交易 prompt，影响 AI 报价/接受倾向。纯服务端编排状态，不进 `shared/`。
- **多轮房间式谈判**：`negotiationManager` 的 AI↔AI 谈判是多轮的（参与方互相反应、发起方对最优还价回应、竞争择优原子成交），`ROOM_ROUNDS_MAX` + `messagesPerSession` 双重封顶 LLM 调用。
- **事件触发社交发言** `server/social/socialChat.ts` + `server/llm/socialProvider.ts`：白名单事件 + 规则门控 + 冷却 + 每回合/整局硬预算挑人发一句嘴炮/结盟/威胁。**默认开**（`SOCIAL_CHAT=0` 显式关），`set_social_chat` 运行时实时熄火，是防 token 失控的刹车。rule/mock 用模板兜底、LLM 走便宜模型。
- **交易原语** `server/trading/roomCore.ts`：AI↔AI 与 人↔AI 两个驱动共用 `dryRunTrade`（资源守恒唯一入口）等原语，避免漂移。
- 后端各模块都有专用冒烟（`ledgerSmoke` / `negotiationSmoke` / `socialChatSmoke`），因为 `sim.ts` 只跑 `shared/` 内核、触不到 server 社交层。

新增事件时同步更新此表与 `server/index.ts` 的注释。

## 验证命令

```bash
# 双 typecheck —— 容器内
docker run --rm -v "$PWD":/app -w /app node:20-alpine \
  sh -c "npm install --no-fund --no-audit --silent && npm run typecheck && npm run typecheck:server"

# sim 压测：默认 rule，可切到 mock 跑全 LLM 链路（catalog + checker 全开）
AI_PROVIDER=rule  docker run --rm -e AI_PROVIDER=rule -v "$PWD":/app -w /app node:20-alpine npx --yes tsx sim.ts
AI_PROVIDER=mock  docker run --rm -e AI_PROVIDER=mock -v "$PWD":/app -w /app node:20-alpine npx --yes tsx sim.ts

# 持久化冒烟：写快照→读快照→校验 agent 与资源守恒
docker run --rm -v "$PWD":/app -w /app node:20-alpine npx --yes tsx server/persistSmoke.ts
```

基线（2026-05-20）：rule 60/60 局，120 平均回合，0 错误；mock 60/60 局，317 平均回合（弱启发式所以更长），0 错误。任何对 `actionCatalog` / `actionChecker.fingerprint` 的改动都跑两遍这两个 provider。

**LLM Provider 验证（不入 sim，避免烧 token）：**

```bash
# 单次 API 调用冒烟（伪造 view + 3 个 legalActions，验证默认 LLM=qwen36 能返回合法 JSON）
docker run --rm --env-file .env -v "$PWD":/app -w /app node:20-alpine \
  sh -c "npm install --no-fund --no-audit --silent && npx tsx server/llmSmoke.ts"

# 端到端冒烟（需 stack 在跑）：代 P0 走完首手 setup1，看 P1 (AI) 真实推理
docker run --rm --network catan_default --env-file .env -e SMOKE_DRIVE=1 \
  -v "$PWD":/app -w /app node:20-alpine \
  sh -c "npm install --no-fund --no-audit --silent && npx tsx server/smoke.ts http://catan-server:3001"
```

性能基线（2026-05-20，MiniMax-M2.7 默认 thinking）：单次决策 ~15-25s（thinking 拉满）。100 回合全 AI 的一局约 25-40 分钟。**这是接 LLM 之后游戏节奏的基本面**——后续真要"快游戏"需要换成更轻的模型或关 thinking。

## API Key 与 .env

默认 LLM 是 `AI_PROVIDER=qwen36`，需要 `ALI_CODING_PLAN_KEY`。模型清单与各自所需的 key（`apiKeyEnv`）在 `server/llm/modelRegistry.ts`。这些从 `.env` 注入到 `catan-server` 容器（`docker-compose.yml` 配置了 `env_file: .env`，required: false 所以缺文件也能起）。MiniMax 已退役（订阅失效），`AI_PROVIDER=minimax`/`llm` 现归一到 `rule`；重启用见 `modelRegistry.ts` 注释条 + `.env.example`。

- **新机器 setup**：`cp .env.example .env`，填 `ALI_CODING_PLAN_KEY`；`.env` 已在 `.gitignore`
- **常用环境变量**：见 `.env.example`，含 `AI_PROVIDER` / `ALI_CODING_PLAN_BASE_URL` / `QWEN_MODEL` / `PERSIST` / `TRACE_FILE` / `TRACE_HTTP` / `LLM_TIMEOUT_MS` / `LLM_TEMPERATURE`
- **快速降级**：把 `.env` 里改成 `AI_PROVIDER=rule` 或干脆删 `ALI_CODING_PLAN_KEY`，stack 会自动用规则 AI（log 里会看到 warn）

## Art / 美术风格

**整体定位：手绘墨线 + 去饱和阴郁的哥特插画风**（接近《饥荒 Don't Starve》/ 蒂姆·伯顿：扭曲虬枝、暴突白眼生物、骨骸、重黑墨线、灰绿暗褐主色）。这是有意为之的风格，新增美术须沿用，勿改成扁平卡通或明亮配色。

**调色与资源源头在 `src/art/theme.ts`**：`TERRAIN_ART`（每地形 base/light/dark/ink/hatch）、`INK`/`PAPER`/`PAPER_DARK`、`TERRAIN_TILE_ASSETS`（地形→PNG 路径）。`PLAYER_ART_COLORS` 已迁去 `shared/state.ts`，theme.ts re-export 它，以避免双写。改色只改这两处其一，不要在组件里硬编码。

**两条渲染路径（`Board.tsx`）**：① 地形优先用 `public/assets/terrain-*.png`，按 138×138 居中、六边形 `clipPath` 裁切，背后垫径向渐变 `g-<terrain>`，外层叠 SVG 墨线描边 + `paper-warp` 湍流滤镜；② 无 PNG 时回退到 `Motif()` 的纯 SVG 矢量图元（树/羊/麦/矿等）。房屋/城市/道路/强盗/港口全是 SVG 手绘（用 theme 色 + `soft` 投影 / `paper-warp` 滤镜），非贴图。

**当前 PNG 素材集已知不一致（2026-05-19 评估，用户决定暂不重画，保持现状）**：边框处理不统一（木/羊/矿/沙漠是撕裂羊皮纸毛边，砖/麦是等距斜切瓷砖边）；投影不统一（部分俯视平面、部分等距 2.5D）；色调不统一（麦田过亮偏暖、砖块过饱和）。`terrain-desert.png` 与 `catan-desert-hex.png` 为同一张图。

**若日后新增/替换地形贴图**：出**满幅、无自带边框**的内部画面（六边形框由 SVG 绘制并会裁切/冲突任何自带边框），用俯视平面投影，沿用上面的墨黑去饱和调色板，以便和 SVG 框、其余地块视觉统一。
