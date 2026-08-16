import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { constants, brotliCompressSync, deflateSync } from 'node:zlib';
import { bankCount, buildExactBoundaryPermanentTrackMaps, readSegment } from './probe-fourcgs-lossless-rate.mjs';
import { buildCroppedMortonLayout, sha256 } from './fourcgs-prs-codec.mjs';
import { encodeScalarRq } from './fourcgs-scalar-rq-codec.mjs';
import { encodeTemporalAttribute } from './fourcgs-temporal-attribute-codec.mjs';

const SEGMENT_PATTERN = /^segment_(\d+)_(\d+)\.raw4d$/;

function manifestFromContainer(bytes) {
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

class ByteWriter {
  constructor() { this.bytes = []; }
  byte(value) { this.bytes.push(value & 0xff); }
  uint(value) {
    let remaining = value;
    while (remaining >= 128) { this.byte((remaining % 128) | 0x80); remaining = Math.floor(remaining / 128); }
    this.byte(remaining);
  }
  sint(value) { this.uint(value >= 0 ? value * 2 : -value * 2 - 1); }
  finish() { return Buffer.from(this.bytes); }
}

function orderedHalf(bits) {
  return bits & 0x8000 ? (~bits & 0xffff) : (bits ^ 0x8000);
}

function residualPayload(sourceBits, decodedBaseBits, observationCount, mode) {
  const writers = [new ByteWriter(), new ByteWriter(), new ByteWriter()];
  for (let observation = 0; observation < observationCount; observation += 1) {
    const offset = observation * 4;
    const base = orderedHalf(decodedBaseBits[observation]);
    const values = [1, 2, 3].map((dimension) => orderedHalf(sourceBits[offset + dimension]));
    if (mode === 'base') {
      for (let index = 0; index < 3; index += 1) writers[index].sint(values[index] - base);
    } else if (mode === 'chain') {
      writers[0].sint(values[0] - base);
      writers[1].sint(values[1] - values[0]);
      writers[2].sint(values[2] - values[1]);
    } else if (mode === 'trajectory') {
      writers[0].sint(values[2] - base);
      writers[1].sint(values[0] - Math.round((base * 2 + values[2]) / 3));
      writers[2].sint(values[1] - Math.round((base + values[2] * 2) / 3));
    } else throw new Error(`Unsupported opacity residual mode ${mode}.`);
  }
  return Buffer.concat(writers.map((writer) => writer.finish()));
}

function fixedChainPayload(sourceBits, decodedBaseBits, observationCount, operation) {
  const valuesPerDimension = observationCount;
  const output = Buffer.allocUnsafe(valuesPerDimension * 3 * 2);
  const previousCodes = new Uint16Array(3);
  const previousPreviousCodes = new Uint16Array(3);
  for (let observation = 0; observation < observationCount; observation += 1) {
    const offset = observation * 4;
    let previous = orderedHalf(decodedBaseBits[observation]);
    for (let dimension = 1; dimension < 4; dimension += 1) {
      const value = orderedHalf(sourceBits[offset + dimension]);
      const chainOperation = operation === 'xor' ? 'xor' : 'delta';
      const coded = chainOperation === 'xor' ? value ^ previous : (value - previous) & 0xffff;
      const codeIndex = dimension - 1;
      let stored = coded;
      if (operation === 'delta-spatial') stored = (coded - previousCodes[codeIndex]) & 0xffff;
      else if (operation === 'delta-spatial2') stored = (coded - 2 * previousCodes[codeIndex] + previousPreviousCodes[codeIndex]) & 0xffff;
      else if (operation === 'delta-spatial-xor') stored = coded ^ previousCodes[codeIndex];
      const plane = (dimension - 1) * valuesPerDimension * 2;
      output[plane + observation] = stored & 0xff;
      output[plane + valuesPerDimension + observation] = stored >>> 8;
      previousPreviousCodes[codeIndex] = previousCodes[codeIndex];
      previousCodes[codeIndex] = coded;
      previous = value;
    }
  }
  return output;
}

function brotli(raw) {
  return brotliCompressSync(raw, { params: {
    [constants.BROTLI_PARAM_QUALITY]: 11,
    [constants.BROTLI_PARAM_LGWIN]: 24,
  } });
}

// #WDD-gpt 2026-08-16 - 仅量化不敏感的 Opacity 首 bank，并用可逆轨迹残差保存后三个 bank，修复快速运动重影且控制在 60M。
async function main() {
  const sourceDirectory = resolve(process.argv[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16');
  const containerPath = resolve(process.argv[3] ?? 'artifacts/compression_v2_20260816/collected_master_ply4_cleaned_fp16_v2_4.4cgs');
  const outputDirectory = resolve(process.argv[4] ?? 'artifacts/compression_v2_20260816/v25_opacity_hybrid_probe');
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
  let exactTemporalReport = null;
  if (!process.argv.includes('--quick')) {
    const exactTemporal = encodeTemporalAttribute(segments, layout, {
      prefix: 'opacity_bank', components: [''],
      bankCounts: segments.map((segment) => bankCount(segment, 'opacity_bank')),
      exactHalf: true,
    });
    const exactTemporalPath = join(outputDirectory, 'exact-temporal.bin');
    await writeFile(exactTemporalPath, exactTemporal.encoded);
    exactTemporalReport = {
      path: exactTemporalPath, rawBytes: exactTemporal.encoded.length, storedBytes: exactTemporal.encoded.length,
      projectedContainerBytes: (await readFile(containerPath)).length
        - manifest.streams.find((stream) => stream.name === 'mixsc_opacity').storedBytes + exactTemporal.encoded.length,
      rawSha256: sha256(exactTemporal.encoded), storedSha256: sha256(exactTemporal.encoded), metrics: exactTemporal.metrics,
    };
  }
  const bank0 = new Uint16Array(opacity.observationCount);
  for (let observation = 0; observation < opacity.observationCount; observation += 1) bank0[observation] = opacity.bits[observation * 4];
  const candidates = [];
  const scalarCandidates = [];
  const policies = [
    { name: 'b8-a003', bits: 8, maximumError: 0.003 },
    { name: 'b7-a003', bits: 7, maximumError: 0.003 },
    { name: 'b7-a005', bits: 7, maximumError: 0.005 },
    { name: 'b6-a005', bits: 6, maximumError: 0.005 },
  ];
  for (const policy of process.argv.includes('--quick') ? policies.slice(0, 1) : policies) {
    const scalar = encodeScalarRq(bank0, opacity.observationCount, 1, {
      bitsByDimension: [policy.bits], predictors: [-1], transform: 'opacityAlpha', maximumError: policy.maximumError, sampleCount: 32768,
    });
    const scalarPath = join(outputDirectory, `bank0-${policy.name}.bin`);
    await writeFile(scalarPath, scalar.encoded);
    scalarCandidates.push({ ...policy, path: scalarPath, bytes: scalar.encoded.length, metrics: scalar.metrics, sha256: sha256(scalar.encoded) });
    const raw = residualPayload(opacity.bits, scalar.decodedBits, opacity.observationCount, 'chain');
    for (const [compression, stored] of [['deflate', deflateSync(raw, { level: 9 })], ['brotli', brotli(raw)]]) {
      const path = join(outputDirectory, `${policy.name}-chain-${compression}.bin`);
      await writeFile(path, stored);
      candidates.push({
        policy: policy.name, mode: 'chain', compression, path, rawBytes: raw.length, storedBytes: stored.length,
        totalHybridBytes: scalar.encoded.length + stored.length,
        projectedContainerBytes: (await readFile(containerPath)).length
          - manifest.streams.find((stream) => stream.name === 'mixsc_opacity').storedBytes
          + scalar.encoded.length + stored.length,
        sha256: sha256(stored),
      });
    }
    for (const operation of ['delta', 'xor', 'delta-spatial', 'delta-spatial2', 'delta-spatial-xor']) {
      const fixed = fixedChainPayload(opacity.bits, scalar.decodedBits, opacity.observationCount, operation);
      for (const [compression, stored] of [['deflate', deflateSync(fixed, { level: 9 })], ['brotli', brotli(fixed)]]) {
        const path = join(outputDirectory, `${policy.name}-fixed-${operation}-${compression}.bin`);
        await writeFile(path, stored);
        candidates.push({
          policy: policy.name, mode: `fixed-${operation}`, compression, path, rawBytes: fixed.length, storedBytes: stored.length,
          totalHybridBytes: scalar.encoded.length + stored.length,
          projectedContainerBytes: (await readFile(containerPath)).length
            - manifest.streams.find((stream) => stream.name === 'mixsc_opacity').storedBytes
            + scalar.encoded.length + stored.length,
          sha256: sha256(stored),
        });
      }
    }
  }
  const report = {
    version: '4CGS V2.5 hybrid Opacity probe', observationCount: opacity.observationCount,
    exactTemporal: exactTemporalReport,
    scalarCandidates,
    candidates,
  };
  const reportPath = join(outputDirectory, 'report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ reportPath, scalarCandidates: scalarCandidates.map(({ name, bytes, metrics }) => ({ name, bytes, maximumError: metrics.measuredMaximumError })), candidates }, null, 2));
}

await main();
