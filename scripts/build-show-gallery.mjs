// #WDD-gpt 2026-09-20 - 只读取片段头部生成独立 show 相册；每个子目录一视频，按源帧排序而非目录枚举顺序。
import { open, readdir, stat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve('public/4cgs_show');
const videos = [];
for (const directory of (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  const id = directory.name;
  const segments = [];
  for (const file of (await readdir(resolve(root, id))).filter((name) => name.toLowerCase().endsWith('.4cgs'))) {
    const path = resolve(root, id, file), handle = await open(path, 'r');
    let manifest;
    try {
      const header = Buffer.alloc(12); await handle.read(header, 0, 12, 0);
      if (header.toString('ascii', 0, 8) !== '4CGSPRS2') throw new Error(`Invalid magic: ${path}`);
      const size = header.readUInt32LE(8);
      if (size > 8 * 1024 * 1024) throw new Error(`Invalid manifest size: ${path}`);
      const bytes = Buffer.alloc(size); const { bytesRead } = await handle.read(bytes, 0, size, 12);
      if (bytesRead !== size) throw new Error(`Truncated header: ${path}`);
      manifest = JSON.parse(bytes.toString('utf8'));
    } finally { await handle.close(); }
    const fileBytes = (await stat(path)).size;
    segments.push({ file: `${id}/${file}`, fileBytes, firstFrame: manifest.firstFrame, lastFrame: manifest.lastFrame, codec: manifest.codecName, contentVersion: createHash('sha256').update(JSON.stringify(manifest)).digest('hex') });
  }
  if (!segments.length) continue;
  segments.sort((a, b) => a.firstFrame - b.firstFrame || a.file.localeCompare(b.file));
  for (let i = 1; i < segments.length; i++) if (segments[i].firstFrame < segments[i - 1].lastFrame || segments[i].firstFrame > segments[i - 1].lastFrame + 1) throw new Error(`Overlapping or missing frames: ${id}`);
  let metadata = {};
  try { metadata = JSON.parse(await readFile(resolve(root, id, 'video.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  videos.push({ id, name: metadata.name || id, description: metadata.description || `${segments.length} 个连续片段组成的空间视频`, tags: metadata.tags || ['空间视频'], fps: metadata.fps || 30, snapshot: `${id}/thumbnail.webp`, segments });
}
// #WDD-gpt 2026-09-20 - 仅资源变化才更新缓存版本；修改标题和题记复用已经下载的视频。
const resources = (list) => list.map(({ id, segments }) => ({ id, segments }));
let previous;
try { previous = JSON.parse(await readFile(resolve(root, 'gallery.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const signature = JSON.stringify(resources(videos));
const updatedAt = previous?.updatedAt && JSON.stringify(resources(previous.videos)) === signature
  ? previous.updatedAt : createHash('sha256').update(signature).digest('hex');
await writeFile(resolve(root, 'gallery.json'), JSON.stringify({ version: 1, updatedAt, videos }, null, 2) + '\n');
console.log(`show 相册：${videos.length} 个视频，${videos.reduce((n, v) => n + v.segments.length, 0)} 个片段。`);
