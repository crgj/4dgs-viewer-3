import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const configDirectory = fileURLToPath(new URL('.', import.meta.url));

// #WDD-gpt 2026-08-16 - Build the lighting acceptance scene separately so test-only rendering code never enters the editor bundle.
export default defineConfig({
  base: './',
  build: {
    emptyOutDir: true,
    outDir: 'relighting-reference-dist',
    rollupOptions: {
      input: resolve(configDirectory, 'relighting-reference.html'),
    },
  },
});
