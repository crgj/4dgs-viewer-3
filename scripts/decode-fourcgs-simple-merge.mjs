import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { bankCount, buildSlotMaps, readSegment } from './probe-fourcgs-lossless-rate.mjs';

const MAGIC = '4CGSMG01';
const SEGMENT_PATTERN = /^segment_(\d+)_(\d+)\.raw4d$/;
const floatView = new DataView(new ArrayBuffer(4));

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

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

function floatToHalf(value) {
  floatView.setFloat32(0, value, true);
  const bits = floatView.getUint32(0, true);
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  const mantissa = bits & 0x7fffff;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    const normalized = (mantissa | 0x800000) >>> (1 - exponent);
    return sign | ((normalized + 0x1000) >>> 13);
  }
  if (exponent >= 31) return sign | 0x7c00;
  const rounded = mantissa + 0x1000;
  if (rounded & 0x800000) {
    if (exponent + 1 >= 31) return sign | 0x7c00;
    return sign | ((exponent + 1) << 10);
  }
  return sign | (exponent << 10) | (rounded >>> 13);
}

function readContainer(bytes) {
  if (bytes.subarray(0, 8).toString('ascii') !== MAGIC) throw new Error('Unsupported simple-merge 4CGS file.');
  const manifestBytes = bytes.readUInt32LE(8);
  const manifest = JSON.parse(bytes.subarray(12, 12 + manifestBytes).toString('utf8'));
  const streams = new Map();
  let offset = 12 + manifestBytes;
  for (const entry of manifest.streams) {
    const stored = bytes.subarray(offset, offset + entry.storedBytes);
    if (stored.length !== entry.storedBytes || sha256(stored) !== entry.storedSha256) {
      throw new Error(`Stored stream validation failed: ${entry.name}`);
    }
    const raw = entry.compression === 'deflate' ? inflateSync(stored) : stored;
    if (raw.length !== entry.rawBytes || sha256(raw) !== entry.rawSha256) {
      throw new Error(`Raw stream validation failed: ${entry.name}`);
    }
    streams.set(entry.name, raw);
    offset += entry.storedBytes;
  }
  if (offset !== bytes.length) throw new Error(`Unexpected trailing 4CGS bytes: ${bytes.length - offset}`);
  return { manifest, streams };
}

function propertyNames(segment) {
  const names = [];
  for (let bank = 0; bank < segment.bankCounts.position; bank += 1) {
    for (const component of ['x', 'y', 'z']) names.push(`xyz_bank_${bank}_${component}`);
  }
  for (let bank = 0; bank < segment.bankCounts.rotation; bank += 1) {
    for (const component of ['w', 'x', 'y', 'z']) names.push(`rot_bank_${bank}_${component}`);
  }
  for (let bank = 0; bank < segment.bankCounts.colorDc; bank += 1) {
    for (const component of ['0', '1', '2']) names.push(`f_dc_bank_${bank}_${component}`);
  }
  for (let bank = 0; bank < segment.bankCounts.scale; bank += 1) {
    for (const component of ['0', '1', '2']) names.push(`scale_bank_${bank}_${component}`);
  }
  for (let bank = 0; bank < segment.bankCounts.opacity; bank += 1) names.push(`opacity_bank_${bank}`);
  names.push('lifetime_mu', 'lifetime_w');
  for (let coefficient = 0; coefficient < 45; coefficient += 1) names.push(`f_rest_${coefficient}`);
  return names;
}

function activeLayout(manifest, rawMask) {
  const activeSlots = [];
  for (let segmentIndex = 0; segmentIndex < manifest.segments.length; segmentIndex += 1) {
    const slots = [];
    for (let slot = 0; slot < manifest.slotCount; slot += 1) {
      const bit = segmentIndex * manifest.slotCount + slot;
      if ((rawMask[bit >>> 3] & (1 << (bit & 7))) !== 0) slots.push(slot);
    }
    if (slots.length !== manifest.segments[segmentIndex].gaussianCount) {
      throw new Error(`Active Gaussian count mismatch for segment ${segmentIndex}.`);
    }
    activeSlots.push(Int32Array.from(slots));
  }
  return activeSlots;
}

