import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants,
  inflateSync,
} from 'node:zlib';
import { sha256 } from './fourcgs-prs-codec.mjs';

const MAGIC = '4CGSPRS2';

function shuffle16(raw) {
  if (raw.length % 2 !== 0) throw new Error('FP16 byte shuffle requires an even byte count.');
  const result = Buffer.allocUnsafe(raw.length);
  const values = raw.length / 2;
  for (let index = 0; index < values; index += 1) {
    result[index] = raw[index * 2];
    result[values + index] = raw[index * 2 + 1];
  }
  return result;
}

function unshuffle16(shuffled) {
  if (shuffled.length % 2 !== 0) throw new Error('FP16 byte unshuffle requires an even byte count.');
  const result = Buffer.allocUnsafe(shuffled.length);
  const values = shuffled.length / 2;
  for (let index = 0; index < values; index += 1) {
    result[index * 2] = shuffled[index];
    result[index * 2 + 1] = shuffled[values + index];
  }
  return result;
}

function brotli(raw) {
  return brotliCompressSync(raw, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_LGWIN]: 24,
      [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  });
}

function restore(entry, stored) {
  if (entry.compression === 'raw') return stored;
  if (entry.compression === 'deflate') return inflateSync(stored);
  if (entry.compression === 'brotli') return brotliDecompressSync(stored);
  if (entry.compression === 'brotli-shuffle16') return unshuffle16(brotliDecompressSync(stored));
  throw new Error(`Unsupported source compression ${entry.compression}.`);
}

function store(raw, compression) {
  if (compression === 'raw') return raw;
  if (compression === 'brotli') return brotli(raw);
  if (compression === 'brotli-shuffle16') return brotli(shuffle16(raw));
  throw new Error(`Unsupported target compression ${compression}.`);
}

function activeSlots(manifest, mask) {
  return manifest.segments.map((segment, segmentIndex) => {
    const slots = [];
    for (let slot = 0; slot < manifest.slotCount; slot += 1) {
      const bit = segmentIndex * manifest.slotCount + slot;
      if ((mask[bit >>> 3] & (1 << (bit & 7))) !== 0) slots.push(slot);
    }
    if (slots.length !== segment.gaussianCount) throw new Error(`Active mask mismatch in segment ${segmentIndex}.`);
    return Int32Array.from(slots);
  });
}

function signedDelta(value, state) {
  return ((value - state + 32768) & 0xffff) - 32768;
}

function encodeTemporal(value, state, mode) {
  if (mode === 'xor') return value ^ state;
  const delta = signedDelta(value, state);
  if (mode === 'delta') return delta & 0xffff;
  if (mode === 'zigzag') return delta >= 0 ? delta * 2 : -delta * 2 - 1;
  throw new Error(`Unsupported temporal mode ${mode}.`);
}

function decodeTemporal(code, state, mode) {
  if (mode === 'xor') return code ^ state;
  if (mode === 'delta') return (state + (code < 0x8000 ? code : code - 0x10000)) & 0xffff;
  if (mode === 'zigzag') {
    const delta = code & 1 ? -(code + 1) / 2 : code / 2;
    return (state + delta) & 0xffff;
  }
  throw new Error(`Unsupported temporal mode ${mode}.`);
}

// #WDD-gpt 2026-08-15 - 在不读取源 RAW4D 的条件下，把可逆时间 XOR 码重写成更小的 FP16 位模式差分码。
function recodeTemporal(raw, slotsBySegment, bankCounts, slotCount, sourceMode, targetMode) {
  const source = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  const output = new Uint16Array(source.length);
  const state = new Uint16Array(slotCount);
  const initialized = new Uint8Array(slotCount);
  let offset = 0;
  for (let segmentIndex = 0; segmentIndex < slotsBySegment.length; segmentIndex += 1) {
    for (let bank = 0; bank < bankCounts[segmentIndex]; bank += 1) {
      for (const slot of slotsBySegment[segmentIndex]) {
        const code = source[offset];
        const value = initialized[slot] ? decodeTemporal(code, state[slot], sourceMode) : code;
        output[offset] = initialized[slot] ? encodeTemporal(value, state[slot], targetMode) : value;
        state[slot] = value;
        initialized[slot] = 1;
        offset += 1;
      }
    }
  }
  if (offset !== source.length) throw new Error(`Temporal recode length mismatch: ${offset} != ${source.length}`);
  return Buffer.from(output.buffer);
}

