import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// #WDD-gpt 2026-08-15 - 开启跨源隔离以允许 Codec Worker 使用 SharedArrayBuffer 零拷贝共享。
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export default defineConfig({
  base: './',
  plugins: [react()],
  // #WDD-gpt 2026-08-15 - MediaPipe 已是浏览器 ESM，跳过 Vite 预打包以避免多个开发服务器争用 .vite 哈希导致 Worker 504。
  optimizeDeps: {
    exclude: ['@mediapipe/tasks-vision'],
    // #WDD-gpt 2026-08-15 - GS2Mesh Worker 首次加载前固定预打包 CommonJS isosurface，避免运行中新增依赖留下 504 Outdated Optimize Dep。
    include: ['isosurface'],
  },
  server: {
    headers: isolationHeaders,
  },
  preview: {
    headers: isolationHeaders,
  },
  build: {
    outDir: 'docs',
    emptyOutDir: true,
    sourcemap: true,
  },
});
