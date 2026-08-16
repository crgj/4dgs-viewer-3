import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

// #WDD-gpt 2026-08-16 - 每次提交自动维护 VERSION 与 CHANGELOG，避免页面版本和实际修改脱节。
const repositoryRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const versionPath = resolve(repositoryRoot, 'VERSION');
const changelogPath = resolve(repositoryRoot, 'CHANGELOG.md');
const currentVersion = readFileSync(versionPath, 'utf8').trim();

if (!/^\d+\.\d+\.\d+$/.test(currentVersion)) {
  throw new Error(`VERSION 必须是 x.y.z，当前值为 ${JSON.stringify(currentVersion)}`);
}

const stagedFiles = execFileSync(
  'git',
  ['diff', '--cached', '--name-only', '--diff-filter=ACMR'],
  { cwd: repositoryRoot, encoding: 'utf8' },
).trim().split('\n').filter(Boolean);

const versionIsStaged = stagedFiles.includes('VERSION');
const changelogIsStaged = stagedFiles.includes('CHANGELOG.md');

if (versionIsStaged || changelogIsStaged) {
  if (!versionIsStaged || !changelogIsStaged) {
    throw new Error('提交版本时必须同时暂存 VERSION 与 CHANGELOG.md。');
  }

  const changelog = readFileSync(changelogPath, 'utf8');
  if (!changelog.includes(`## ${currentVersion} - `)) {
    throw new Error(`CHANGELOG.md 缺少当前版本 ${currentVersion} 的条目。`);
  }

  process.stdout.write(`版本 ${currentVersion} 与更新日志已同步。\n`);
  process.exit(0);
}

// #WDD-gpt 2026-08-16 - 包括仅含生产构建产物的提交，确保“每次提交”都产生新版本而没有例外路径。
const meaningfulFiles = stagedFiles;
if (meaningfulFiles.length === 0) {
  process.exit(0);
}

const [major, minor, patch] = currentVersion.split('.').map(Number);
const nextVersion = `${major}.${minor}.${patch + 1}`;
const date = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());

const descriptions = [];
const hasFile = (predicate) => meaningfulFiles.some(predicate);

if (hasFile((file) => file.startsWith('src/app/') || file === 'index.html')) {
  descriptions.push('更新编辑器界面、文案或交互。');
}
if (hasFile((file) => file.includes('/runtime/') || file.includes('/rendering/'))) {
  descriptions.push('更新 Gaussian 渲染与运行时行为。');
}
if (hasFile((file) => file.includes('/formats/') || file.includes('/loaders/'))) {
  descriptions.push('更新文件导入、解码或导出流程。');
}
if (hasFile((file) => file.startsWith('src/plugins/') || file.includes('/plugins/'))) {
  descriptions.push('更新浏览器插件功能。');
}
if (hasFile((file) => /(?:^|\/)test(?:s)?\//.test(file) || /\.test\.[cm]?[jt]sx?$/.test(file))) {
  descriptions.push('补充或调整自动化验证。');
}
if (hasFile((file) => file === 'README.md' || file.startsWith('docs/') || file.startsWith('scripts/'))) {
  descriptions.push('同步开发脚本、文档或生产构建产物。');
}

if (descriptions.length === 0) {
  const preview = meaningfulFiles.slice(0, 5).map((file) => `\`${file}\``).join('、');
  descriptions.push(`更新 ${preview}${meaningfulFiles.length > 5 ? ` 等 ${meaningfulFiles.length} 个文件` : ''}。`);
}

const previousChangelog = readFileSync(changelogPath, 'utf8');
const insertionPoint = previousChangelog.indexOf('\n## ');
const entry = `\n## ${nextVersion} - ${date}\n\n${descriptions.map((description) => `- ${description}`).join('\n')}\n`;
const nextChangelog = insertionPoint >= 0
  ? `${previousChangelog.slice(0, insertionPoint)}${entry}${previousChangelog.slice(insertionPoint)}`
  : `${previousChangelog.trimEnd()}${entry}`;

writeFileSync(versionPath, `${nextVersion}\n`);
writeFileSync(changelogPath, nextChangelog);
execFileSync('git', ['add', 'VERSION', 'CHANGELOG.md'], { cwd: repositoryRoot, stdio: 'inherit' });
process.stdout.write(`版本已自动更新为 ${nextVersion}，并已写入 CHANGELOG.md。\n`);
