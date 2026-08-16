import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { bankCount, buildExactBoundaryPermanentTrackMaps, readSegment } from './probe-fourcgs-lossless-rate.mjs';
import { buildCroppedMortonLayout, sha256 } from './fourcgs-prs-codec.mjs';
import { decodeScalarRq, encodeScalarRq } from './fourcgs-scalar-rq-codec.mjs';
import { encodeSo3Rotations } from './fourcgs-so3-temporal-codec.mjs';
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

function trackVectors(segments, layout, prefix, components) {
  const bankCounts = segments.map((segment) => bankCount(segment, prefix));
  if (!bankCounts.every((count) => count === bankCounts[0])) throw new Error(`Unstable ${prefix} bank count.`);
  const dimensions = bankCounts[0] * components.length;
  const observationCount = layout.activeSlots.reduce((sum, slots) => sum + slots.length, 0);
  const bits = new Uint16Array(observationCount * dimensions);
  let observation = 0;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const indices = Array.from({ length: bankCounts[segmentIndex] }, (_, bank) => components.map((component) => (
      segment.propertyIndex.get(component === '' ? `${prefix}_${bank}` : `${prefix}_${bank}_${component}`)
    ))).flat();
    for (const slot of layout.activeSlots[segmentIndex]) {
      const local = layout.slotToLocal[segmentIndex][slot];
      const sourceOffset = local * segment.propertyNames.length;
      for (let dimension = 0; dimension < dimensions; dimension += 1) {
        bits[observation * dimensions + dimension] = segment.rows[sourceOffset + indices[dimension]];
      }
      observation += 1;
    }
  }
  return { bits, observationCount, dimensions, bankCounts };
}

async function structured(name, payload, manifest) {
  const wrapped = await encodeV22StructuredStream(name, payload);
  const restored = await decodeV21StructuredStream(name, wrapped.encoded, manifest);
  if (!restored.equals(payload)) throw new Error(`${name} structured round-trip failed.`);
  return wrapped;
}

async function checkpoint(path, base, candidates) {
  await writeFile(path, `${JSON.stringify({ ...base, candidates, status: 'in-progress' }, null, 2)}\n`);
  if (global.gc) global.gc();
}

// #WDD-gpt 2026-08-16 - V2.3 对 Rotation/DC/Opacity 分配独立视觉误差预算，并以解码可逆的真实外层码流字节做率失真搜索。
async function main() {
  const sourceDirectory = resolve(process.argv[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16');
  const manifestPath = resolve(process.argv[3] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16_attribute_so3_hybrid.4cgs.json');
  const outputPath = resolve(process.argv[4] ?? 'artifacts/compression_v2_20260816/v23_attribute_rd_probe.json');
  await mkdir(dirname(outputPath), { recursive: true });
  const started = performance.now();
  const segments = await readSegments(sourceDirectory);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const permanent = buildExactBoundaryPermanentTrackMaps(segments);
  const layout = buildCroppedMortonLayout(segments, permanent, manifest.crop.center, manifest.crop.halfExtent);
  const candidates = [];
  const base = {
    experiment: 'Compression V2.3 Rotation DC Opacity target-rate probe',
    sourceDirectory,
    manifestPath,
    gaussianInstances: segments.reduce((sum, segment) => sum + segment.count, 0),
    permanentTracks: layout.slotCount,
    v22StoredBytes: { rotation: 10_709_220, dc: 7_909_700, opacity: 7_620_986 },
  };

  const rotationBanks = segments.map((segment) => bankCount(segment, 'rot_bank'));
  for (const policy of [
    { name: 'rot-s005-m015', stepDegrees: 0.05, maximumAngleDegrees: 0.15 },
    { name: 'rot-s010-m025', stepDegrees: 0.10, maximumAngleDegrees: 0.25 },
    { name: 'rot-s020-m050', stepDegrees: 0.20, maximumAngleDegrees: 0.50 },
  ]) {
    process.stderr.write(`V2.3 ${policy.name}...\n`);
    const encoded = encodeSo3Rotations(segments, layout, rotationBanks, { bits: 12, ...policy });
    const wrapped = await structured('so3_rotation', encoded.encoded, manifest);
    candidates.push({
      attribute: 'rotation',
      ...policy,
      innerBytes: encoded.encoded.length,
      storedBytes: wrapped.encoded.length,
      savedBytes: base.v22StoredBytes.rotation - wrapped.encoded.length,
      innerSha256: sha256(encoded.encoded),
      storedSha256: sha256(wrapped.encoded),
      metrics: encoded.metrics,
    });
    await checkpoint(outputPath, base, candidates);
  }

  const dcBanks = segments.map((segment) => bankCount(segment, 'f_dc_bank'));
  for (const step of [0.00390625, 0.0078125, 0.015625, 0.03125]) {
    process.stderr.write(`V2.3 DC step ${step}...\n`);
    const encoded = encodeTemporalAttribute(segments, layout, {
      prefix: 'f_dc_bank', components: ['0', '1', '2'], bankCounts: dcBanks, exactHalf: false, step,
    });
    const wrapped = await structured('tattr_dc', encoded.encoded, manifest);
    candidates.push({
      attribute: 'dc',
      name: `dc-s${step}`,
      step,
      maximumRgbError: encoded.metrics.measuredMaximumError * 0.28209479177387814,
      innerBytes: encoded.encoded.length,
      storedBytes: wrapped.encoded.length,
      savedBytes: base.v22StoredBytes.dc - wrapped.encoded.length,
      innerSha256: sha256(encoded.encoded),
      storedSha256: sha256(wrapped.encoded),
      metrics: encoded.metrics,
    });
    await checkpoint(outputPath, base, candidates);
  }

  const opacity = trackVectors(segments, layout, 'opacity_bank', ['']);
  for (const policy of [
    { name: 'opacity-m005-b8x10', maximumError: 0.005, bitsByDimension: [8, 10, 10, 10] },
    { name: 'opacity-m008-b8x9', maximumError: 0.008, bitsByDimension: [8, 9, 9, 9] },
    { name: 'opacity-m012-b7x8', maximumError: 0.012, bitsByDimension: [7, 8, 8, 8] },
    { name: 'opacity-m020-b7', maximumError: 0.020, bitsByDimension: [7, 7, 7, 7] },
  ]) {
    process.stderr.write(`V2.3 ${policy.name}...\n`);
    const encoded = encodeScalarRq(opacity.bits, opacity.observationCount, opacity.dimensions, {
      bitsByDimension: policy.bitsByDimension,
      predictors: [-1, 0, 0, 0],
      transform: 'opacityAlpha',
      maximumError: policy.maximumError,
      sampleCount: 32768,
    });
    const decoded = decodeScalarRq(encoded.encoded);
    if (decoded.bits.length !== encoded.decodedBits.length) throw new Error(`${policy.name} decoded value count mismatch.`);
    for (let index = 0; index < decoded.bits.length; index += 1) {
      if (decoded.bits[index] !== encoded.decodedBits[index]) throw new Error(`${policy.name} round-trip mismatch at ${index}.`);
    }
    candidates.push({
      attribute: 'opacity',
      ...policy,
      innerBytes: encoded.encoded.length,
      storedBytes: encoded.encoded.length,
      savedBytes: base.v22StoredBytes.opacity - encoded.encoded.length,
      innerSha256: sha256(encoded.encoded),
      metrics: encoded.metrics,
    });
    await checkpoint(outputPath, base, candidates);
  }

  const report = { ...base, candidates, elapsedSeconds: (performance.now() - started) / 1000, status: 'complete' };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}

await main();
