import { readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildSlotMaps, readSegment } from './probe-fourcgs-lossless-rate.mjs';

const SEGMENT_PATTERN = /^segment_(\d+)_(\d+)(?:\.decoded)?\.raw4d$/;
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

async function sortedSegments(directory) {
  const entries = (await readdir(directory))
    .map((name) => ({ name, match: SEGMENT_PATTERN.exec(name) }))
    .filter((entry) => entry.match)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
  const segments = [];
  for (const entry of entries) segments.push(await readSegment(join(directory, entry.name)));
  return segments;
}

async function main() {
  const sourceDirectory = resolve(process.argv[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16');
  const decodedDirectory = resolve(process.argv[3] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16_simple_merge_decoded');
  const reportPath = resolve(process.argv[4] ?? 'artifacts/fourcgs_simple_merge_sh_numeric_20260815.json');
  const source = await sortedSegments(sourceDirectory);
  const decoded = await sortedSegments(decodedDirectory);
  if (source.length !== decoded.length) throw new Error('Source and decoded segment count mismatch.');
  const slots = buildSlotMaps(source);
  const samples = new Float32Array(1_000_000);
  let sampleCount = 0;
  let valueCount = 0;
  let squareSum = 0;
  let absoluteSum = 0;
  let maximum = 0;
  const perSegment = [];
  for (let segmentIndex = 0; segmentIndex < source.length; segmentIndex += 1) {
    const original = source[segmentIndex];
    const restored = decoded[segmentIndex];
    const sourceProperties = Array.from({ length: 45 }, (_, index) => original.propertyIndex.get(`f_rest_${index}`));
    const decodedProperties = Array.from({ length: 45 }, (_, index) => restored.propertyIndex.get(`f_rest_${index}`));
    if (sourceProperties.some((index) => index === undefined) || decodedProperties.some((index) => index === undefined)) {
      throw new Error(`Missing SH properties in segment ${segmentIndex}.`);
    }
    let segmentSquare = 0;
    let segmentMaximum = 0;
    const activeSlots = [];
    for (let slot = 0; slot < slots.slotCount; slot += 1) {
      if (slots.slotToLocal[segmentIndex][slot] >= 0) activeSlots.push(slot);
    }
    for (let row = 0; row < activeSlots.length; row += 1) {
      const sourceLocal = slots.slotToLocal[segmentIndex][activeSlots[row]];
      for (let coefficient = 0; coefficient < 45; coefficient += 1) {
        const sourceBits = original.rows[sourceLocal * original.propertyNames.length + sourceProperties[coefficient]];
        const decodedBits = restored.rows[row * restored.propertyNames.length + decodedProperties[coefficient]];
        const absolute = Math.abs(halfToFloat(decodedBits) - halfToFloat(sourceBits));
        squareSum += absolute * absolute;
        segmentSquare += absolute * absolute;
        absoluteSum += absolute;
        maximum = Math.max(maximum, absolute);
        segmentMaximum = Math.max(segmentMaximum, absolute);
        if (valueCount % 61 === 0 && sampleCount < samples.length) samples[sampleCount++] = absolute;
        valueCount += 1;
      }
    }
    perSegment.push({
      name: original.path.split('/').at(-1),
      rmse: Math.sqrt(segmentSquare / (original.count * 45)),
      maximumAbsoluteError: segmentMaximum,
    });
  }
  const sorted = Array.from(samples.subarray(0, sampleCount)).sort((a, b) => a - b);
  const report = {
    sourceDirectory,
    decodedDirectory,
    valueCount,
    rmse: Math.sqrt(squareSum / valueCount),
    mae: absoluteSum / valueCount,
    approximateP99AbsoluteError: sorted[Math.floor((sorted.length - 1) * 0.99)],
    maximumAbsoluteError: maximum,
    sampleCount,
    perSegment,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}

// #WDD-gpt 2026-08-15 - 用纯 JS 对独立解码后的全部 SH 系数做数值验收，避免依赖 Python 训练或评测路径。
await main();
