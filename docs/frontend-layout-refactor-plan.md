# 前端布局重构方案：操作区与观察区分层

## 背景

当前前端右侧栏把“我的操作、AI 思考流、交易谈判、社交房间、对局日志”都放在同一个 `SidebarEventPanel` tab 组里。这个排布导致两类职责混在一起：

- **操作职责**：玩家当前能做什么，例如建造、掷骰、弃牌、银行交易、人机谈判、接受/拒绝 AI 报价。
- **观察职责**：这局刚发生了什么，例如 AI 决策、交易谈判记录、社交发言、系统对局日志。

结果是交易相关 UI 尤其混乱：真人交易控件既出现在“我的操作”语境里，又作为“交易谈判”tab 的 dock 出现；而 AI 思考、交易、社交、日志本质都是事件流，但滚动、样式、空态和信息密度各自为政。

本文档给后续编码 agent 作为布局优化实施依据。

## 目标

1. 让右侧栏形成稳定心智模型：上方看局势，中间做操作，下方看事件。
2. 把“我的操作”从观察 tab 中移出，成为独立操作面板。
3. 让 AI 思考流、交易谈判、社交房间、对局日志共享统一的观察面板外壳。
4. 明确交易 UI 的边界：交易控件属于操作区，交易记录属于观察区。
5. 保持现有 socket 协议与服务端行为不变，本轮只做前端布局与组件职责整理。

## 推荐信息架构

右侧栏建议固定为四层：

```text
右侧栏
├─ 玩家状态 / 当前回合摘要
├─ 我的操作
│  ├─ 当前阶段动作
│  ├─ 银行交易
│  ├─ 真人谈判入口 / 当前谈判快捷操作
│  └─ AI 向我报价时的接受 / 拒绝
├─ 观察面板 tabs
│  ├─ AI 思考
│  ├─ 交易
│  ├─ 社交
│  └─ 日志
└─ AI 控制条
```

对应到现有代码，建议从现在的结构：

```tsx
<Players />
<SidebarEventPanel tabs={['human', 'thoughts', 'trades', 'room', 'log']} />
<AiControls />
```

改成：

```tsx
<Players />
<HumanActionPanel />
<InspectorPanel tabs={['thoughts', 'trades', 'room', 'log']} />
<AiControls />
```

## 组件边界

### HumanActionPanel

职责：只处理真人玩家“现在能做什么”。

建议包含现有这些内容：

- `Phase`
- `DiscardPanel`
- `PendingTrade`
- `BankTrade`
- `HumanNegotiation`

其中 `HumanNegotiation` 不再作为“交易谈判”tab 的 sticky dock 出现。它可以作为操作区内的一个子块，显示当前谈判状态、standing deal、报价编辑、发言、成交、结束谈判。

如果当前没有真人席位，操作区可以显示一个紧凑空态，例如“当前为 AI 观察局”。不要把它隐藏到布局高度突变。

### InspectorPanel

职责：只处理观察与追踪，不发起会改变游戏状态的主操作。

保留四个 tab：

- `AI 思考`：渲染 `ai_thought` / `ai_error`
- `交易`：渲染 `trade_chat_started` / `trade_chat_message` / `trade_chat_closed`
- `社交`：渲染关系账本 + `social_chat`
- `日志`：渲染 `state.log`

注意：交易 tab 只展示交易时间线和调试详情，不放真人报价输入、成交按钮、结束谈判按钮。

## 事件流统一规范

AI 思考、交易、社交、日志应共享一套外壳样式，避免每个面板各自写死高度。

建议抽象 CSS 类：

```css
.inspector-panel
.inspector-tabs
.inspector-body
.event-feed
.event-item
.event-head
.event-title
.event-tag
.event-text
.event-meta
.event-debug
```

关键要求：

- `inspector-body` 负责占满剩余高度并 `overflow: hidden`。
- `event-feed` 负责内部滚动，使用 `height: 100%; min-height: 0; overflow-y: auto;`。
- 删除或覆盖现有 `.thought-log`、`.trade-log`、`.log` 上的 `max-height: 280px/210px`。
- 每条事件都遵循相似结构：玩家色点 / 标题 / tag / 正文 / 可折叠调试块。
- 空态文案简短，不写功能说明长文。

## 社交房间布局

社交 tab 不是纯日志，建议内部固定两段：

```text
社交 tab
├─ 关系账本摘要或矩阵
└─ 社交发言流
```

关系矩阵应保持紧凑，优先显示高信任、高威胁、债务等关键信息。若侧栏空间不足，可折叠矩阵，默认展示摘要。

社交聊天关闭时可以展示短空态，但不要在 UI 中长篇解释功能；详细说明留在文档中。

## Tab 行为建议

默认 tab 与提醒行为建议：

