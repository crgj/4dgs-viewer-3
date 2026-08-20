import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// #WDD-gpt 2026-08-20 - 测试与生产构建读取同一个根 VERSION，使 4CGS editorBuild 写后校验不使用伪版本。
const appVersion = readFileSync(fileURLToPath(new URL('./VERSION', import.meta.url)), 'utf8').trim();

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
