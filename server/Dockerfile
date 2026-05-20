# 卡坦岛后端：socket.io WebSocket 服务（持有上帝视角游戏状态 + AI 驱动）
FROM node:20-alpine

WORKDIR /app

# 先拷依赖清单以利用层缓存
COPY package.json package-lock.json* ./
# 安装全部依赖（tsx 在 devDependencies 里，运行 server 需要它）
RUN npm install --no-fund --no-audit --include=dev

# 拷源码（仅 shared/ + server/ 即可，无需前端 src/）
COPY shared ./shared
COPY server ./server

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3001/health >/dev/null 2>&1 || exit 1

CMD ["npx", "--yes", "tsx", "server/index.ts"]
