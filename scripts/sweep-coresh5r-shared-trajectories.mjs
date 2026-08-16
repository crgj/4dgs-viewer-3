import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { buildSlotMaps, readSegment } from './probe-fourcgs-lossless-rate.mjs';
import { extractRawStream, labelsInSourceOrder } from './repack-coresh5r-temporal.mjs';

const SEGMENT_PATTERN = /^segment_(\d+)_(\d+)\.raw4d$/;
const HEADER_BYTES = 20;
const MEAN_BYTES = 45 * 2;
const CODEBOOK_BYTES = 5 * 256 * 45 * 2;
const floatView = new DataView(new ArrayBuffer(4));

function halfToFloat(bits) {
  const sign = (bits & 0x8000) << 16;
  let exponent = (bits >>> 10) & 0x1f;
  let mantissa = bits & 0x03ff;
  if (exponent === 0) {
    if (mantissa === 0) {
      floatView.setUint32(0, sign, true);
      return floatView.getFloat32(0, true);
    }
    while ((mantissa & 0x0400) === 0) {
      mantissa <<= 1;
      exponent -= 1;
    }
    exponent += 1;
    mantissa &= ~0x0400;
  } else if (exponent === 31) {
    floatView.setUint32(0, sign | 0x7f800000 | (mantissa << 13), true);
    return floatView.getFloat32(0, true);
  }
  exponent += 127 - 15;
  floatView.setUint32(0, sign | (exponent << 23) | (mantissa << 13), true);
  return floatView.getFloat32(0, true);
}

function decodeCodebooks(payload) {
  const values = new Float32Array(5 * 256 * 45);
  const offset = HEADER_BYTES + MEAN_BYTES;
  for (let index = 0; index < values.length; index += 1) {
    values[index] = halfToFloat(payload.readUInt16LE(offset + index * 2));
  }
  return values;
}

function labelDifference(codebooks, previous, current) {
  let square = 0;
  let maximum = 0;
  for (let dimension = 0; dimension < 45; dimension += 1) {
    let difference = 0;
    for (let level = 0; level < 5; level += 1) {
      difference += codebooks[(level * 256 + current[level]) * 45 + dimension]
        - codebooks[(level * 256 + previous[level]) * 45 + dimension];
    }
    square += difference * difference;
    maximum = Math.max(maximum, Math.abs(difference));
  }
  return { square, maximum };
}

function encodeThreshold(labelSets, slots, codebooks, maximumCoefficientError) {
  const totalInstances = labelSets.reduce((sum, labels) => sum + labels.length / 5, 0);
  const mask = new Uint8Array(Math.ceil(totalInstances / 8));
  const updates = new Uint8Array(totalInstances * 5);
  const state = new Uint8Array(slots.slotCount * 5);
  const initialized = new Uint8Array(slots.slotCount);
  let instance = 0;
  let updateCount = 0;
  let suppressedSquare = 0;
  let suppressedMaximum = 0;
  for (let segmentIndex = 0; segmentIndex < labelSets.length; segmentIndex += 1) {
    const inverse = slots.slotToLocal[segmentIndex];
    const labels = labelSets[segmentIndex];
    const continued = slots.continuedLocal[segmentIndex];
    for (let slot = 0; slot < inverse.length; slot += 1) {
      const local = inverse[slot];
      if (local < 0) continue;
      const current = labels.subarray(local * 5, local * 5 + 5);
      const stateOffset = slot * 5;
      const previous = state.subarray(stateOffset, stateOffset + 5);
      let update = !initialized[slot] || !continued[local];
      let difference = { square: 0, maximum: 0 };
      if (!update) {
        difference = labelDifference(codebooks, previous, current);
        update = difference.maximum > maximumCoefficientError;
      }
      if (update) {
        mask[instance >>> 3] |= 1 << (instance & 7);
        updates.set(current, updateCount * 5);
        state.set(current, stateOffset);
        initialized[slot] = 1;
        updateCount += 1;
      } else {
        suppressedSquare += difference.square;
        suppressedMaximum = Math.max(suppressedMaximum, difference.maximum);
      }
      instance += 1;
    }
  }
  const packedUpdates = updates.subarray(0, updateCount * 5);
  const storedMask = deflateSync(mask, { level: 9 });
  const storedUpdates = deflateSync(packedUpdates, { level: 9 });
  if (inflateSync(storedMask).length !== mask.length || inflateSync(storedUpdates).length !== packedUpdates.length) {
    throw new Error('Shared CoReSH trajectory stream round trip failed.');
  }
  return {
    storedMask,
    storedUpdates,
    metrics: {
    maximumCoefficientError,
    updateCount,
    updateFraction: updateCount / totalInstances,
    maskBytes: storedMask.length,
    labelBytes: storedUpdates.length,
    totalBytes: HEADER_BYTES + MEAN_BYTES + CODEBOOK_BYTES + storedMask.length + storedUpdates.length,
    additionalRmseVsIndependentLabels: Math.sqrt(suppressedSquare / (totalInstances * 45)),
    additionalMaximumCoefficientError: suppressedMaximum,
    },
  };
}

