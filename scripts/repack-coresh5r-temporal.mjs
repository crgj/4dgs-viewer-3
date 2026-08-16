import { open, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { buildSlotMaps, extract, readSegment } from './probe-fourcgs-lossless-rate.mjs';

const SEGMENT_PATTERN = /^segment_(\d+)_(\d+)\.raw4d$/;
const SH_HEADER_BYTES = 20;
const SH_MEAN_BYTES = 45 * 2;
const SH_CODEBOOK_BYTES = 5 * 256 * 45 * 2;

export function extractRawStream(container, name) {
  const manifestBytes = container.readUInt32LE(8);
  const manifest = JSON.parse(container.subarray(16, 16 + manifestBytes).toString('utf8'));
  let offset = 16 + manifestBytes;
  for (const stream of manifest.streams) {
    const stored = container.subarray(offset, offset + stream.stored_bytes);
    if (stream.name === name) {
      if (stream.compression !== 'raw') throw new Error(`${name} must be a raw stream.`);
      return { manifest, payload: stored };
    }
    offset += stream.stored_bytes;
  }
  throw new Error(`Missing ${name} stream.`);
}

function spreadMorton10(value) {
  let result = value & 0x3ff;
  result = (result | (result << 16)) & 0x030000ff;
  result = (result | (result << 8)) & 0x0300f00f;
  result = (result | (result << 4)) & 0x030c30c3;
  return (result | (result << 2)) & 0x09249249;
}

function roundTiesToEven(value) {
  const lower = Math.floor(value);
  const fraction = value - lower;
  if (fraction < 0.5) return lower;
  if (fraction > 0.5) return lower + 1;
  return lower % 2 === 0 ? lower : lower + 1;
}

function stableMortonOrder(segment) {
  const positionBanks = [];
  for (let bank = 0; bank < 11; bank += 1) {
    positionBanks.push(extract(segment, ['x', 'y', 'z'].map((component) => `xyz_bank_${bank}_${component}`)));
  }
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const positions of positionBanks) {
    for (let offset = 0; offset < positions.length; offset += 3) {
      for (let component = 0; component < 3; component += 1) {
        minimum[component] = Math.min(minimum[component], positions[offset + component]);
        maximum[component] = Math.max(maximum[component], positions[offset + component]);
      }
    }
  }
  const first = positionBanks[0];
  const codes = new Uint32Array(segment.count);
  for (let index = 0; index < segment.count; index += 1) {
    const offset = index * 3;
    const quantized = [0, 0, 0];
    for (let component = 0; component < 3; component += 1) {
      const scale = maximum[component] > minimum[component]
        ? Math.fround(Math.fround(maximum[component] - minimum[component]) / Math.fround(1023))
        : Math.fround(1);
      const normalized = Math.fround(Math.fround(first[offset + component] - minimum[component]) / scale);
      quantized[component] = Math.max(0, Math.min(1023, roundTiesToEven(normalized)));
    }
    codes[index] = spreadMorton10(quantized[0])
      | (spreadMorton10(quantized[1]) << 1)
      | (spreadMorton10(quantized[2]) << 2);
  }
  const order = Array.from({ length: segment.count }, (_, index) => index);
  order.sort((a, b) => codes[a] - codes[b] || a - b);
  return order;
}

export function labelsInSourceOrder(segments, labels) {
  const result = [];
  let sourceOffset = 0;
  for (const segment of segments) {
    const order = stableMortonOrder(segment);
    const sourceLabels = new Uint8Array(segment.count * 5);
    for (let sortedIndex = 0; sortedIndex < order.length; sortedIndex += 1) {
      const local = order[sortedIndex];
      sourceLabels.set(labels.subarray(sourceOffset + sortedIndex * 5, sourceOffset + sortedIndex * 5 + 5), local * 5);
    }
    result.push(sourceLabels);
    sourceOffset += segment.count * 5;
  }
  if (sourceOffset !== labels.length) throw new Error(`Unused CoReSH labels: ${labels.length - sourceOffset}`);
  return result;
}

function temporalLabels(labelSets, slotToLocal, operation) {
  const totalCount = labelSets.reduce((sum, labels) => sum + labels.length / 5, 0);
  const output = new Uint8Array(totalCount * 5);
  let destination = 0;
  for (let level = 0; level < 5; level += 1) {
    const state = new Uint8Array(slotToLocal[0].length);
    const initialized = new Uint8Array(slotToLocal[0].length);
    for (let segmentIndex = 0; segmentIndex < labelSets.length; segmentIndex += 1) {
      const inverse = slotToLocal[segmentIndex];
      const labels = labelSets[segmentIndex];
      for (let slot = 0; slot < inverse.length; slot += 1) {
        const local = inverse[slot];
        if (local < 0) continue;
        const value = labels[local * 5 + level];
        output[destination] = initialized[slot]
          ? operation === 'xor' ? value ^ state[slot] : (value - state[slot]) & 0xff
          : value;
        state[slot] = value;
        initialized[slot] = 1;
        destination += 1;
      }
    }
  }
  if (destination !== output.length) throw new Error(`Temporal label length mismatch: ${destination} != ${output.length}`);
  return output;
}