function decodeTemporalStream(raw, manifest, activeSlots, namesBySegment, rows, indices) {
  const values = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  const state = new Uint16Array(manifest.slotCount);
  const initialized = new Uint8Array(manifest.slotCount);
  let source = 0;
  for (let segmentIndex = 0; segmentIndex < manifest.segments.length; segmentIndex += 1) {
    const rowValues = rows[segmentIndex];
    const rowStride = indices[segmentIndex].size;
    const slots = activeSlots[segmentIndex];
    for (const name of namesBySegment[segmentIndex]) {
      const property = indices[segmentIndex].get(name);
      if (property === undefined) throw new Error(`Missing output property ${name}.`);
      for (let row = 0; row < slots.length; row += 1) {
        const slot = slots[row];
        const coded = values[source++];
        const value = initialized[slot] ? coded ^ state[slot] : coded;
        state[slot] = value;
        initialized[slot] = 1;
        rowValues[row * rowStride + property] = value;
      }
    }
  }
  if (source !== values.length) throw new Error(`Unused temporal values: ${values.length - source}`);
}

function decodeSharedSh(raw, manifest, activeSlots, rows, indices) {
  if (raw.subarray(0, 8).toString('ascii') !== 'C5T1SH01') throw new Error('Unsupported shared CoReSH-5R trajectory stream.');
  const slotCount = raw.readUInt32LE(8);
  const instanceCount = raw.readUInt32LE(12);
  const segmentCount = raw.readUInt16LE(16);
  const dimensions = raw.readUInt8(18);
  const levels = raw.readUInt8(19);
  const baseBytes = raw.readUInt32LE(20);
  const maskBytes = raw.readUInt32LE(24);
  const labelBytes = raw.readUInt32LE(28);
  if (slotCount !== manifest.slotCount || segmentCount !== manifest.segments.length || dimensions !== 45 || levels !== 5) {
    throw new Error('Shared CoReSH-5R metadata mismatch.');
  }
  const baseOffset = 32;
  const mean = new Float32Array(45);
  for (let dimension = 0; dimension < 45; dimension += 1) {
    mean[dimension] = halfToFloat(raw.readUInt16LE(baseOffset + dimension * 2));
  }
  const codebookOffset = baseOffset + 45 * 2;
  const codebooks = new Float32Array(5 * 256 * 45);
  for (let index = 0; index < codebooks.length; index += 1) {
    codebooks[index] = halfToFloat(raw.readUInt16LE(codebookOffset + index * 2));
  }
  const updateMask = inflateSync(raw.subarray(baseOffset + baseBytes, baseOffset + baseBytes + maskBytes));
  const updates = inflateSync(raw.subarray(baseOffset + baseBytes + maskBytes, baseOffset + baseBytes + maskBytes + labelBytes));
  const state = new Uint8Array(slotCount * 5);
  const initialized = new Uint8Array(slotCount);
  let instance = 0;
  let updateOffset = 0;
  for (let segmentIndex = 0; segmentIndex < manifest.segments.length; segmentIndex += 1) {
    const rowValues = rows[segmentIndex];
    const rowStride = indices[segmentIndex].size;
    for (let row = 0; row < activeSlots[segmentIndex].length; row += 1) {
      const slot = activeSlots[segmentIndex][row];
      const stateOffset = slot * 5;
      if ((updateMask[instance >>> 3] & (1 << (instance & 7))) !== 0) {
        state.set(updates.subarray(updateOffset, updateOffset + 5), stateOffset);
        initialized[slot] = 1;
        updateOffset += 5;
      }
      if (!initialized[slot]) throw new Error(`Missing SH initialization for slot ${slot}.`);
      for (let dimension = 0; dimension < 45; dimension += 1) {
        let value = mean[dimension];
        for (let level = 0; level < 5; level += 1) {
          value += codebooks[(level * 256 + state[stateOffset + level]) * 45 + dimension];
        }
        rowValues[row * rowStride + indices[segmentIndex].get(`f_rest_${dimension}`)] = floatToHalf(value);
      }
      instance += 1;
    }
  }
  if (instance !== instanceCount || updateOffset !== updates.length) throw new Error('Shared SH trajectory decode length mismatch.');
}

function raw4dHeader(segment, names) {
  const lines = [
    'ply',
    'format binary_little_endian 1.0',
    `comment total_frames ${segment.totalFrames}`,
    'comment xyz_bank_keyframe_stride 3',
    'comment rot_bank_keyframe_stride 30',
    'comment features_dc_bank_keyframe_stride 30',
    'comment scaling_bank_keyframe_stride 10',
    'comment opacity_bank_keyframe_stride 10',
    'comment fp16_quantized 1',
    ...names.map((name) => `comment fp16_property ${name}`),
    `element vertex ${segment.gaussianCount}`,
    ...names.map((name) => `property ushort ${name}`),
    'end_header',
  ];
  return Buffer.from(`${lines.join('\n')}\n`, 'ascii');
}

