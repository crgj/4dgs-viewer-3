import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// #WDD-gpt 2026-08-19 - 构建前后同时校验 VERSION、CHANGELOG、左上角徽标和 docs 产物，禁止发布陈旧版本号。
const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const version = readFileSync(resolve(repositoryRoot, 'VERSION'), 'utf8').trim();
const changelog = readFileSync(resolve(repositoryRoot, 'CHANGELOG.md'), 'utf8');
const appSource = readFileSync(resolve(repositoryRoot, 'src/app/App.tsx'), 'utf8');
const viteConfig = readFileSync(resolve(repositoryRoot, 'vite.config.ts'), 'utf8');

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`VERSION 必须是 x.y.z，当前值为 ${JSON.stringify(version)}`);
}

const latestChangelogVersion = changelog.match(/^## (\d+\.\d+\.\d+) - /m)?.[1];
if (latestChangelogVersion !== version) {
  throw new Error(`CHANGELOG.md 最新版本 ${latestChangelogVersion ?? '缺失'} 与 VERSION ${version} 不一致。`);
}

if (!appSource.includes('>v{__APP_VERSION__}</button>')) {
  throw new Error('主页左上角版本徽标必须直接显示 __APP_VERSION__。');
}
if (!viteConfig.includes("new URL('./VERSION', import.meta.url)")) {
  throw new Error('Vite 必须从根目录 VERSION 注入 __APP_VERSION__。');
}

if (process.argv.includes('--docs')) {
  const docsRoot = resolve(repositoryRoot, 'docs');
  const builtHtml = readFileSync(resolve(docsRoot, 'index.html'), 'utf8');
  const builtVersion = JSON.parse(readFileSync(resolve(docsRoot, 'version.json'), 'utf8')).version;
  if (builtVersion !== version) {
    throw new Error(`docs/version.json 为 ${String(builtVersion)}，但 VERSION 为 ${version}。`);
  }
  if (!builtHtml.includes(`name="app-version" content="${version}"`)) {
    throw new Error(`docs/index.html 未标记当前版本 ${version}。`);
  }
  const entryPath = builtHtml.match(/<script[^>]+src="\.\/(assets\/index-[^"]+\.js)"/)?.[1];
  if (!entryPath) throw new Error('docs/index.html 未找到构建后的入口脚本。');
  const entrySource = readFileSync(resolve(docsRoot, entryPath), 'utf8');
  if (!entrySource.includes(version)) {
    throw new Error(`构建入口 ${entryPath} 未包含主页版本 ${version}。`);
  }
}

process.stdout.write(`主页版本 ${version} 校验通过${process.argv.includes('--docs') ? '，docs 构建产物已同步' : ''}。\n`);