function reconstructTemporal(encoded, labelSets, slotToLocal, operation) {
  const decoded = labelSets.map((labels) => new Uint8Array(labels.length));
  let source = 0;
  for (let level = 0; level < 5; level += 1) {
    const state = new Uint8Array(slotToLocal[0].length);
    const initialized = new Uint8Array(slotToLocal[0].length);
    for (let segmentIndex = 0; segmentIndex < decoded.length; segmentIndex += 1) {
      const inverse = slotToLocal[segmentIndex];
      for (let slot = 0; slot < inverse.length; slot += 1) {
        const local = inverse[slot];
        if (local < 0) continue;
        const coded = encoded[source++];
        const value = initialized[slot]
          ? operation === 'xor' ? coded ^ state[slot] : (coded + state[slot]) & 0xff
          : coded;
        decoded[segmentIndex][local * 5 + level] = value;
        state[slot] = value;
        initialized[slot] = 1;
      }
    }
  }
  return decoded;
}

async function main() {
  const sourceDirectory = resolve(process.argv[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16');
  const sourceContainer = resolve(process.argv[3] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16.4cgs');
  const outputPath = resolve(process.argv[4] ?? 'artifacts/fourcgs_ts_coresh5r_temporal_20260815.bin');
  const reportPath = `${outputPath}.json`;
  const entries = (await readdir(sourceDirectory))
    .map((name) => ({ name, match: SEGMENT_PATTERN.exec(name) }))
    .filter((entry) => entry.match)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
  const segments = [];
  for (const entry of entries) {
    segments.push(await readSegment(join(sourceDirectory, entry.name)));
    console.log(JSON.stringify({ loaded: entry.name }));
  }
  const { payload } = extractRawStream(await readFile(sourceContainer), 'coresh5r');
  if (payload.subarray(0, 8).toString() !== 'RVQ5SH01') throw new Error('Unsupported CoReSH-5R payload.');
  const count = payload.readUInt32LE(8);
  const compressedBytes = payload.readUInt32LE(16);
  const labelOffset = SH_HEADER_BYTES + SH_MEAN_BYTES + SH_CODEBOOK_BYTES;
  const labels = inflateSync(payload.subarray(labelOffset, labelOffset + compressedBytes));
  if (labels.length !== count * 5) throw new Error(`Invalid CoReSH label count: ${labels.length}`);
  const slots = buildSlotMaps(segments);
  const labelSets = labelsInSourceOrder(segments, labels);
  const candidates = ['xor', 'subtract'].map((operation) => {
    const encoded = temporalLabels(labelSets, slots.slotToLocal, operation);
    const stored = deflateSync(encoded, { level: 9 });
    const decoded = reconstructTemporal(inflateSync(stored), labelSets, slots.slotToLocal, operation);
    for (let segmentIndex = 0; segmentIndex < decoded.length; segmentIndex += 1) {
      if (!decoded[segmentIndex].every((value, index) => value === labelSets[segmentIndex][index])) {
        throw new Error(`CoReSH temporal round trip failed for segment ${segmentIndex}.`);
      }
    }
    return { operation, encoded, stored };
  });
  candidates.sort((a, b) => a.stored.length - b.stored.length);
  const best = candidates[0];
  const headerAndBooks = payload.subarray(0, labelOffset);
  const output = Buffer.concat([headerAndBooks, best.stored]);
  output.writeUInt32LE(best.stored.length, 16);
  await writeFile(outputPath, output);
  const report = {
    sourceDirectory,
    sourceContainer,
    outputPath,
    gaussianInstanceCount: count,
    slotCount: slots.slotCount,
    codec: 'shared-CoReSH-5R-temporal-slot-delta-deflate',
    operation: best.operation,
    originalSharedCoReShBytes: payload.length,
    temporalSharedCoReShBytes: output.length,
    savedBytes: payload.length - output.length,
    candidates: candidates.map((candidate) => ({ operation: candidate.operation, labelBytes: candidate.stored.length })),
    labelRoundTripValidated: true,
    codebookBytes: SH_MEAN_BYTES + SH_CODEBOOK_BYTES,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}

// #WDD-gpt 2026-08-15 - 全序列共享一套五阶段 SH 码表，只有索引按可靠轨迹做时域熵编码，birth 不继承旧索引。
if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) await main();
