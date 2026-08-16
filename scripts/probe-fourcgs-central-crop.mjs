import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bankCount, buildSlotMaps, readSegment } from './probe-fourcgs-lossless-rate.mjs';

const SEGMENT_PATTERN = /^segment_(\d+)_(\d+)\.raw4d$/;
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

function value(segment, local, name) {
  const property = segment.propertyIndex.get(name);
  if (property === undefined) throw new Error(`Missing ${name}`);
  return halfToFloat(segment.rows[local * segment.propertyNames.length + property]);
}

function percentile(values, fraction) {
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.max(0, Math.round((values.length - 1) * fraction)))];
}

function inside(position, center, halfExtent) {
  return position.every((coordinate, axis) => Math.abs(coordinate - center[axis]) <= halfExtent);
}

async function main() {
  const sourceDirectory = resolve(process.argv[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16');
  const halfExtent = Number(process.argv[3] ?? 2.5);
  const entries = (await readdir(sourceDirectory))
    .map((name) => ({ name, match: SEGMENT_PATTERN.exec(name) }))
    .filter((entry) => entry.match)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
  const segments = [];
  for (const entry of entries) segments.push(await readSegment(join(sourceDirectory, entry.name)));
  const slots = buildSlotMaps(segments);
  const first = segments[0];
  const axes = ['x', 'y', 'z'].map((component) => Array.from(
    { length: first.count },
    (_, local) => value(first, local, `xyz_bank_0_${component}`),
  ));
  const robustBounds = axes.map((axis) => [percentile(axis, 0.005), percentile(axis, 0.995)]);
  const center = robustBounds.map(([minimum, maximum]) => (minimum + maximum) / 2);
  const keptSlots = new Uint8Array(slots.slotCount);
  const referencePositions = Array.from({ length: slots.slotCount });
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    for (let slot = 0; slot < slots.slotCount; slot += 1) {
      if (referencePositions[slot]) continue;
      const local = slots.slotToLocal[segmentIndex][slot];
      if (local < 0) continue;
      const position = ['x', 'y', 'z'].map((component) => value(segment, local, `xyz_bank_0_${component}`));
      referencePositions[slot] = position;
      if (inside(position, center, halfExtent)) keptSlots[slot] = 1;
    }
  }
  const segmentStats = segments.map((segment, segmentIndex) => {
    let referenceKept = 0;
    let allBanksInside = 0;
    let anyBankInside = 0;
    const banks = bankCount(segment, 'xyz_bank');
    for (let slot = 0; slot < slots.slotCount; slot += 1) {
      const local = slots.slotToLocal[segmentIndex][slot];
      if (local < 0) continue;
      referenceKept += keptSlots[slot];
      let insideCount = 0;
      for (let bank = 0; bank < banks; bank += 1) {
        const position = ['x', 'y', 'z'].map((component) => value(segment, local, `xyz_bank_${bank}_${component}`));
        insideCount += Number(inside(position, center, halfExtent));
      }
      allBanksInside += Number(insideCount === banks);
      anyBankInside += Number(insideCount > 0);
    }
    return {
      name: entries[segmentIndex].name,
      sourceGaussians: segment.count,
      referenceKept,
      referenceKeptFraction: referenceKept / segment.count,
      allPositionBanksInside: allBanksInside,
      anyPositionBankInside: anyBankInside,
      positionBanks: banks,
    };
  });
  console.log(JSON.stringify({
    centerPolicy: 'first-frame 0.5%-99.5% robust AABB midpoint',
    robustBounds,
    center,
    halfExtent,
    permanentTrackCount: slots.slotCount,
    keptPermanentTrackCount: keptSlots.reduce((sum, value_) => sum + value_, 0),
    segmentStats,
  }, null, 2));
}

// #WDD-gpt 2026-08-15 - 在正式编码前量化中心 5m 立方体对永久轨迹及各段位置关键帧的实际保留比例。
await main();
