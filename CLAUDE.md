# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

卡坦岛（Catan）Web 单机版：1 人 vs 3 AI。纯前端 React + TypeScript + Vite + SVG，无后端、无持久化。源码与注释均为中文，沿用此约定。

## Commands

**一律在容器中跑，不要用宿主机本地环境**（宿主机不装 Node 工具链；本仓库无 `package-lock.json`，用 `npm install` 而非 `npm ci`）。

```bash
# 部署 / 预览：静态文件在镜像构建时烘焙，改代码必须 --build 重建
docker compose up -d --build   # → http://<host>:8088
docker compose down

# 类型检查（唯一的静态门禁；无 lint）—— 容器内
docker run --rm -v "$PWD":/app -w /app node:20-alpine \
  sh -c "npm install --no-fund --no-audit --silent && npm run typecheck"

# 自动对局压测（事实上的测试套件，见下）—— 容器内
docker run --rm -v "$PWD":/app -w /app node:20-alpine npx --yes tsx sim.ts
```

无 lint、无单元测试框架。**`sim.ts` 是事实上的测试**：跑 60 局全 AI 对战，逐步校验不变量（每种资源 bank+玩家恒为 19、资源非负、VP ≤ 13）、检测死循环（状态指纹 600 步不变即失败），有问题 `exit 1`。改动 `src/game/` 任何文件后都应在容器内跑一遍这两条命令。

已验证基线（2026-05-19，容器内）：`tsc --noEmit` 零错误；压测 60/60 局正常结束、不变量失败 0、无死循环、平均约 121 回合。`package.json` 的 `dev`/`build`/`preview` 脚本存在，但本环境不在宿主机直接执行。

## Architecture

游戏逻辑全部在 `src/game/`，与渲染（`components/Board.tsx`、`art/theme.ts`）完全分离。核心是一个**纯函数状态机**。

**状态机（`reducer.ts`）是唯一的可变入口。** `reduce(board, state, action)` 用 `structuredClone` 复制旧状态、返回新状态，从不就地修改。所有规则变更都经由 dispatch 一个 `Action`。**非法动作静默 no-op（直接 `break`，不抛异常）——这是被 AI 和 UI 依赖的契约，不要为非法动作加 throw。**

**Board 与 State 分离。** `board`（hex/vertex/edge 几何 + 港口）由 `board.ts` 的 `generateBoard()` 一次性生成，整局不可变；`state` 是可变游戏状态。约定 `FullGame = { board, state }`，函数签名一律 `(board, state, ...)`。`rules.ts` 是无副作用的判定/计分函数（`produceResources` 例外，由 reducer 在副本上调用）。

**Phase 驱动一切。** `Phase` 类型（setup1/setup2/roll/discard/moveRobber/steal/main/gameOver）同时驱动 `aiNextAction` 和 UI 的分支。Setup 是子状态机：`setupOrder`（蛇形顺序）+ `setupIndex` + `setupStep`（settlement→road）。

**AI 驱动循环在 `App.tsx` 的 `useEffect` 里，不在游戏逻辑内。** 反复调用 `aiNextAction(board, state)`：非 null 则延迟 460ms dispatch；返回 null 表示轮到人类，UI 接管。含**防卡死兜底**：状态指纹连续 8 次不变则强制 `END_TURN`（`sim.ts` 用同样指纹、阈值 600）。**改 AI 的铁律：`aiMain` 必须始终推进或最终 `END_TURN`，绝不能持续返回一个会被 reducer no-op 的动作，否则死循环。**（例：`tradeToward` 特意检查 `s.bank[needR] < 1` 来规避此问题。）

**资源守恒不变量。** bank + 所有玩家的每种资源恒为 19。`spend()` 把成本退回 bank；`produceResources` 有银行短缺规则（需求 > 库存且 >1 人需要时本次无人获得）。任何移动资源的新代码都必须维持该不变量，`sim.ts` 会校验。

**两个计分函数，注意信息隐藏。** `publicVP`（建筑 + 最长路 + 最大军队，公开）vs `totalVP`（再加隐藏的胜利点卡，用于 `>= 10` 判负）。UI 对人类显示 `totalVP`、对 AI 显示 `publicVP`——不要在 UI 泄露 AI 的隐藏 VP。

**交易有两条独立路径。** AI→人类：`OFFER_TRADE` → `state.pendingTrade` → 人类 `RESPOND_TRADE`。人类→AI：UI 内同步调用 `aiAcceptsTrade()` 判断后直接 `TRADE_EXECUTE`，不经 pending。

**发展卡时序。** 购买进 `newDevCards`（本回合不可用），`endTurn` 时并入 `devCards`；`victory` 卡不进手牌、立即 `vpCards++`。每回合限打一张（`devPlayed`）。骑士卡可在 `roll`（掷骰前）或 `main` 阶段打出。

## Art / 美术风格

**整体定位：手绘墨线 + 去饱和阴郁的哥特插画风**（接近《饥荒 Don't Starve》/ 蒂姆·伯顿：扭曲虬枝、暴突白眼生物、骨骸、重黑墨线、灰绿暗褐主色）。这是有意为之的风格，新增美术须沿用，勿改成扁平卡通或明亮配色。

**调色与资源源头在 `src/art/theme.ts`**：`TERRAIN_ART`（每地形 base/light/dark/ink/hatch）、`INK`/`PAPER`/`PAPER_DARK`、`PLAYER_ART_COLORS`、`TERRAIN_TILE_ASSETS`（地形→PNG 路径）。改色只改这里，不要在组件里硬编码。

**两条渲染路径（`Board.tsx`）**：① 地形优先用 `public/assets/terrain-*.png`，按 138×138 居中、六边形 `clipPath` 裁切，背后垫径向渐变 `g-<terrain>`，外层叠 SVG 墨线描边 + `paper-warp` 湍流滤镜；② 无 PNG 时回退到 `Motif()` 的纯 SVG 矢量图元（树/羊/麦/矿等）。房屋/城市/道路/强盗/港口全是 SVG 手绘（用 theme 色 + `soft` 投影 / `paper-warp` 滤镜），非贴图。

**当前 PNG 素材集已知不一致（2026-05-19 评估，用户决定暂不重画，保持现状）**：边框处理不统一（木/羊/矿/沙漠是撕裂羊皮纸毛边，砖/麦是等距斜切瓷砖边）；投影不统一（部分俯视平面、部分等距 2.5D）；色调不统一（麦田过亮偏暖、砖块过饱和）。`terrain-desert.png` 与 `catan-desert-hex.png` 为同一张图。

**若日后新增/替换地形贴图**：出**满幅、无自带边框**的内部画面（六边形框由 SVG 绘制并会裁切/冲突任何自带边框），用俯视平面投影，沿用上面的墨黑去饱和调色板，以便和 SVG 框、其余地块视觉统一。
