import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

const MAGIC = 'MIXSC001';
const HEADER_BYTES = 48;

class BitReader {
  constructor(bytes) { this.bytes = bytes; this.offset = 0; this.value = 0; this.bits = 0; }
  read(bits) {
    while (this.bits < bits) {
      this.value += this.bytes[this.offset++] * (2 ** this.bits);
      this.bits += 8;
    }
    const base = 2 ** bits;
    const result = this.value % base;
    this.value = Math.floor(this.value / base);
    this.bits -= bits;
    return result;
  }
}

class BitWriter {
  constructor(totalBits) { this.bytes = Buffer.alloc(Math.ceil(totalBits / 8)); this.offset = 0; this.value = 0; this.bits = 0; }
  write(value, bits) {
    this.value += value * (2 ** this.bits);
    this.bits += bits;
    while (this.bits >= 8) {
      this.bytes[this.offset++] = this.value & 0xff;
      this.value = Math.floor(this.value / 256);
      this.bits -= 8;
    }
  }
  finish() {
    if (this.bits) this.bytes[this.offset++] = this.value & 0xff;
    if (this.offset !== this.bytes.length) throw new Error('Opacity label bit count mismatch.');
    return this.bytes;
  }
}

class VarintWriter {
  constructor() { this.bytes = []; }
  sint(value) {
    let code = value >= 0 ? value * 2 : -value * 2 - 1;
    while (code >= 128) { this.bytes.push((code % 128) | 0x80); code = Math.floor(code / 128); }
    this.bytes.push(code);
  }
  finish() { return Buffer.from(this.bytes); }
}

function modelBits(model) {
  const result = [];
  let offset = 0;
  while (offset < model.length) {
    const bits = model.readUInt8(offset);
    result.push(bits);
    offset += 4 + (1 << bits) * 2;
  }
  if (offset !== model.length) throw new Error('Opacity model layout mismatch.');
  return result;
}

function unpackLabels(labels, bitsByDimension, observationCount) {
  const reader = new BitReader(labels);
  return bitsByDimension.map((bits) => {
    const values = new Uint16Array(observationCount);
    for (let index = 0; index < observationCount; index += 1) values[index] = reader.read(bits);
    return values;
  });
}

function segmentStarts(counts) {
  const starts = [0];
  for (const count of counts) starts.push(starts.at(-1) + count);
  return starts;
}

function fixedLabelTransform(codes, bitsByDimension, counts, mode) {
  const totalBits = codes[0].length * bitsByDimension.reduce((sum, bits) => sum + bits, 0);
  const writer = new BitWriter(totalBits);
  const starts = segmentStarts(counts);
  for (let dimension = 0; dimension < codes.length; dimension += 1) {
    const base = 1 << bitsByDimension[dimension];
    for (let segment = 0; segment < counts.length; segment += 1) {
      let previous = 0;
      let previousDelta = 0;
      for (let index = starts[segment]; index < starts[segment + 1]; index += 1) {
        const value = codes[dimension][index];
        const delta = (value - previous + base) % base;
        let transformed;
        if (mode === 'delta') transformed = delta;
        else if (mode === 'delta2') transformed = (delta - previousDelta + base) % base;
        else if (mode === 'xor') transformed = value ^ previous;
        else if (mode === 'cross') {
          transformed = dimension >= 2
            ? (value - codes[1][index] + base) % base
            : delta;
        } else throw new Error(`Unsupported label transform ${mode}.`);
        writer.write(transformed, bitsByDimension[dimension]);
        previous = value;
        previousDelta = delta;
      }
    }
  }
  return writer.finish();
}

function varintDeltaLabels(codes, bitsByDimension, counts) {
  const writer = new VarintWriter();
  const starts = segmentStarts(counts);
  for (let dimension = 0; dimension < codes.length; dimension += 1) {
    const base = 1 << bitsByDimension[dimension];
    const half = base >>> 1;
    for (let segment = 0; segment < counts.length; segment += 1) {
      let previous = 0;
      for (let index = starts[segment]; index < starts[segment + 1]; index += 1) {
        let delta = (codes[dimension][index] - previous + base) % base;
        if (delta >= half) delta -= base;
        writer.sint(delta);
        previous = codes[dimension][index];
      }
    }
  }
  return writer.finish();
}

