import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const row4dDataRoot = '/home/crgj/wdd/data/Row4D';

// #WDD-gpt 2026-08-15 - 压缩质量检测使用独立构建入口，避免将评测控件打进用户页面。
export default defineConfig({
  base: './',
  root: fileURLToPath(new URL('./tools/compression-renderer', import.meta.url)),
  plugins: [react()],
  publicDir: false,
  server: {
    // #WDD-gpt 2026-08-15 - 独立验收入口只额外开放 Row4D 测试数据目录，不扩大正式站点的文件访问范围。
    fs: { allow: [projectRoot, row4dDataRoot] },
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./artifacts/compression-renderer-web', import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
  },
});
