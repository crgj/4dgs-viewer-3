import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { bankCount, buildExactBoundaryPermanentTrackMaps, readSegment } from './probe-fourcgs-lossless-rate.mjs';
import { buildCroppedMortonLayout, sha256 } from './fourcgs-prs-codec.mjs';
import { decodeScalarRq, encodeScalarRq } from './fourcgs-scalar-rq-codec.mjs';

const SEGMENT_PATTERN = /^segment_(\d+)_(\d+)\.raw4d$/;

function manifestFromContainer(bytes) {
  if (bytes.subarray(0, 8).toString('ascii') !== '4CGSPRS2') throw new Error('Unsupported 4CGS container.');
  const length = bytes.readUInt32LE(8);
  return JSON.parse(bytes.subarray(12, 12 + length).toString('utf8'));
}

function opacityVectors(segments, layout) {
  const dimensions = bankCount(segments[0], 'opacity_bank');
  const observationCount = layout.activeSlots.reduce((sum, slots) => sum + slots.length, 0);
  const bits = new Uint16Array(observationCount * dimensions);
  let observation = 0;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    if (bankCount(segment, 'opacity_bank') !== dimensions) throw new Error('Opacity bank count changed.');
    const indices = Array.from({ length: dimensions }, (_, bank) => segment.propertyIndex.get(`opacity_bank_${bank}`));
    for (const slot of layout.activeSlots[segmentIndex]) {
      const local = layout.slotToLocal[segmentIndex][slot];
      const source = local * segment.propertyNames.length;
      for (let dimension = 0; dimension < dimensions; dimension += 1) {
        bits[observation * dimensions + dimension] = segment.rows[source + indices[dimension]];
      }
      observation += 1;
    }
  }
  return { bits, observationCount, dimensions };
}

const POLICIES = [
  { name: 'a0015-b8x12', maximumError: 0.0015, bitsByDimension: [8, 12, 12, 12] },
  { name: 'a0015-b9x12', maximumError: 0.0015, bitsByDimension: [9, 12, 12, 12] },
  { name: 'a0015-b10x12', maximumError: 0.0015, bitsByDimension: [10, 12, 12, 12] },
  { name: 'a0015-b12', maximumError: 0.0015, bitsByDimension: [12, 12, 12, 12] },
  { name: 'a0010-b10x13', maximumError: 0.001, bitsByDimension: [10, 13, 13, 13] },
  { name: 'a0010-b11x13', maximumError: 0.001, bitsByDimension: [11, 13, 13, 13] },
  { name: 'a00075-b11x13', maximumError: 0.00075, bitsByDimension: [11, 13, 13, 13] },
  { name: 'a00050-b12x14', maximumError: 0.0005, bitsByDimension: [12, 14, 14, 14] },
];

// #WDD-gpt 2026-08-16 - V2.5 专门搜索高精度首帧 Opacity 码率档，修复大量透明高斯叠加后的快速运动鬼影。
async function main() {
  const sourceDirectory = resolve(process.argv[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16');
  const containerPath = resolve(process.argv[3] ?? 'artifacts/compression_v2_20260816/collected_master_ply4_cleaned_fp16_v2_4.4cgs');
  const outputDirectory = resolve(process.argv[4] ?? 'artifacts/compression_v2_20260816/v25_opacity_rd');
  const outputPath = resolve(process.argv[5] ?? 'artifacts/compression_v2_20260816/V25_OPACITY_RD.json');
  const started = performance.now();
  const names = (await readdir(sourceDirectory))
    .filter((name) => SEGMENT_PATTERN.test(name))
    .sort((left, right) => Number(SEGMENT_PATTERN.exec(left)[1]) - Number(SEGMENT_PATTERN.exec(right)[1]));
  const segments = [];
  for (const name of names) segments.push(await readSegment(join(sourceDirectory, name)));
  const manifest = manifestFromContainer(await readFile(containerPath));
  const permanent = buildExactBoundaryPermanentTrackMaps(segments);
  const layout = buildCroppedMortonLayout(segments, permanent, manifest.crop.center, manifest.crop.halfExtent);
  const opacity = opacityVectors(segments, layout);
  await mkdir(outputDirectory, { recursive: true });
  const candidates = [];
  for (const policy of POLICIES) {
    process.stderr.write(`V2.5 Opacity ${policy.name}\n`);
    const encoded = encodeScalarRq(opacity.bits, opacity.observationCount, opacity.dimensions, {
      bitsByDimension: policy.bitsByDimension,
      predictors: [-1, 0, 0, 0],
      transform: 'opacityAlpha',
      maximumError: policy.maximumError,
      sampleCount: 32768,
    });
    const decoded = decodeScalarRq(encoded.encoded);
    if (decoded.bits.length !== encoded.decodedBits.length) throw new Error(`${policy.name} decoded length mismatch.`);
    for (let index = 0; index < decoded.bits.length; index += 1) {
      if (decoded.bits[index] !== encoded.decodedBits[index]) throw new Error(`${policy.name} round-trip mismatch at ${index}.`);
    }
    const streamPath = join(outputDirectory, `${policy.name}.bin`);
    await writeFile(streamPath, encoded.encoded);
    candidates.push({
      ...policy,
      streamPath,
      streamBytes: encoded.encoded.length,
      streamBytesM: encoded.encoded.length / 1_000_000,
      projectedContainerBytes: manifest.streams.reduce((sum, stream) => sum + stream.storedBytes, 12)
        + JSON.stringify(manifest).length - manifest.streams.find((stream) => stream.name === 'mixsc_opacity').storedBytes
        + encoded.encoded.length,
      sha256: sha256(encoded.encoded),
      metrics: encoded.metrics,
    });
    await writeFile(outputPath, `${JSON.stringify({ status: 'in-progress', candidates }, null, 2)}\n`);
  }
  const report = {
    version: '4CGS V2.5 Opacity rate-distortion probe',
    sourceDirectory,
    containerPath,
    currentContainerBytes: (await readFile(containerPath)).length,
    currentOpacityBytes: manifest.streams.find((stream) => stream.name === 'mixsc_opacity').storedBytes,
    targetContainerBytes: 60_000_000,
    candidates,
    elapsedSeconds: (performance.now() - started) / 1000,
    status: 'complete',
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ outputPath, candidates: candidates.map((candidate) => ({
    name: candidate.name,
    streamBytes: candidate.streamBytes,
    maximumError: candidate.metrics.measuredMaximumError,
    rmse: candidate.metrics.measuredRmse,
  })), elapsedSeconds: report.elapsedSeconds }));
}

await main();
