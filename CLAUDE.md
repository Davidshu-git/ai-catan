# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

卡坦岛（Catan）Web 联机版：1 人类 + 3 AI（短期是规则 AI，中期会接 LLM）。**前后端分离**：React + TypeScript + Vite 前端 + Node.js + socket.io 后端，共用 `shared/` 下的纯函数游戏内核；状态由后端持有并通过 WebSocket 推送给前端。源码与注释均为中文，沿用此约定。

> 架构演进背景：本项目最初是纯前端单机版（reducer 跑在浏览器、AI 也在浏览器循环）。2026-05-20 完成前后端分离改造，把上帝视角状态与 AI 驱动搬到 Node 后端，**目的是为后续"AI 接入 LLM 调度"与"AI 决策思考流可视化"打地基**。`shared/` 这层被前后端同时引用，是这次重构的关键。

## Commands

**一律在容器中跑，不要用宿主机本地环境**（宿主机不装 Node 工具链；本仓库**故意不提交 `package-lock.json`**，容器构建用 `npm install` 而非 `npm ci`）。

```bash
# 部署 / 预览：static 前端 + node 后端，docker compose 拉起整套（前端 → http://<host>:8088）
docker compose up -d --build
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

server/                ← Node + socket.io 后端，持有上帝视角状态、驱动 AI、广播变更
  index.ts             socket.io 服务 + sessions Map（MVP 单房间，铺多房间路）
  smoke.ts             端到端冒烟脚本：连接→收 sync_state→new_game→再收 sync_state
  Dockerfile           生产镜像（node:20-alpine + tsx 直跑 TS）
  tsconfig.json        独立 TS 配置（include shared/ + server/）

src/                   ← Vite + React 前端，纯渲染 + 通过 socket 转发用户动作
  App.tsx              模块级 socket = io(...)，game = useState<FullGame | null>(null)
  components/Board.tsx SVG 棋盘 + 交互
  art/theme.ts         美术资源 / 调色（PLAYER_ART_COLORS re-export 自 shared/state.ts）
  vite-env.d.ts        import.meta.env 类型（VITE_SERVER_URL）

sim.ts                 ← 无头压测，直接 import shared/，跑 60 局全 AI
nginx.conf             ← 前端容器内 nginx：/ 走 SPA、/socket.io/ 反代到 catan-server:3001
docker-compose.yml     ← 两个服务：catan-server（后端）+ catan（前端 nginx，端口 8088）
```

### 数据流（重要）

```
人类点击 → App.dispatch(action) → socket.emit('dispatch', action)
                                  ↓
                  server: reduce(board, state, action) → io.emit('sync_state', game)
                                  ↓
                  server: scheduleAI(...) ← 事件驱动 AI 循环
                                  ↓
                          AI 该动 → reduce(...) → 再次 sync_state（每 ~460ms）
                                  ↓
                          人类回合 / gameOver → AI 自然停
                                  ↓
                       前端 socket.on('sync_state', setGame)
```

### App.tsx 的 Hook 顺序约束（踩过的坑）

`App` 组件用 `const [game, setGame] = useState<FullGame | null>(null)` 作为"等待 server sync_state"的占位。**所有 `useState` / `useEffect` / `useMemo` / `useRef` / `useCallback` 必须写在 `if (!game) return ...` 这条 early return 之前**——这是 React Rules of Hooks 的硬要求：

- 首次渲染 game=null → 命中 early return，return 之后的 hook 全部不执行
- sync_state 到达后 game≠null → 不再 early return，return 之后的 hook 才执行
- 两次渲染的 hook 数量不一致 → React 抛 `Rendered more hooks than during the previous render` → 整棵树 unmount → **白屏，没有报错弹窗**

修法：把 hook 全部上移；若内部要访问 `game` 字段，用可空表达式（`game?.state.phase`）并在 hook 内部判空。**改 App.tsx 时如果新加了 hook 或挪了 early return，肉眼检查一遍这条规则**——typecheck 不会捕获它。

### 不变量与契约

**状态机仍然是纯函数。** `reduce(board, state, action)` 在 `shared/reducer.ts`，用 `structuredClone` 复制旧状态、返回新状态，从不就地修改。**非法动作静默 no-op（直接 `break`，不抛异常）**——这是被 AI 和 UI 依赖的契约，不要为非法动作加 throw。后端的 `applyAction` 直接信任 reducer 的这层保护。

**Board 与 State 分离。** `board`（hex/vertex/edge 几何 + 港口）由 `generateBoard()` 一次性生成、整局不可变；`state` 是可变游戏状态。约定 `FullGame = { board, state }`，函数签名一律 `(board, state, ...)`。`rules.ts` 是无副作用的判定/计分（`produceResources` 例外，由 reducer 在副本上调用）。

**Phase 驱动一切。** `Phase` 类型（setup1/setup2/roll/discard/moveRobber/steal/main/gameOver）同时驱动 `aiNextAction` 和前端 UI 的分支。Setup 是子状态机：`setupOrder`（蛇形顺序）+ `setupIndex` + `setupStep`（settlement→road）。

**AI 驱动循环现在在 `server/index.ts` 的 `scheduleAI()` 里，不再在前端。** 每次 dispatch 后调用；若 `aiNextAction` 返回非 null 则延迟 `AI_TICK_MS`（默认 460ms）apply + 递归 schedule；返回 null 表示轮到人类、自然停；gameOver 也自然停。**含状态指纹防卡死兜底**：连续 8 次同指纹则强制 `END_TURN`（sim.ts 用同样指纹、阈值 600）。**改 AI 的铁律：`aiMain` 必须始终推进或最终 `END_TURN`，绝不能持续返回一个会被 reducer no-op 的动作，否则进入兜底前会刷屏。**

