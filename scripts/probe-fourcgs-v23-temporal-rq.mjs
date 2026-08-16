import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { bankCount, buildExactBoundaryPermanentTrackMaps, readSegment } from './probe-fourcgs-lossless-rate.mjs';
import { buildCroppedMortonLayout, sha256 } from './fourcgs-prs-codec.mjs';
import { decodeTemporalRq, encodeTemporalRq } from './fourcgs-temporal-rq-codec.mjs';

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

function propertyName(prefix, bank, component) {
  return component === '' ? `${prefix}_${bank}` : `${prefix}_${bank}_${component}`;
}

function trackVectors(segments, layout, prefix, components) {
  const bankCounts = segments.map((segment) => bankCount(segment, prefix));
  if (!bankCounts.every((count) => count === bankCounts[0])) {
    throw new Error(`TemporalRQ requires a stable ${prefix} bank count: ${bankCounts.join(', ')}`);
  }
  const dimensions = bankCounts[0] * components.length;
  const observationCount = layout.activeSlots.reduce((sum, slots) => sum + slots.length, 0);
  const bits = new Uint16Array(observationCount * dimensions);
  let observation = 0;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const inverse = layout.slotToLocal[segmentIndex];
    const indices = Array.from({ length: bankCounts[segmentIndex] }, (_, bank) => (
      components.map((component) => segment.propertyIndex.get(propertyName(prefix, bank, component)))
    )).flat();
    if (indices.some((index) => index === undefined)) throw new Error(`Missing ${prefix} property in ${segment.path}`);
    for (const slot of layout.activeSlots[segmentIndex]) {
      const local = inverse[slot];
      const sourceOffset = local * segment.propertyNames.length;
      for (let dimension = 0; dimension < dimensions; dimension += 1) {
        bits[observation * dimensions + dimension] = segment.rows[sourceOffset + indices[dimension]];
      }
      observation += 1;
    }
  }
  return { bits, observationCount, dimensions, bankCounts };
}

function candidate(name, maximumError, endpointBits, middleBits) {
  return {
    name,
    maximumError,
    bitsByDimension: [
      endpointBits, endpointBits, endpointBits,
      middleBits, middleBits, middleBits,
      middleBits, middleBits, middleBits,
      endpointBits, endpointBits, endpointBits,
    ],
  };
}

// #WDD-gpt 2026-08-16 - V2.3 将 MesonGS++ 的离散混合位宽搜索与 RD4DGS 的时间平滑残差结合，实测 Scale 真实码流和严格误差上界。
async function main() {
  const sourceDirectory = resolve(process.argv[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16');
  const manifestPath = resolve(process.argv[3] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16_attribute_so3_hybrid.4cgs.json');
  const outputPath = resolve(process.argv[4] ?? 'artifacts/compression_v2_20260816/v23_scale_temporal_rq_probe.json');
  await mkdir(dirname(outputPath), { recursive: true });
  const started = performance.now();
  const segments = await readSegments(sourceDirectory);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const permanent = buildExactBoundaryPermanentTrackMaps(segments);
  const layout = buildCroppedMortonLayout(segments, permanent, manifest.crop.center, manifest.crop.halfExtent);
  const vectors = trackVectors(segments, layout, 'scale_bank', ['0', '1', '2']);
  const policies = [
    candidate('e005-b9m7', 0.005, 9, 7),
    candidate('e005-b8m6', 0.005, 8, 6),
    candidate('e008-b8m6', 0.008, 8, 6),
    candidate('e008-b7m5', 0.008, 7, 5),
    candidate('e012-b8m6', 0.012, 8, 6),
    candidate('e012-b7m5', 0.012, 7, 5),
    candidate('e016-b7m5', 0.016, 7, 5),
    candidate('e024-b7m5', 0.024, 7, 5),
  ];
  const candidates = [];
  for (const policy of policies) {
    process.stderr.write(`V2.3 TemporalRQ ${policy.name}...\n`);
    const encoded = encodeTemporalRq(
      vectors.bits,
      layout.activeSlots,
      vectors.bankCounts[0],
      3,
      {
        domain: 'identity',
        maximumError: policy.maximumError,
        residualMaximumError: 1e6,
        bitsByDimension: policy.bitsByDimension,
        sampleCount: 32768,
      },
    );
    const decoded = decodeTemporalRq(encoded.encoded, layout.activeSlots);
    if (decoded.bits.length !== encoded.decodedBits.length) throw new Error(`${policy.name} decoded value count mismatch.`);
    for (let index = 0; index < decoded.bits.length; index += 1) {
      if (decoded.bits[index] !== encoded.decodedBits[index]) throw new Error(`${policy.name} round-trip mismatch at ${index}.`);
    }
    candidates.push({
      ...policy,
      encodedBytes: encoded.encoded.length,
      encodedSha256: sha256(encoded.encoded),
      projectedContainerBytes: 67_999_858 - 18_561_304 + encoded.encoded.length,
      projectedContainerM: (67_999_858 - 18_561_304 + encoded.encoded.length) / 1_000_000,
      ...encoded.metrics,
    });
    await writeFile(outputPath, `${JSON.stringify({ experiment: 'in-progress', sourceDirectory, manifestPath, candidates }, null, 2)}\n`);
    if (global.gc) global.gc();
  }
  const report = {
    experiment: 'Compression V2.3 Scale temporal residual mixed-precision RQ probe',
    sourceDirectory,
    manifestPath,
    gaussianInstances: vectors.observationCount,
    permanentTracks: layout.slotCount,
    bankCounts: vectors.bankCounts,
    v22ContainerBytes: 67_999_858,
    v22ScaleBytes: 18_561_304,
    candidates,
    elapsedSeconds: (performance.now() - started) / 1000,
  };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}

await main();
