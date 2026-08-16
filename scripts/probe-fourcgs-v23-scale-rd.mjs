import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { bankCount, buildExactBoundaryPermanentTrackMaps, readSegment } from './probe-fourcgs-lossless-rate.mjs';
import { buildCroppedMortonLayout, sha256 } from './fourcgs-prs-codec.mjs';
import { encodeTemporalAttribute } from './fourcgs-temporal-attribute-codec.mjs';
import { decodeV21StructuredStream, encodeV22StructuredStream } from './fourcgs-v21-lossless-codec.mjs';

const SEGMENT_PATTERN = /^segment_(\d+)_(\d+)\.raw4d$/;

async function readSegments(directory) {
  const names = (await readdir(directory))
    .filter((name) => SEGMENT_PATTERN.test(name))
    .sort((left, right) => Number(SEGMENT_PATTERN.exec(left)[1]) - Number(SEGMENT_PATTERN.exec(right)[1]));
  if (names.length !== 6) throw new Error(`Expected six RAW4D segments, found ${names.length}.`);
  const segments = [];
  for (const name of names) segments.push(await readSegment(join(directory, name)));
  return segments;
}

// #WDD-gpt 2026-08-16 - 参照 MesonGS++ 的目标码率混合精度搜索，对 Scale 的时间残差实测离散量化档，而不是用理论位宽估算。
async function main() {
  const sourceDirectory = resolve(process.argv[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16');
  const manifestPath = resolve(process.argv[3] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16_attribute_so3_hybrid.4cgs.json');
  const outputPath = resolve(process.argv[4] ?? 'artifacts/compression_v2_20260816/v23_scale_rd_probe.json');
  const steps = (process.argv[5] ?? '0.00048828125,0.0009765625,0.001953125,0.00390625,0.0078125,0.015625')
    .split(',').map(Number).filter((value) => Number.isFinite(value) && value > 0);
  const started = performance.now();
  const segments = await readSegments(sourceDirectory);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const permanent = buildExactBoundaryPermanentTrackMaps(segments);
  const layout = buildCroppedMortonLayout(segments, permanent, manifest.crop.center, manifest.crop.halfExtent);
  const bankCounts = segments.map((segment) => bankCount(segment, 'scale_bank'));
  const candidates = [];
  for (const step of steps) {
    process.stderr.write(`V2.3 Scale step ${step}...\n`);
    const encoded = encodeTemporalAttribute(segments, layout, {
      prefix: 'scale_bank',
      components: ['0', '1', '2'],
      bankCounts,
      exactHalf: false,
      step,
    });
    const wrapped = await encodeV22StructuredStream('tattr_scale', encoded.encoded);
    const restored = await decodeV21StructuredStream('tattr_scale', wrapped.encoded, manifest);
    if (!restored.equals(encoded.encoded)) throw new Error(`Scale step ${step} structured round-trip failed.`);
    candidates.push({
      step,
      innerBytes: encoded.encoded.length,
      innerSha256: sha256(encoded.encoded),
      storedBytes: wrapped.encoded.length,
      storedSha256: sha256(wrapped.encoded),
      measuredRmse: encoded.metrics.measuredRmse,
      measuredMaximumLogError: encoded.metrics.measuredMaximumError,
      relativeRadiusErrorAtMaximum: Math.expm1(encoded.metrics.measuredMaximumError),
      streamBytes: encoded.metrics.streams,
    });
  }
  const report = {
    experiment: 'Compression V2.3 Scale target-rate quantization probe',
    sourceDirectory,
    manifestPath,
    gaussianInstances: segments.reduce((sum, segment) => sum + segment.count, 0),
    permanentTracks: layout.slotCount,
    bankCounts,
    v22ScaleBytes: 18_561_304,
    candidates,
    elapsedSeconds: (performance.now() - started) / 1000,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}

await main();
