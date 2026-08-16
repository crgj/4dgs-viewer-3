import { open, readdir, stat, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { matchFourCgsBoundary } from '../src/features/gaussian/formats/fourcgs/FourCgsBoundaryMatcher.ts';

const SEGMENT_PATTERN = /^segment_(\d+)_(\d+)\.raw4d$/;
export const SAFE_LIMITS = {
  cellSize: 0.008,
  maxPositionDistance: 0.016,
  maxRotationAngle: 0.35,
  maxColorDistance: 0.16,
  maxScaleDistance: 0.2,
  maxOpacityDistance: 1.5,
};

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

const halfTable = new Float32Array(65536);
for (let index = 0; index < halfTable.length; index += 1) halfTable[index] = halfToFloat(index);

export async function readSegment(path) {
  const handle = await open(path, 'r');
  try {
    let headerSize = 4096;
    let header;
    let dataOffset = -1;
    while (headerSize <= 1024 * 1024) {
      const bytes = Buffer.alloc(headerSize);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const text = bytes.subarray(0, bytesRead).toString('ascii');
      const marker = /end_header\r?\n/.exec(text);
      if (marker) {
        dataOffset = marker.index + marker[0].length;
        header = text.slice(0, dataOffset);
        break;
      }
      if (bytesRead < bytes.length) break;
      headerSize *= 2;
    }
    if (!header || dataOffset < 0) throw new Error(`Invalid RAW4D header: ${path}`);
    const count = Number(/^element vertex (\d+)$/m.exec(header)?.[1]);
    const propertyNames = [...header.matchAll(/^property \S+ (\S+)$/gm)].map((match) => match[1]);
    const propertyIndex = new Map(propertyNames.map((name, index) => [name, index]));
    const byteLength = count * propertyNames.length * 2;
    const payload = Buffer.allocUnsafe(byteLength);
    let offset = 0;
    while (offset < byteLength) {
      const { bytesRead } = await handle.read(payload, offset, byteLength - offset, dataOffset + offset);
      if (bytesRead === 0) throw new Error(`Truncated RAW4D payload: ${path}`);
      offset += bytesRead;
    }
    return {
      path,
      count,
      propertyNames,
      propertyIndex,
      rows: new Uint16Array(payload.buffer, payload.byteOffset, payload.byteLength / 2),
    };
  } finally {
    await handle.close();
  }
}

export function bankCount(segment, prefix) {
  let maximum = -1;
  const expression = new RegExp(`^${prefix}_(\\d+)(?:_|$)`);
  for (const name of segment.propertyNames) {
    const match = expression.exec(name);
    if (match) maximum = Math.max(maximum, Number(match[1]));
  }
  return maximum + 1;
}

export function extract(segment, names) {
  const indices = names.map((name) => {
    const index = segment.propertyIndex.get(name);
    if (index === undefined) throw new Error(`Missing ${name} in ${segment.path}`);
    return index;
  });
  const values = new Float32Array(segment.count * names.length);
  for (let row = 0; row < segment.count; row += 1) {
    const sourceOffset = row * segment.propertyNames.length;
    const destinationOffset = row * names.length;
    for (let component = 0; component < names.length; component += 1) {
      values[destinationOffset + component] = halfTable[segment.rows[sourceOffset + indices[component]]];
    }
  }
  return values;
}

export function boundary(segment, side) {
  const bank = {
    position: side === 'last' ? bankCount(segment, 'xyz_bank') - 1 : 0,
    rotation: side === 'last' ? bankCount(segment, 'rot_bank') - 1 : 0,
    color: side === 'last' ? bankCount(segment, 'f_dc_bank') - 1 : 0,
    scale: side === 'last' ? bankCount(segment, 'scale_bank') - 1 : 0,
    opacity: side === 'last' ? bankCount(segment, 'opacity_bank') - 1 : 0,
  };
  return {
    count: segment.count,
    position: extract(segment, ['x', 'y', 'z'].map((component) => `xyz_bank_${bank.position}_${component}`)),
    rotation: extract(segment, ['w', 'x', 'y', 'z'].map((component) => `rot_bank_${bank.rotation}_${component}`)),
    colorDc: extract(segment, ['0', '1', '2'].map((component) => `f_dc_bank_${bank.color}_${component}`)),
    scale: extract(segment, ['0', '1', '2'].map((component) => `scale_bank_${bank.scale}_${component}`)),
    opacity: extract(segment, [`opacity_bank_${bank.opacity}`]),
  };
}

export function buildSlotMaps(segments) {
  const slotCount = Math.max(...segments.map((segment) => segment.count));
  const maps = [Int32Array.from({ length: segments[0].count }, (_, index) => index)];
  const continuedLocal = [new Uint8Array(segments[0].count)];
  const matches = [];
  for (let segmentIndex = 1; segmentIndex < segments.length; segmentIndex += 1) {
    const previous = segments[segmentIndex - 1];
    const current = segments[segmentIndex];
    const match = matchFourCgsBoundary(boundary(previous, 'last'), boundary(current, 'first'), SAFE_LIMITS);
    const previousMap = maps[segmentIndex - 1];
    const currentMap = new Int32Array(current.count);
    const currentContinued = new Uint8Array(current.count);
    currentMap.fill(-1);
    const usedSlots = new Uint8Array(slotCount);
    for (let local = 0; local < current.count; local += 1) {
      const previousLocal = match.currentToPrevious[local];
      if (previousLocal < 0) continue;
      const slot = previousMap[previousLocal];
      currentMap[local] = slot;
      currentContinued[local] = 1;
      usedSlots[slot] = 1;
    }
    let freeSlot = 0;
    for (let local = 0; local < current.count; local += 1) {
      if (currentMap[local] >= 0) continue;
      while (freeSlot < slotCount && usedSlots[freeSlot]) freeSlot += 1;
      if (freeSlot >= slotCount) throw new Error(`No free 4CGS slot for ${current.path}`);
      currentMap[local] = freeSlot;
      usedSlots[freeSlot] = 1;
    }
    maps.push(currentMap);
    continuedLocal.push(currentContinued);
    matches.push({
      previous: segments[segmentIndex - 1].path,
      current: current.path,
      matchedCount: match.matchedCount,
      matchedRatio: match.matchedCount / current.count,
    });
  }
  const slotToLocal = maps.map((map, segmentIndex) => {
    const inverse = new Int32Array(slotCount);
    inverse.fill(-1);
    for (let local = 0; local < map.length; local += 1) inverse[map[local]] = local;
    if (inverse.reduce((count, local) => count + Number(local >= 0), 0) !== segments[segmentIndex].count) {
      throw new Error(`Non-unique 4CGS slot map for ${segments[segmentIndex].path}`);
    }
    return inverse;
  });
  return { slotCount, maps, slotToLocal, continuedLocal, matches };
}

// #WDD-gpt 2026-08-15 - 新 Gaussian 只分配递增 Track ID，禁止跨段回收已死亡轨迹的编号。
export function buildPermanentTrackMaps(segments) {
  const maps = [Int32Array.from({ length: segments[0].count }, (_, index) => index)];
  const continuedLocal = [new Uint8Array(segments[0].count)];
  const matches = [];
  let trackCount = segments[0].count;
  for (let segmentIndex = 1; segmentIndex < segments.length; segmentIndex += 1) {
    const previous = segments[segmentIndex - 1];
    const current = segments[segmentIndex];
    const match = matchFourCgsBoundary(boundary(previous, 'last'), boundary(current, 'first'), SAFE_LIMITS);
    const previousMap = maps[segmentIndex - 1];
    const currentMap = new Int32Array(current.count);
    const currentContinued = new Uint8Array(current.count);
    for (let local = 0; local < current.count; local += 1) {
      const previousLocal = match.currentToPrevious[local];
      if (previousLocal >= 0) {
        currentMap[local] = previousMap[previousLocal];
        currentContinued[local] = 1;
      } else {
        currentMap[local] = trackCount;
        trackCount += 1;
      }
    }
    maps.push(currentMap);
    continuedLocal.push(currentContinued);
    matches.push({
      previous: segments[segmentIndex - 1].path,
      current: current.path,
      matchedCount: match.matchedCount,
      matchedRatio: match.matchedCount / current.count,
    });
  }
  const slotToLocal = maps.map((map, segmentIndex) => {
    const inverse = new Int32Array(trackCount);
    inverse.fill(-1);
    for (let local = 0; local < map.length; local += 1) inverse[map[local]] = local;
    if (inverse.reduce((count, local) => count + Number(local >= 0), 0) !== segments[segmentIndex].count) {
      throw new Error(`Non-unique permanent Track ID map for ${segments[segmentIndex].path}`);
    }
    return inverse;
  });
  return { slotCount: trackCount, trackCount, maps, slotToLocal, continuedLocal, matches };
}

function exactBoundaryPositionKey(segment, local, bank) {
  const source = local * segment.propertyNames.length;
  const x = segment.rows[source + segment.propertyIndex.get(`xyz_bank_${bank}_x`)];
  const y = segment.rows[source + segment.propertyIndex.get(`xyz_bank_${bank}_y`)];
  const z = segment.rows[source + segment.propertyIndex.get(`xyz_bank_${bank}_z`)];
  return x * 4294967296 + y * 65536 + z;
}

function exactBoundaryTieScore(previous, previousLocal, current, currentLocal) {
  const previousBase = previousLocal * previous.propertyNames.length;
  const currentBase = currentLocal * current.propertyNames.length;
  let score = 0;
  for (let component = 0; component < 45; component += 1) {
    const name = `f_rest_${component}`;
    if (previous.rows[previousBase + previous.propertyIndex.get(name)] === current.rows[currentBase + current.propertyIndex.get(name)]) score += 4;
  }
  const previousDcBank = bankCount(previous, 'f_dc_bank') - 1;
  for (let component = 0; component < 3; component += 1) {
    const previousName = `f_dc_bank_${previousDcBank}_${component}`;
    const currentName = `f_dc_bank_0_${component}`;
    if (previous.rows[previousBase + previous.propertyIndex.get(previousName)] === current.rows[currentBase + current.propertyIndex.get(currentName)]) score += 2;
  }
  return score;
}

// #WDD-gpt 2026-08-15 - 连续六段优先按共享边界的 FP16 Position 精确匹配 Track，重复坐标再用 SH/DC 一致性消歧。
export function buildExactBoundaryPermanentTrackMaps(segments) {
  const maps = [Int32Array.from({ length: segments[0].count }, (_, index) => index)];
  const continuedLocal = [new Uint8Array(segments[0].count)];
  const matches = [];
  let trackCount = segments[0].count;
  for (let segmentIndex = 1; segmentIndex < segments.length; segmentIndex += 1) {
    const previous = segments[segmentIndex - 1];
    const current = segments[segmentIndex];
    const previousBank = bankCount(previous, 'xyz_bank') - 1;
    const buckets = new Map();
    for (let previousLocal = 0; previousLocal < previous.count; previousLocal += 1) {
      const key = exactBoundaryPositionKey(previous, previousLocal, previousBank);
      let candidates = buckets.get(key);
      if (!candidates) {
        candidates = [];
        buckets.set(key, candidates);
      }
      candidates.push(previousLocal);
    }
    const currentMap = new Int32Array(current.count);
    const currentContinued = new Uint8Array(current.count);
    let matchedCount = 0;
    let duplicateCandidateCount = 0;
    for (let currentLocal = 0; currentLocal < current.count; currentLocal += 1) {
      const candidates = buckets.get(exactBoundaryPositionKey(current, currentLocal, 0));
      if (!candidates?.length) {
        currentMap[currentLocal] = trackCount;
        trackCount += 1;
        continue;
      }
      let candidateIndex = candidates.length - 1;
      if (candidates.length > 1) {
        duplicateCandidateCount += 1;
        let bestScore = -1;
        for (let index = 0; index < candidates.length; index += 1) {
          const score = exactBoundaryTieScore(previous, candidates[index], current, currentLocal);
          if (score > bestScore) {
            bestScore = score;
            candidateIndex = index;
          }
        }
      }
      const previousLocal = candidates[candidateIndex];
      candidates[candidateIndex] = candidates[candidates.length - 1];
      candidates.pop();
      currentMap[currentLocal] = maps[segmentIndex - 1][previousLocal];
      currentContinued[currentLocal] = 1;
      matchedCount += 1;
    }
    maps.push(currentMap);
    continuedLocal.push(currentContinued);
    matches.push({
      previous: previous.path,
      current: current.path,
      matchedCount,
      matchedRatio: matchedCount / current.count,
      duplicateCandidateCount,
      method: 'exact_fp16_boundary_position_sh_dc_tie_break',
    });
  }
  const slotToLocal = maps.map((map) => {
    const inverse = new Int32Array(trackCount);
    inverse.fill(-1);
    for (let local = 0; local < map.length; local += 1) inverse[map[local]] = local;
    return inverse;
  });
  return { slotCount: trackCount, trackCount, maps, slotToLocal, continuedLocal, matches };
}

function compressActiveMasks(slotToLocal) {
  const slotCount = slotToLocal[0].length;
  const bytes = new Uint8Array(Math.ceil(slotCount * slotToLocal.length / 8));
  for (let segmentIndex = 0; segmentIndex < slotToLocal.length; segmentIndex += 1) {
    for (let slot = 0; slot < slotCount; slot += 1) {
      if (slotToLocal[segmentIndex][slot] < 0) continue;
      const bit = segmentIndex * slotCount + slot;
      bytes[bit >>> 3] |= 1 << (bit & 7);
    }
  }
  return deflateRawSync(bytes, { level: 9 }).byteLength;
}

function propertyName(prefix, bank, component) {
  return component === '' ? `${prefix}_${bank}` : `${prefix}_${bank}_${component}`;
}

function compressTemporalComponent(segments, slotToLocal, namesBySegment) {
  const valueCount = namesBySegment.reduce((sum, names, index) => sum + names.length * segments[index].count, 0);
  const values = new Uint16Array(valueCount);
  const state = new Uint16Array(slotToLocal[0].length);
  const initialized = new Uint8Array(slotToLocal[0].length);
  let destination = 0;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const inverse = slotToLocal[segmentIndex];
    for (const name of namesBySegment[segmentIndex]) {
      const property = segment.propertyIndex.get(name);
      if (property === undefined) throw new Error(`Missing ${name} in ${segment.path}`);
      for (let slot = 0; slot < inverse.length; slot += 1) {
        const local = inverse[slot];
        if (local < 0) continue;
        const value = segment.rows[local * segment.propertyNames.length + property];
        values[destination] = initialized[slot] ? value ^ state[slot] : value;
        state[slot] = value;
        initialized[slot] = 1;
        destination += 1;
      }
    }
  }
  if (destination !== values.length) throw new Error(`4CGS stream length mismatch: ${destination} != ${values.length}`);
  return {
    rawBytes: values.byteLength,
    compressedBytes: deflateRawSync(Buffer.from(values.buffer), { level: 9 }).byteLength,
  };
}

