# ---- 构建阶段：在容器内安装依赖、类型检查并打包 ----
FROM node:20-alpine AS build
WORKDIR /app

# 先拷依赖清单以利用层缓存
COPY package.json package-lock.json* ./
RUN npm install --no-fund --no-audit

# 拷源码并构建（tsc --noEmit && vite build）
COPY . .
RUN npm run build

# ---- 运行阶段：用 nginx 托管静态文件 ----
FROM nginx:alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://localhost/ >/dev/null 2>&1 || exit 1
CMD ["nginx", "-g", "daemon off;"]