async function validateNonSh(sourceDirectory, manifest, activeSlots, rows, indices) {
  const entries = (await readdir(sourceDirectory))
    .map((name) => ({ name, match: SEGMENT_PATTERN.exec(name) }))
    .filter((entry) => entry.match)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
  const sources = [];
  for (const entry of entries) sources.push(await readSegment(join(sourceDirectory, entry.name)));
  const slots = buildSlotMaps(sources);
  let checkedValues = 0;
  for (let segmentIndex = 0; segmentIndex < sources.length; segmentIndex += 1) {
    const source = sources[segmentIndex];
    const decoded = rows[segmentIndex];
    const decodedStride = indices[segmentIndex].size;
    const sourceSlotToLocal = slots.slotToLocal[segmentIndex];
    for (let row = 0; row < activeSlots[segmentIndex].length; row += 1) {
      const slot = activeSlots[segmentIndex][row];
      const sourceLocal = sourceSlotToLocal[slot];
      if (sourceLocal < 0) throw new Error(`Missing source Gaussian at segment ${segmentIndex}, slot ${slot}.`);
      for (const [name, decodedProperty] of indices[segmentIndex]) {
        if (name.startsWith('f_rest_')) continue;
        const sourceProperty = source.propertyIndex.get(name);
        if (sourceProperty === undefined) throw new Error(`Source is missing ${name}.`);
        if (decoded[row * decodedStride + decodedProperty] !== source.rows[sourceLocal * source.propertyNames.length + sourceProperty]) {
          throw new Error(`Non-SH mismatch at segment ${segmentIndex}, slot ${slot}, property ${name}.`);
        }
        checkedValues += 1;
      }
    }
  }
  return checkedValues;
}

async function main() {
  const sourcePath = resolve(process.argv[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16_simple_merge.4cgs');
  const outputDirectory = resolve(process.argv[3] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16_simple_merge_decoded');
  const sourceDirectory = resolve(process.argv[4] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16');
  const { manifest, streams } = readContainer(await readFile(sourcePath));
  const activeSlots = activeLayout(manifest, streams.get('active_masks'));
  const names = manifest.segments.map(propertyNames);
  const indices = names.map((items) => new Map(items.map((name, index) => [name, index])));
  const rows = manifest.segments.map((segment, index) => new Uint16Array(segment.gaussianCount * names[index].length));
  const trackSpecs = [
    ['xyz_bank', ['x', 'y', 'z'], 'position'],
    ['rot_bank', ['w', 'x', 'y', 'z'], 'rotation'],
    ['f_dc_bank', ['0', '1', '2'], 'colorDc'],
    ['scale_bank', ['0', '1', '2'], 'scale'],
    ['opacity_bank', [''], 'opacity'],
  ];
  for (const [prefix, components, bankKey] of trackSpecs) {
    for (const component of components) {
      const namesBySegment = manifest.segments.map((segment) => Array.from(
        { length: segment.bankCounts[bankKey] },
        (_, bank) => component === '' ? `${prefix}_${bank}` : `${prefix}_${bank}_${component}`,
      ));
      decodeTemporalStream(streams.get(`${prefix}:${component || 'value'}`), manifest, activeSlots, namesBySegment, rows, indices);
    }
  }
  decodeTemporalStream(streams.get('lifetime_mu'), manifest, activeSlots, manifest.segments.map(() => ['lifetime_mu']), rows, indices);
  decodeTemporalStream(streams.get('lifetime_w'), manifest, activeSlots, manifest.segments.map(() => ['lifetime_w']), rows, indices);
  decodeSharedSh(streams.get('coresh5r_shared'), manifest, activeSlots, rows, indices);
  const checkedNonShValues = await validateNonSh(sourceDirectory, manifest, activeSlots, rows, indices);
  await mkdir(outputDirectory, { recursive: true });
  const outputs = [];
  for (let segmentIndex = 0; segmentIndex < manifest.segments.length; segmentIndex += 1) {
    const segment = manifest.segments[segmentIndex];
    const outputPath = join(outputDirectory, `${segment.name}.decoded.raw4d`);
    const header = raw4dHeader(segment, names[segmentIndex]);
    const payload = Buffer.from(rows[segmentIndex].buffer);
    await writeFile(outputPath, Buffer.concat([header, payload]));
    outputs.push({ path: outputPath, bytes: header.length + payload.length, gaussianCount: segment.gaussianCount });
  }
  const report = {
    sourcePath,
    outputDirectory,
    containerChecksumsValidated: true,
    checkedNonShValues,
    nonShBitExact: true,
    sharedCoReShDecoded: true,
    outputs,
  };
  await writeFile(`${sourcePath}.decode.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}

// #WDD-gpt 2026-08-15 - 独立解码器逐值验证非 SH 位级无损，并从共享五阶段码表恢复六段 SH 后输出前端可读 RAW4D。
await main();