// #WDD-gpt 2026-08-16 - 解开 Opacity Scalar-RQ 的三段 Deflate，以真实符号测量单帧上下文压缩和后续标签预测空间。
async function main() {
  const sourcePath = resolve(process.argv[2] ?? '/tmp/compression_v2_inner_entropy/mixsc_opacity.encoded');
  const outputDirectory = resolve(process.argv[3] ?? '/tmp/compression_v2_opacity_entropy');
  const containerPath = resolve(process.argv[4] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16_attribute_so3_hybrid_lossless_v2.4cgs');
  const encoded = await readFile(sourcePath);
  if (encoded.subarray(0, 8).toString('ascii') !== MAGIC) throw new Error('Unsupported Scalar-RQ stream.');
  const observationCount = encoded.readUInt32LE(8);
  const dimensions = encoded.readUInt16LE(12);
  const modelBytes = encoded.readUInt32LE(20);
  const labelBytes = encoded.readUInt32LE(24);
  const maskBytes = encoded.readUInt32LE(28);
  const exceptionBytes = encoded.readUInt32LE(32);
  const exceptionCount = encoded.readUInt32LE(36);
  const rawLabelBytes = encoded.readUInt32LE(44);
  let offset = HEADER_BYTES;
  const model = encoded.subarray(offset, offset + modelBytes);
  offset += modelBytes;
  const labels = inflateSync(encoded.subarray(offset, offset + labelBytes));
  offset += labelBytes;
  const mask = inflateSync(encoded.subarray(offset, offset + maskBytes));
  offset += maskBytes;
  const exceptions = inflateSync(encoded.subarray(offset, offset + exceptionBytes));
  offset += exceptionBytes;
  if (offset !== encoded.length || labels.length !== rawLabelBytes || exceptions.length !== exceptionCount * 2) {
    throw new Error('Scalar-RQ payload validation failed.');
  }
  const symbols = Buffer.concat([model, labels, mask, exceptions]);
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = resolve(outputDirectory, 'opacity.symbols');
  await writeFile(outputPath, symbols);
  const container = await readFile(containerPath);
  const manifestBytes = container.readUInt32LE(8);
  const manifest = JSON.parse(container.subarray(12, 12 + manifestBytes).toString('utf8'));
  const counts = manifest.segments.map((segment) => segment.gaussianCount);
  if (counts.reduce((sum, count) => sum + count, 0) !== observationCount) throw new Error('Opacity segment counts do not match.');
  const bitsByDimension = modelBits(model);
  const codes = unpackLabels(labels, bitsByDimension, observationCount);
  const transformedLabels = {
    spatial_delta_fixed: fixedLabelTransform(codes, bitsByDimension, counts, 'delta'),
    spatial_delta2_fixed: fixedLabelTransform(codes, bitsByDimension, counts, 'delta2'),
    spatial_xor_fixed: fixedLabelTransform(codes, bitsByDimension, counts, 'xor'),
    spatial_cross_fixed: fixedLabelTransform(codes, bitsByDimension, counts, 'cross'),
    spatial_delta_varint: varintDeltaLabels(codes, bitsByDimension, counts),
  };
  const candidates = [];
  for (const [transform, transformed] of Object.entries(transformedLabels)) {
    const payload = Buffer.concat([model, transformed, mask, exceptions]);
    const path = resolve(outputDirectory, `opacity_${transform}.symbols`);
    await writeFile(path, payload);
    candidates.push({ transform, labelBytes: transformed.length, symbolBytes: payload.length, path });
  }
  const report = {
    sourcePath,
    encodedBytes: encoded.length,
    observationCount,
    dimensions,
    exceptionCount,
    streams: {
      model: { rawBytes: model.length, storedBytes: model.length },
      labels: { rawBytes: labels.length, storedBytes: labelBytes },
      mask: { rawBytes: mask.length, storedBytes: maskBytes },
      exceptions: { rawBytes: exceptions.length, storedBytes: exceptionBytes },
    },
    symbolBytes: symbols.length,
    outputPath,
    bitsByDimension,
    segmentObservationCounts: counts,
    candidates,
  };
  await writeFile(resolve(outputDirectory, 'manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

await main();