- 有真人席位且轮到真人行动：操作区自然可见，不需要切观察 tab。
- 当前有新 AI 决策：`AI 思考` tab 可出现新事件标记。
- 当前有新交易消息或真人谈判进行中：`交易` tab 出现新事件标记。
- 社交发言到达：`社交` tab 出现新事件标记，不强制切换。
- 对局日志作为低优先级系统记录，默认放最后。

不要频繁自动切换用户正在查看的观察 tab。更稳妥的策略是只在用户尚未手动选择过 tab 时使用智能默认值，之后用 tab dot 提醒。

## 分步实施建议

### 第一步：拆出操作区

目标：把 `human` 从 `SidebarEventPanel` 中移除。

建议改动：

- 新增 `HumanActionPanel` 组件。
- 顶层侧栏改为 `Players` → `HumanActionPanel` → `InspectorPanel` → `AiControls`。
- `SidebarEventTab` 移除 `'human'`。
- `SidebarEventPanel` 改名为 `InspectorPanel`，只接收观察相关 props。
- `HumanNegotiation` 只在 `HumanActionPanel` 内渲染，不再在交易 tab 中 dock。

验收：

- 真人动作、银行交易、弃牌、AI 报价应答、人机谈判仍可操作。
- 交易 tab 仍能看到所有交易谈判事件。
- AI 观察局下操作区不应造成明显空洞或布局跳动。

### 第二步：统一滚动与高度

目标：右侧栏不再出现多个互相抢滚动的固定高度日志框。

建议改动：

- `.sidebar` 继续作为整列容器。
- `Players` 区域固定或自适应较小高度。
- `HumanActionPanel` 设置合理 `flex: 0 0 auto` 或 `max-height`，内部需要时滚动。
- `InspectorPanel` 设置 `flex: 1 1 auto; min-height: 0; overflow: hidden;`。
- `AiControls` 固定在底部。
- `.thought-log`、`.trade-log`、`.log`、`.room-social-stream` 统一转向 `event-feed` 滚动模型。

验收：

- 桌面宽屏下棋盘不被挤压异常。
- 侧栏中只有必要区域滚动，不出现“外层滚动 + 内层日志滚动 + sticky dock”叠加冲突。
- 移动端 `max-width: 860px` 布局仍能访问所有操作和观察 tab。

### 第三步：统一事件项视觉

目标：四类观察内容读起来像同一个信息系统。

建议改动：

- 将 `ThoughtLogContent`、`TradeLogContent`、`RoomContent`、`LogContent` 的外层结构改为统一 `event-feed`。
- 保留各自业务细节，例如模型输入 details、交易报价行、关系矩阵。
- 将通用 tag、玩家色点、折叠调试块样式收敛，减少重复 CSS。

验收：

- AI 思考、交易、社交、日志在字号、间距、tag、滚动体验上统一。
- 模型输入 / Provider 输入 / 模型输出仍可折叠查看。
- 交易报价、成交、拒绝、还价状态仍有清晰颜色或 tag 区分。

## 代码注意事项

- 修改 `App.tsx` 时必须遵守当前文件已有 Hook 顺序约束：所有 hook 必须位于 `if (!game) return ...` 之前。
- 本轮不改 socket 协议，不改 `shared/protocol.ts`，不改服务端事件。
- 不要把人机交易逻辑移回前端；前端只发 `human_trade_*` 事件，状态权威仍在 server。
- 保留 `ai_thought` 的棋盘高亮能力：观察面板重构不应影响 `aiFocus` 和 `Board` 的 `highlightAction`。
- 若调整 CSS，避免把侧栏做成嵌套卡片堆叠；操作区和观察区可以是清晰分段，而不是卡片套卡片。

## 建议文件改动范围

优先只改：

- `src/App.tsx`
- `src/styles.css`

如拆组件可再新增：

- `src/components/HumanActionPanel.tsx`
- `src/components/InspectorPanel.tsx`
- `src/components/EventFeed.tsx`

如果只是第一轮重排，可以先不拆文件，在 `App.tsx` 内部拆函数组件，验证稳定后再迁移。

## 验证命令

前端布局改动至少跑类型检查：

```bash
docker run --rm -v "$PWD":/app -w /app node:20-alpine \
  sh -c "npm install --no-fund --no-audit --silent && npm run typecheck && npm run typecheck:server"
```

如果改动没有触碰 `shared/` 或服务端逻辑，可以不跑 `sim.ts`。如果顺手改了共享类型、协议或 reducer 相关代码，必须补跑：

```bash
docker run --rm -v "$PWD":/app -w /app node:20-alpine npx --yes tsx sim.ts
```

注意容器内 `npm install` 可能生成 `package-lock.json`，验证后不要提交该文件。
