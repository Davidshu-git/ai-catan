# 卡坦岛 · Catan（Web 单机版）

单人对战 3 个 AI 的卡坦岛网页游戏。纯前端（React + TypeScript + Vite + SVG），无后端。

## 玩法规则（完整经典规则）

- **开局**：蛇形顺序，每人放 2 座房屋 + 2 条路；第二座房屋立即获得相邻地块资源。
- **每回合**：掷两颗骰子 → 所有玩家在对应数字地块旁的建筑产出资源（房屋 1，城市 2）。
- **掷到 7**：手牌 >7 的玩家弃一半 → 移动强盗封锁地块 → 从相邻对手偷 1 张牌。
- **交易**：与银行 4:1（港口 3:1 / 2:1）兑换；或向 AI 提议玩家间交易。
- **建造**：道路（木+砖）、房屋（木+砖+羊+麦）、城市（2 麦+3 矿）、发展卡（羊+麦+矿）。
- **发展卡**：骑士、修路、丰收、垄断、胜利点。
- **得分**：房屋 1 / 城市 2 / 最长路(≥5) +2 / 最大军队(≥3 骑士) +2 / 胜利点卡 1，**先到 10 分获胜**。

## 用 Docker 运行（推荐，宿主机零依赖）

```bash
cd projects/catan
docker compose up -d --build
```

打开浏览器访问 `http://<主机IP>:8088`（端口可在 `docker-compose.yml` 调整）。

停止 / 移除：

```bash
docker compose down
```

整个构建（npm 安装、类型检查、打包）都在容器内完成，宿主机不产生 `node_modules` 或 npm 缓存。

## 本地开发（可选，需要本机 Node 20）

```bash
npm install
npm run dev      # 开发服务器 http://localhost:5173
npm run build    # 类型检查 + 生产打包到 dist/
```

## 目录结构

```
src/
  game/
    types.ts      类型定义、成本、常量
    board.ts      六边形棋盘几何与随机生成
    rules.ts      合法性判定 / 产出 / 最长路 / 计分
    reducer.ts    状态机：所有动作 → 新状态
    ai.ts         AI 启发式决策
    state.ts      初始游戏状态
  components/
    Board.tsx     SVG 棋盘渲染与点击交互
  App.tsx         界面与 AI 驱动循环
```