function validateExactStream(candidate, labelSets, slots) {
  const mask = inflateSync(candidate.storedMask);
  const updates = inflateSync(candidate.storedUpdates);
  const state = new Uint8Array(slots.slotCount * 5);
  const initialized = new Uint8Array(slots.slotCount);
  let instance = 0;
  let updateOffset = 0;
  for (let segmentIndex = 0; segmentIndex < labelSets.length; segmentIndex += 1) {
    const inverse = slots.slotToLocal[segmentIndex];
    const expected = labelSets[segmentIndex];
    for (let slot = 0; slot < inverse.length; slot += 1) {
      const local = inverse[slot];
      if (local < 0) continue;
      const stateOffset = slot * 5;
      if ((mask[instance >>> 3] & (1 << (instance & 7))) !== 0) {
        state.set(updates.subarray(updateOffset, updateOffset + 5), stateOffset);
        initialized[slot] = 1;
        updateOffset += 5;
      }
      if (!initialized[slot]) throw new Error(`Missing initial SH labels for slot ${slot}.`);
      for (let level = 0; level < 5; level += 1) {
        if (state[stateOffset + level] !== expected[local * 5 + level]) {
          throw new Error(`Shared SH label mismatch at segment ${segmentIndex}, slot ${slot}.`);
        }
      }
      instance += 1;
    }
  }
  if (updateOffset !== updates.length) throw new Error(`Unused shared SH updates: ${updates.length - updateOffset}.`);
}

async function main() {
  const sourceDirectory = resolve(process.argv[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16');
  const sourceContainer = resolve(process.argv[3] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16.4cgs');
  const reportPath = resolve(process.argv[4] ?? 'artifacts/fourcgs_ts_coresh5r_shared_trajectory_sweep_20260815.json');
  const outputPath = reportPath.replace(/\.json$/i, '.exact.bin');
  const entries = (await readdir(sourceDirectory))
    .map((name) => ({ name, match: SEGMENT_PATTERN.exec(name) }))
    .filter((entry) => entry.match)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
  const segments = [];
  for (const entry of entries) segments.push(await readSegment(join(sourceDirectory, entry.name)));
  const { payload } = extractRawStream(await readFile(sourceContainer), 'coresh5r');
  const count = payload.readUInt32LE(8);
  const labelOffset = HEADER_BYTES + MEAN_BYTES + CODEBOOK_BYTES;
  const labels = inflateSync(payload.subarray(labelOffset, labelOffset + payload.readUInt32LE(16)));
  if (labels.length !== count * 5) throw new Error('Invalid shared CoReSH-5R label stream.');
  const slots = buildSlotMaps(segments);
  const labelSets = labelsInSourceOrder(segments, labels);
  const codebooks = decodeCodebooks(payload);
  const encodedCandidates = [0, 0.0025, 0.005, 0.01, 0.02, 0.03, 0.05]
    .map((threshold) => encodeThreshold(labelSets, slots, codebooks, threshold));
  const exact = encodedCandidates[0];
  validateExactStream(exact, labelSets, slots);
  const header = Buffer.alloc(32);
  header.write('C5T1SH01', 0, 'ascii');
  header.writeUInt32LE(slots.slotCount, 8);
  header.writeUInt32LE(count, 12);
  header.writeUInt16LE(segments.length, 16);
  header.writeUInt8(45, 18);
  header.writeUInt8(5, 19);
  header.writeUInt32LE(MEAN_BYTES + CODEBOOK_BYTES, 20);
  header.writeUInt32LE(exact.storedMask.length, 24);
  header.writeUInt32LE(exact.storedUpdates.length, 28);
  const exactStream = Buffer.concat([
    header,
    payload.subarray(HEADER_BYTES, HEADER_BYTES + MEAN_BYTES + CODEBOOK_BYTES),
    exact.storedMask,
    exact.storedUpdates,
  ]);
  await writeFile(outputPath, exactStream);
  const candidates = encodedCandidates.map((candidate) => candidate.metrics);
  const report = {
    sourceDirectory,
    sourceContainer,
    codec: 'shared-CoReSH-5R-with-bounded-trajectory-updates',
    gaussianInstanceCount: count,
    slotCount: slots.slotCount,
    originalSharedCoReShBytes: payload.length,
    originalSharedCoReShRmse: 0.012940440968050495,
    exactStreamPath: outputPath,
    exactStreamBytes: exactStream.length,
    exactLabelRoundTripValidated: true,
    candidates,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}

// #WDD-gpt 2026-08-15 - SH 续接仅复用误差不超过硬阈值的五级索引，其余点写更新例外以保护 PSNR。
await main();