async function main() {
  const sourcePath = resolve(process.argv[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16_mesongs_noprune.4cgs');
  const outputPath = resolve(process.argv[3] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16_mesongs_noprune_lossless_v2.4cgs');
  const sourceContainer = await readFile(sourcePath);
  if (sourceContainer.subarray(0, 8).toString('ascii') !== MAGIC) throw new Error('Unsupported source 4CGS container.');
  const manifestBytes = sourceContainer.readUInt32LE(8);
  const manifest = JSON.parse(sourceContainer.subarray(12, 12 + manifestBytes).toString('utf8'));
  const decoded = new Map();
  const entries = [];
  let offset = 12 + manifestBytes;
  for (const entry of manifest.streams) {
    const stored = sourceContainer.subarray(offset, offset + entry.storedBytes);
    const raw = restore(entry, stored);
    if (raw.length !== entry.rawBytes || sha256(raw) !== entry.rawSha256) throw new Error(`Source stream validation failed: ${entry.name}`);
    entries.push({ ...entry, raw, stored });
    decoded.set(entry.name, raw);
    offset += entry.storedBytes;
  }
  if (offset !== sourceContainer.length) throw new Error('Unexpected source container trailing bytes.');
  const slots = activeSlots(manifest, decoded.get('active_masks'));
  const previousModes = manifest.losslessEntropy?.temporalModes ?? {};
  const targetModes = { scale: 'zigzag', lifetime_mu: 'delta', lifetime_w: 'zigzag' };
  const scaleBanks = manifest.segments.map((segment) => segment.bankCounts.scale);
  const lifetimeBanks = manifest.segments.map(() => 1);

  const nextEntries = [];
  for (const entry of entries) {
    let raw = entry.raw;
    let compression = entry.compression;
    if (entry.name === 'active_masks' || entry.name === 'prs_position') compression = 'brotli';
    if (entry.name.startsWith('scale_bank:')) {
      raw = recodeTemporal(raw, slots, scaleBanks, manifest.slotCount, previousModes.scale ?? 'xor', targetModes.scale);
      compression = 'brotli-shuffle16';
    } else if (entry.name === 'lifetime_mu' || entry.name === 'lifetime_w') {
      raw = recodeTemporal(raw, slots, lifetimeBanks, manifest.slotCount, previousModes[entry.name] ?? 'xor', targetModes[entry.name]);
      compression = 'brotli-shuffle16';
    }
    let stored = compression === entry.compression && raw === entry.raw ? entry.stored : store(raw, compression);
    if (raw === entry.raw && stored.length >= entry.stored.length) {
      compression = entry.compression;
      stored = entry.stored;
    }
    nextEntries.push({
      name: entry.name,
      compression,
      rawBytes: raw.length,
      storedBytes: stored.length,
      rawSha256: sha256(raw),
      storedSha256: sha256(stored),
      stored,
    });
    console.log(JSON.stringify({ phase: 'stream', name: entry.name, before: entry.storedBytes, after: stored.length, delta: stored.length - entry.storedBytes }));
  }
  const sourceSha256 = sha256(sourceContainer);
  const nextManifest = {
    ...manifest,
    codecName: `${manifest.codecName}-LosslessFp16Delta-Brotli11`,
    parentContainerSha256: sourceSha256,
    losslessEntropy: {
      codec: 'Brotli quality 11, lgwin 24',
      fp16Transform: 'byte shuffle after reversible temporal bit-pattern delta',
      temporalModes: targetModes,
      qualityImpact: 'none; recoded streams round-trip to the same FP16 bits',
    },
    streams: nextEntries.map(({ stored, ...entry }) => entry),
  };
  const nextManifestBytes = Buffer.from(JSON.stringify(nextManifest), 'utf8');
  const prefix = Buffer.alloc(12);
  prefix.write(MAGIC, 0, 'ascii');
  prefix.writeUInt32LE(nextManifestBytes.length, 8);
  const output = Buffer.concat([prefix, nextManifestBytes, ...nextEntries.map((entry) => entry.stored)]);
  await writeFile(outputPath, output);
  const report = {
    sourcePath,
    sourceBytes: sourceContainer.length,
    sourceSha256,
    outputPath,
    outputBytes: output.length,
    outputSha256: sha256(output),
    savingsBytes: sourceContainer.length - output.length,
    savingsRatio: 1 - output.length / sourceContainer.length,
    raw4dSourceBytes: manifest.sourceBytes,
    compressionRatio: manifest.sourceBytes / output.length,
    streams: nextManifest.streams,
  };
  await writeFile(`${outputPath}.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ phase: 'complete', ...report }));
}

// #WDD-gpt 2026-08-15 - 第二层联合容器仅改变无损表示和熵编码，保持所有有损属性码流及共享 SH 字节不变。
await main();
