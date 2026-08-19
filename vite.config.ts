import { fileURLToPath, URL } from 'node:url';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// #WDD-gpt 2026-08-16 - 以根目录 VERSION 作为唯一页面版本来源，避免品牌栏与发布文件各自硬编码。
const appVersion = readFileSync(fileURLToPath(new URL('./VERSION', import.meta.url)), 'utf8').trim();

if (!/^\d+\.\d+\.\d+$/.test(appVersion)) {
  throw new Error(`Invalid VERSION value: ${JSON.stringify(appVersion)}`);
}

// #WDD-gpt 2026-08-19 - 让入口 HTML 与独立版本清单也携带根 VERSION，发布后可直接核对主页和资源是否来自同一次构建。
function releaseVersionPlugin(): Plugin {
  return {
    name: 'dong-editor-release-version',
    transformIndexHtml: {
      order: 'pre',
      handler: () => [{
        tag: 'meta',
        attrs: { name: 'app-version', content: appVersion },
        injectTo: 'head',
      }],
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: `${JSON.stringify({ version: appVersion }, null, 2)}\n`,
      });
    },
  };
}

// #WDD-gpt 2026-08-15 - 开启跨源隔离以允许 Codec Worker 使用 SharedArrayBuffer 零拷贝共享。
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export default defineConfig({
  base: './',
  plugins: [react(), releaseVersionPlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  // #WDD-gpt 2026-08-16 - 复用离线 V2.4 纯 JS 解码器时，只把 Node 内建模块映射到浏览器安全实现；编码端系统调用在前端会明确报错。
  resolve: {
    alias: {
      'node:crypto': fileURLToPath(new URL('./src/features/gaussian/formats/fourcgs/shims/node-crypto.ts', import.meta.url)),
      'node:zlib': fileURLToPath(new URL('./src/features/gaussian/formats/fourcgs/shims/node-zlib.ts', import.meta.url)),
      'node:child_process': fileURLToPath(new URL('./src/features/gaussian/formats/fourcgs/shims/node-child-process.ts', import.meta.url)),
      'node:fs/promises': fileURLToPath(new URL('./src/features/gaussian/formats/fourcgs/shims/node-fs-promises.ts', import.meta.url)),
      'node:os': fileURLToPath(new URL('./src/features/gaussian/formats/fourcgs/shims/node-os.ts', import.meta.url)),
      'node:path': fileURLToPath(new URL('./src/features/gaussian/formats/fourcgs/shims/node-path.ts', import.meta.url)),
      'node:util': fileURLToPath(new URL('./src/features/gaussian/formats/fourcgs/shims/node-util.ts', import.meta.url)),
    },
  },
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
