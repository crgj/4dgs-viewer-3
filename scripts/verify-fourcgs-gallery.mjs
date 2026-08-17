import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const galleryRoot = resolve(repositoryRoot, 'public/4cgs');
const manifestPath = resolve(galleryRoot, 'gallery.json');
const catalog = JSON.parse(await readFile(manifestPath, 'utf8'));

const safeGalleryPath = (relativePath) => {
  const path = resolve(galleryRoot, relativePath);
  if (!path.startsWith(`${galleryRoot}/`)) throw new Error(`Unsafe gallery path: ${relativePath}`);
  return path;
};

const readFourCgsManifest = async (path) => {
  const file = await readFile(path);
  if (file.toString('ascii', 0, 8) !== '4CGSPRS2') throw new Error(`Invalid 4CGS magic: ${path}`);
  const manifestBytes = file.readUInt32LE(8);
  return { file, manifest: JSON.parse(file.subarray(12, 12 + manifestBytes).toString('utf8')) };
};

const webpDimensions = (file) => {
  if (file.toString('ascii', 0, 4) !== 'RIFF' || file.toString('ascii', 8, 12) !== 'WEBP') return null;
  const kind = file.toString('ascii', 12, 16);
  if (kind === 'VP8X' && file.length >= 30) {
    return { width: file.readUIntLE(24, 3) + 1, height: file.readUIntLE(27, 3) + 1 };
  }
  if (kind === 'VP8 ' && file.length >= 30 && file[23] === 0x9d && file[24] === 0x01 && file[25] === 0x2a) {
    return { width: file.readUInt16LE(26) & 0x3fff, height: file.readUInt16LE(28) & 0x3fff };
  }
  if (kind === 'VP8L' && file.length >= 25 && file[20] === 0x2f) {
    const bits = file.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
};

if (catalog.version !== 1 || !Array.isArray(catalog.items)) throw new Error('Invalid 4CGS gallery manifest.');
const assetFiles = (await readdir(galleryRoot)).filter((name) => extname(name).toLowerCase() === '.4cgs').sort();
const catalogFiles = [];
const ids = new Set();

for (const item of catalog.items) {
  if (!item.id || ids.has(item.id)) throw new Error(`Missing or duplicate gallery id: ${item.id}`);
  ids.add(item.id);
  if (typeof item.description !== 'string' || item.description.trim().length < 20) {
    throw new Error(`${item.id}: description must contain at least 20 characters.`);
  }
  const assetPath = safeGalleryPath(item.file);
  const snapshotPath = safeGalleryPath(item.snapshot);
  catalogFiles.push(item.file);
  const [{ file, manifest }, snapshot, snapshotStats] = await Promise.all([
    readFourCgsManifest(assetPath), readFile(snapshotPath), stat(snapshotPath),
  ]);
  const compression = manifest.compressionV26 ?? {};
  const encodedPointCount = compression.encodedPointCount
    ?? manifest.segments.reduce((sum, segment) => sum + segment.gaussianCount, 0);
  const originalPointCount = compression.originalPointCount ?? encodedPointCount;
  const deletedPointCount = compression.deletedPointCount ?? Math.max(0, originalPointCount - encodedPointCount);
  const checks = [
    ['fileBytes', item.fileBytes, file.length],
    ['sourceBytes', item.sourceBytes, manifest.sourceBytes],
    ['frameCount', item.frameCount, manifest.uniqueFrameCount],
    ['segmentCount', item.segmentCount, manifest.segments.length],
    ['gaussianCount', item.gaussianCount, encodedPointCount],
    ['sourceGaussianCount', item.sourceGaussianCount, originalPointCount],
    ['deletedGaussianCount', item.deletedGaussianCount, deletedPointCount],
    ['frameRange[0]', item.frameRange?.[0], manifest.firstFrame],
    ['frameRange[1]', item.frameRange?.[1], manifest.lastFrame],
    ['codecName', item.codecName, manifest.codecName],
  ];
  for (const [label, actual, expected] of checks) {
    if (actual !== expected) throw new Error(`${item.id}.${label}: catalog=${actual}, file=${expected}`);
  }
  const dimensions = webpDimensions(snapshot);
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0 || dimensions.width > 640 || dimensions.height > 400) {
    throw new Error(`${item.id}: invalid or oversized WebP snapshot.`);
  }
  if (snapshotStats.size < 2_000) throw new Error(`${item.id}: snapshot is unexpectedly small.`);
}

// #WDD-gpt 2026-08-17 - public/4cgs 新增文件后必须同步快照和说明，防止相册悄悄漏项。
if (assetFiles.join('\n') !== catalogFiles.sort().join('\n')) {
  throw new Error(`Gallery manifest does not exactly cover public/4cgs.\nFiles: ${assetFiles.join(', ')}\nCatalog: ${catalogFiles.join(', ')}`);
}

console.log(`4CGS gallery verification passed (${catalog.items.length} files with metadata and snapshots).`);