function compressTrack(segments, slotToLocal, prefix, components) {
  let rawBytes = 0;
  let compressedBytes = 0;
  for (const component of components) {
    const namesBySegment = segments.map((segment) => Array.from(
      { length: bankCount(segment, prefix) },
      (_, bank) => propertyName(prefix, bank, component),
    ));
    const result = compressTemporalComponent(segments, slotToLocal, namesBySegment);
    rawBytes += result.rawBytes;
    compressedBytes += result.compressedBytes;
  }
  return { rawBytes, compressedBytes };
}

async function main() {
  const sourceDirectory = resolve(process.argv[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16');
  const outputPath = resolve(process.argv[3] ?? 'artifacts/fourcgs_ts_lossless_rate_20260815.json');
  const entries = (await readdir(sourceDirectory))
    .map((name) => ({ name, match: SEGMENT_PATTERN.exec(name) }))
    .filter((entry) => entry.match)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
  const segments = [];
  let sourceBytes = 0;
  for (const entry of entries) {
    const path = join(sourceDirectory, entry.name);
    segments.push(await readSegment(path));
    sourceBytes += (await stat(path)).size;
    console.log(JSON.stringify({ loaded: entry.name }));
  }
  const slots = buildSlotMaps(segments);
  console.log(JSON.stringify({ slotCount: slots.slotCount, matches: slots.matches }));
  const categories = {
    activeMasks: { rawBytes: Math.ceil(slots.slotCount * segments.length / 8), compressedBytes: compressActiveMasks(slots.slotToLocal) },
    position: compressTrack(segments, slots.slotToLocal, 'xyz_bank', ['x', 'y', 'z']),
    rotation: compressTrack(segments, slots.slotToLocal, 'rot_bank', ['w', 'x', 'y', 'z']),
    colorDc: compressTrack(segments, slots.slotToLocal, 'f_dc_bank', ['0', '1', '2']),
    scale: compressTrack(segments, slots.slotToLocal, 'scale_bank', ['0', '1', '2']),
    opacity: compressTrack(segments, slots.slotToLocal, 'opacity_bank', ['']),
    lifetimeMu: compressTemporalComponent(segments, slots.slotToLocal, segments.map(() => ['lifetime_mu'])),
    lifetimeW: compressTemporalComponent(segments, slots.slotToLocal, segments.map(() => ['lifetime_w'])),
    shRest: { rawBytes: 0, compressedBytes: 0 },
  };
  for (let coefficient = 0; coefficient < 45; coefficient += 1) {
    const result = compressTemporalComponent(segments, slots.slotToLocal, segments.map(() => [`f_rest_${coefficient}`]));
    categories.shRest.rawBytes += result.rawBytes;
    categories.shRest.compressedBytes += result.compressedBytes;
  }
  const compressedPayloadBytes = Object.values(categories).reduce((sum, category) => sum + category.compressedBytes, 0);
  const report = {
    sourceDirectory,
    sourceBytes,
    targetBytes: Math.floor(sourceBytes / 15),
    slotCount: slots.slotCount,
    matches: slots.matches,
    categories,
    compressedPayloadBytes,
    ratio: sourceBytes / compressedPayloadBytes,
    note: 'Lossless fp16 XOR-delta plus deflate-raw baseline; container metadata is not included.',
  };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}

// #WDD-gpt 2026-08-15 - 无损速率探针仅重排跨段槽位，不删点、不改值，先量出 39 dB 质量门槛的零损基线。
if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) await main();
