import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { bankCount, buildExactBoundaryPermanentTrackMaps, readSegment } from './probe-fourcgs-lossless-rate.mjs';
import { buildCroppedMortonLayout, encodePositions, sha256 } from './fourcgs-prs-codec.mjs';
import { decodeV21StructuredStream, encodeV21StructuredStream } from './fourcgs-v21-lossless-codec.mjs';

const SEGMENT_PATTERN = /^segment_(\d+)_(\d+)\.raw4d$/;

function manifestFromContainer(bytes) {
  const length = bytes.readUInt32LE(8);
  return JSON.parse(bytes.subarray(12, 12 + length).toString('utf8'));
}

// #WDD-gpt 2026-08-16 - 针对 alpha 深度序敏感场景实测更细 Position 步长的真实 XZ 字节和硬误差，不按单一片段拍阈值。
async function main() {
  const sourceDirectory = resolve(process.argv[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16');
  const containerPath = resolve(process.argv[3] ?? 'artifacts/compression_v2_20260816/collected_master_ply4_cleaned_fp16_v2_4.4cgs');
  const outputPath = resolve(process.argv[4] ?? 'artifacts/compression_v2_20260816/V25_POSITION_RD.json');
  const steps = (process.argv[5] ?? '0.0005,0.000625,0.0007').split(',').map(Number);
  const started = performance.now();
  const names = (await readdir(sourceDirectory)).filter((name) => SEGMENT_PATTERN.test(name))
    .sort((left, right) => Number(SEGMENT_PATTERN.exec(left)[1]) - Number(SEGMENT_PATTERN.exec(right)[1]));
  const segments = [];
  for (const name of names) segments.push(await readSegment(join(sourceDirectory, name)));
  const container = await readFile(containerPath);
  const manifest = manifestFromContainer(container);
  const permanent = buildExactBoundaryPermanentTrackMaps(segments);
  const layout = buildCroppedMortonLayout(segments, permanent, manifest.crop.center, manifest.crop.halfExtent);
  const bankCounts = segments.map((segment) => bankCount(segment, 'xyz_bank'));
  const candidates = [];
  for (const step of steps) {
    process.stderr.write(`V2.5 Position step ${step}...\n`);
    const position = encodePositions(segments, layout, bankCounts, {
      center: manifest.crop.center, halfExtent: manifest.crop.halfExtent, step, maximumError: 0.005, cellSize: 0.5,
    });
    const stored = await encodeV21StructuredStream('prs_position', position.encoded, manifest);
    const restored = await decodeV21StructuredStream('prs_position', stored.encoded, manifest);
    if (!restored.equals(position.encoded)) throw new Error(`Position step ${step} round-trip failed.`);
    candidates.push({
      step, innerBytes: position.encoded.length, innerSha256: sha256(position.encoded),
      storedBytes: stored.encoded.length, storedSha256: sha256(stored.encoded), metrics: position.metrics,
    });
  }
  const report = { version: '4CGS V2.5 Position RD', sourceDirectory, containerPath, candidates, elapsedSeconds: (performance.now() - started) / 1000 };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}

await main();
