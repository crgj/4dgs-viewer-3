import { open, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { matchFourCgsBoundary } from '../src/features/gaussian/formats/fourcgs/FourCgsBoundaryMatcher.ts';

const SEGMENT_PATTERN = /^segment_(\d+)_(\d+)\.raw4d$/;

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

const floatView = new DataView(new ArrayBuffer(4));
const halfTable = new Float32Array(65536);
for (let index = 0; index < halfTable.length; index += 1) halfTable[index] = halfToFloat(index);

async function readHeader(path) {
  const handle = await open(path, 'r');
  try {
    let size = 4096;
    while (size <= 1024 * 1024) {
      const bytes = Buffer.alloc(size);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const text = bytes.subarray(0, bytesRead).toString('ascii');
      const marker = /end_header\r?\n/.exec(text);
      if (marker) {
        const dataOffset = marker.index + marker[0].length;
        const header = text.slice(0, dataOffset);
        const vertexCount = Number(/^element vertex (\d+)$/m.exec(header)?.[1]);
        const propertyNames = [...header.matchAll(/^property \S+ (\S+)$/gm)].map((match) => match[1]);
        if (!vertexCount || propertyNames.length === 0) throw new Error(`Invalid RAW4D header: ${path}`);
        return { dataOffset, vertexCount, propertyNames };
      }
      if (bytesRead < bytes.length) break;
      size *= 2;
    }
  } finally {
    await handle.close();
  }
  throw new Error(`RAW4D header is too large: ${path}`);
}

async function readBoundary(path, side) {
  const header = await readHeader(path);
  const handle = await open(path, 'r');
  const byteLength = header.vertexCount * header.propertyNames.length * 2;
  const payload = Buffer.allocUnsafe(byteLength);
  try {
    let offset = 0;
    while (offset < byteLength) {
      const { bytesRead } = await handle.read(payload, offset, byteLength - offset, header.dataOffset + offset);
      if (bytesRead === 0) throw new Error(`Truncated RAW4D payload: ${path}`);
      offset += bytesRead;
    }
  } finally {
    await handle.close();
  }
  const rows = new Uint16Array(payload.buffer, payload.byteOffset, payload.byteLength / 2);
  const propertyIndex = new Map(header.propertyNames.map((name, index) => [name, index]));
  const bank = side === 'last'
    ? { position: 10, rotation: 1, color: 1, scale: 3, opacity: 3 }
    : { position: 0, rotation: 0, color: 0, scale: 0, opacity: 0 };
  const names = {
    position: ['x', 'y', 'z'].map((component) => `xyz_bank_${bank.position}_${component}`),
    rotation: ['w', 'x', 'y', 'z'].map((component) => `rot_bank_${bank.rotation}_${component}`),
    colorDc: ['0', '1', '2'].map((component) => `f_dc_bank_${bank.color}_${component}`),
    scale: ['0', '1', '2'].map((component) => `scale_bank_${bank.scale}_${component}`),
    opacity: [`opacity_bank_${bank.opacity}`],
  };
  const extract = (properties) => {
    const indices = properties.map((name) => {
      const index = propertyIndex.get(name);
      if (index === undefined) throw new Error(`Missing ${name} in ${path}`);
      return index;
    });
    const result = new Float32Array(header.vertexCount * indices.length);
    for (let row = 0; row < header.vertexCount; row += 1) {
      const sourceOffset = row * header.propertyNames.length;
      const destinationOffset = row * indices.length;
      for (let component = 0; component < indices.length; component += 1) {
        result[destinationOffset + component] = halfTable[rows[sourceOffset + indices[component]]];
      }
    }
    return result;
  };
  return {
    count: header.vertexCount,
    position: extract(names.position),
    rotation: extract(names.rotation),
    colorDc: extract(names.colorDc),
    scale: extract(names.scale),
    opacity: extract(names.opacity),
  };
}

async function main() {
  const sourceDirectory = resolve(process.argv[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16');
  const outputPath = resolve(process.argv[3] ?? 'artifacts/fourcgs_ts_boundary_probe_20260815.json');
  const entries = (await readdir(sourceDirectory))
    .map((name) => ({ name, match: SEGMENT_PATTERN.exec(name) }))
    .filter((entry) => entry.match)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
  if (entries.length < 2) throw new Error(`No connected RAW4D segments found in ${sourceDirectory}`);

  const profiles = [
    { name: 'strict', cellSize: 0.004, maxPositionDistance: 0.008, maxRotationAngle: 0.15, maxColorDistance: 0.08, maxScaleDistance: 0.1, maxOpacityDistance: 0.75 },
    { name: 'safe', cellSize: 0.008, maxPositionDistance: 0.016, maxRotationAngle: 0.35, maxColorDistance: 0.16, maxScaleDistance: 0.2, maxOpacityDistance: 1.5 },
    { name: 'relaxed', cellSize: 0.016, maxPositionDistance: 0.032, maxRotationAngle: 0.7, maxColorDistance: 0.32, maxScaleDistance: 0.4, maxOpacityDistance: 3 },
  ];
  const boundaries = [];
  let previous = await readBoundary(join(sourceDirectory, entries[0].name), 'last');
  for (let index = 1; index < entries.length; index += 1) {
    const currentPath = join(sourceDirectory, entries[index].name);
    const current = await readBoundary(currentPath, 'first');
    const measurements = [];
    for (const profile of profiles) {
      const started = performance.now();
      const result = matchFourCgsBoundary(previous, current, profile);
      measurements.push({
        profile: profile.name,
        matchedCount: result.matchedCount,
        matchedRatioOfCurrent: result.matchedCount / current.count,
        rejectedByAttributes: result.rejectedByAttributes,
        conflictedCount: result.conflictedCount,
        elapsedSeconds: (performance.now() - started) / 1000,
      });
    }
    const boundary = {
      previous: basename(join(sourceDirectory, entries[index - 1].name)),
      current: basename(currentPath),
      previousCount: previous.count,
      currentCount: current.count,
      measurements,
    };
    boundaries.push(boundary);
    console.log(JSON.stringify(boundary));
    previous = index + 1 < entries.length ? await readBoundary(currentPath, 'last') : current;
  }
  const report = { sourceDirectory, profiles, boundaries };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ outputPath }));
}

// #WDD-gpt 2026-08-15 - Node 探针与浏览器共享同一个保守续接器，正式流程不依赖 Python。
await main();
