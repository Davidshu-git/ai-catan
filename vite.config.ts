import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// VITE_SOCKET_PROXY=http://catan-server:3001 → dev 时把 /socket.io 反代到后端容器，
// 浏览器仍按同源连接，避免"换 host 名访问就连不上"。生产构建（vite build）不受影响。
const SOCKET_PROXY = process.env.VITE_SOCKET_PROXY;

export default defineConfig(({ command }) => ({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy:
      command === 'serve' && SOCKET_PROXY
        ? {
            '/socket.io': {
              target: SOCKET_PROXY,
              ws: true,
              changeOrigin: false,
            },
          }
        : undefined,
  },
}));