**资源守恒不变量。** bank + 所有玩家的每种资源恒为 19。`spend()` 把成本退回 bank；`produceResources` 有银行短缺规则（需求 > 库存且 >1 人需要时本次无人获得）。任何移动资源的新代码都必须维持该不变量，`sim.ts` 会校验。

**两个计分函数，注意信息隐藏。** `publicVP`（建筑 + 最长路 + 最大军队，公开）vs `totalVP`（再加隐藏胜利点卡，用于 `>= 10` 判负）。前端 UI 对人类显示 `totalVP`、对 AI 显示 `publicVP`——**不要在 sync_state 里裁剪 AI 的隐藏 VP**（reducer 不知道谁在看），裁剪在前端渲染层做。后期若做隐私化推送（按玩家分发不同视角），再在 server 加裁剪层。

**交易两条路径**（前后端各管一段）：
- **AI → 人类**：reducer 的 `OFFER_TRADE` 设 `state.pendingTrade`；前端弹 `PendingTrade` 卡，人类点接受/拒绝触发 `RESPOND_TRADE`。
- **人类 → AI**：前端不再调用 `aiAcceptsTrade`，改 `socket.emit('propose_human_trade', ..., ack)`；server 跑 `aiAcceptsTrade`，接受则发 `TRADE_EXECUTE`，无论接受与否都通过 ack 回调返回 `{accepted}` 给前端做 toast。**不要回退到前端跑 aiAcceptsTrade**——这违反"状态唯一权威在 server"原则，未来接 LLM AI 时会更乱。

**发展卡时序。** 购买进 `newDevCards`（本回合不可用），`endTurn` 时并入 `devCards`；`victory` 卡不进手牌、立即 `vpCards++`。每回合限打一张（`devPlayed`）。骑士卡可在 `roll`（掷骰前）或 `main` 阶段打出。

### 已知缺口（本轮**没做**，后期要做）

- **玩家身份认证**：当前任意 socket 都能 `dispatch` 任意 action。reducer 按 `state.current` 归因，所以不能"代签其他玩家的回合"，但能干扰当前玩家。需要 player binding。
- **多房间 / 匹配**：sessions 是 Map 但只用 `'default'` 一个键。多人匹配需要房间列表 + 加入 / 离开协议。
- **断线续盘 / 持久化**：server 重启状态丢失。需要 DB 或快照。
- **LLM AI 接入**：架构留好 `aiNextAction` 入口；接入时不要改 reducer，要在 server 加 "AI 决策提供者" 抽象层（规则 AI / LLM AI 可切换）。
- **AI 决策思考流可视化**：sync_state 现在是整包广播；未来可加 `ai_thinking` 事件让前端实时显示 LLM 推理。

## Socket 协议（当前事件清单）

| 方向 | 事件 | payload | 说明 |
|---|---|---|---|
| S → C | `sync_state` | `FullGame` | 全量游戏状态。连接时 / 每次 reduce 后广播 |
| C → S | `dispatch` | `Action` | 玩家动作；server reduce + 广播 + scheduleAI |
| C → S | `propose_human_trade` | `{target, give, receive}` + ack | 人→AI 报价。ack 收 `{accepted: boolean}` |
| C → S | `new_game` | —— | 清掉当前 session，重开一局，广播 |

新增事件时同步更新此表与 `server/index.ts` 的注释。

## Art / 美术风格

**整体定位：手绘墨线 + 去饱和阴郁的哥特插画风**（接近《饥荒 Don't Starve》/ 蒂姆·伯顿：扭曲虬枝、暴突白眼生物、骨骸、重黑墨线、灰绿暗褐主色）。这是有意为之的风格，新增美术须沿用，勿改成扁平卡通或明亮配色。

**调色与资源源头在 `src/art/theme.ts`**：`TERRAIN_ART`（每地形 base/light/dark/ink/hatch）、`INK`/`PAPER`/`PAPER_DARK`、`TERRAIN_TILE_ASSETS`（地形→PNG 路径）。`PLAYER_ART_COLORS` 已迁去 `shared/state.ts`，theme.ts re-export 它，以避免双写。改色只改这两处其一，不要在组件里硬编码。

**两条渲染路径（`Board.tsx`）**：① 地形优先用 `public/assets/terrain-*.png`，按 138×138 居中、六边形 `clipPath` 裁切，背后垫径向渐变 `g-<terrain>`，外层叠 SVG 墨线描边 + `paper-warp` 湍流滤镜；② 无 PNG 时回退到 `Motif()` 的纯 SVG 矢量图元（树/羊/麦/矿等）。房屋/城市/道路/强盗/港口全是 SVG 手绘（用 theme 色 + `soft` 投影 / `paper-warp` 滤镜），非贴图。

**当前 PNG 素材集已知不一致（2026-05-19 评估，用户决定暂不重画，保持现状）**：边框处理不统一（木/羊/矿/沙漠是撕裂羊皮纸毛边，砖/麦是等距斜切瓷砖边）；投影不统一（部分俯视平面、部分等距 2.5D）；色调不统一（麦田过亮偏暖、砖块过饱和）。`terrain-desert.png` 与 `catan-desert-hex.png` 为同一张图。

**若日后新增/替换地形贴图**：出**满幅、无自带边框**的内部画面（六边形框由 SVG 绘制并会裁切/冲突任何自带边框），用俯视平面投影，沿用上面的墨黑去饱和调色板，以便和 SVG 框、其余地块视觉统一。
