import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { brotliDecompressSync, inflateSync } from 'node:zlib';
import { decodeScalarRq } from './fourcgs-scalar-rq-codec.mjs';

const CONTAINER_MAGIC = '4CGSPRS2';

class ByteWriter {
  constructor(chunkBytes = 1 << 20) {
    this.chunkBytes = chunkBytes;
    this.chunks = [];
    this.chunk = Buffer.allocUnsafe(chunkBytes);
    this.offset = 0;
    this.length = 0;
  }
  byte(value) {
    if (this.offset === this.chunk.length) this.flush();
    this.chunk[this.offset++] = value & 0xff;
    this.length += 1;
  }
  uint(value) {
    let remaining = value;
    while (remaining >= 128) { this.byte((remaining % 128) | 0x80); remaining = Math.floor(remaining / 128); }
    this.byte(remaining);
  }
  sint(value) { this.uint(value >= 0 ? value * 2 : -value * 2 - 1); }
  ushort(value) { this.byte(value); this.byte(value >>> 8); }
  flush() {
    if (this.offset) this.chunks.push(this.chunk.subarray(0, this.offset));
    this.chunk = Buffer.allocUnsafe(this.chunkBytes);
    this.offset = 0;
  }
  finish() { this.flush(); return Buffer.concat(this.chunks, this.length); }
}

function orderedHalf(bits) {
  return bits & 0x8000 ? (~bits & 0xffff) : (bits ^ 0x8000);
}

function activeSlots(manifest, mask) {
  return manifest.segments.map((segment, segmentIndex) => {
    const slots = [];
    for (let slot = 0; slot < manifest.slotCount; slot += 1) {
      const bit = segmentIndex * manifest.slotCount + slot;
      if ((mask[bit >>> 3] & (1 << (bit & 7))) !== 0) slots.push(slot);
    }
    if (slots.length !== segment.gaussianCount) throw new Error(`Active-mask mismatch in segment ${segmentIndex}.`);
    return slots;
  });
}

function outerRawStreams(container) {
  if (container.subarray(0, 8).toString('ascii') !== CONTAINER_MAGIC) throw new Error('Unsupported 4CGS container.');
  const manifestBytes = container.readUInt32LE(8);
  const manifest = JSON.parse(container.subarray(12, 12 + manifestBytes).toString('utf8'));
  const streams = new Map();
  let offset = 12 + manifestBytes;
  for (const entry of manifest.streams) {
    const stored = container.subarray(offset, offset + entry.storedBytes);
    let raw;
    if (entry.compression === 'raw') raw = stored;
    else if (entry.compression === 'brotli') raw = brotliDecompressSync(stored);
    else if (entry.compression === 'deflate') raw = inflateSync(stored);
    else raw = null;
    if (raw) streams.set(entry.name, raw);
    offset += entry.storedBytes;
  }
  return { manifest, streams };
}

function shuffled16(values) {
  const output = Buffer.allocUnsafe(values.length * 2);
  for (let index = 0; index < values.length; index += 1) {
    output[index] = values[index] & 0xff;
    output[values.length + index] = values[index] >>> 8;
  }
  return output;
}

// #WDD-gpt 2026-08-16 - 将 V2 已解码 Opacity 位值改写为永久 Track 边界和段内直线残差，测试不依赖旧 RQ 标签的严格等价码率。
async function main() {
  const opacityPath = resolve(process.argv[2] ?? '/tmp/compression_v2_inner_entropy/mixsc_opacity.encoded');
  const containerPath = resolve(process.argv[3] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16_attribute_so3_hybrid_lossless_v2.4cgs');
  const outputDirectory = resolve(process.argv[4] ?? '/tmp/compression_v2_opacity_temporal_exact');
  const opacity = await readFile(opacityPath);
  const decoded = decodeScalarRq(opacity);
  if (decoded.metrics.dimensions !== 4) throw new Error('Expected four Opacity banks.');
  const { manifest, streams } = outerRawStreams(await readFile(containerPath));
  const slotsBySegment = activeSlots(manifest, streams.get('active_masks'));
  const birth = new Uint16Array(manifest.slotCount);
  const endState = new Int32Array(manifest.slotCount);
  const initialized = new Uint8Array(manifest.slotCount);
  const boundary = new ByteWriter();
  const endpoint = new ByteWriter();
  const internal1 = new ByteWriter();
  const internal2 = new ByteWriter();
  let observation = 0;
  for (const slots of slotsBySegment) {
    for (const slot of slots) {
      const values = [0, 1, 2, 3].map((bank) => orderedHalf(decoded.bits[observation * 4 + bank]));
      if (!initialized[slot]) birth[slot] = values[0];
      else boundary.sint(values[0] - endState[slot]);
      endpoint.sint(values[3] - values[0]);
      internal1.sint(values[1] - Math.round((values[0] * 2 + values[3]) / 3));
      internal2.sint(values[2] - Math.round((values[0] + values[3] * 2) / 3));
      endState[slot] = values[3];
      initialized[slot] = 1;
      observation += 1;
    }
  }
  if (observation !== decoded.metrics.observationCount || initialized.some((value) => value === 0)) throw new Error('Opacity temporal layout mismatch.');
  const birthAbsoluteWriter = new ByteWriter();
  const birthDeltaWriter = new ByteWriter();
  let previousBirth = 0;
  for (const value of birth) {
    birthAbsoluteWriter.ushort(value);
    birthDeltaWriter.sint(value - previousBirth);
    previousBirth = value;
  }
  const residuals = [boundary.finish(), endpoint.finish(), internal1.finish(), internal2.finish()];
  const candidates = {
    temporal_birth_absolute16: Buffer.concat([birthAbsoluteWriter.finish(), ...residuals]),
    temporal_birth_shuffle16: Buffer.concat([shuffled16(birth), ...residuals]),
    temporal_birth_spatial_delta_varint: Buffer.concat([birthDeltaWriter.finish(), ...residuals]),
  };
  await mkdir(outputDirectory, { recursive: true });
  const report = {
    opacityPath,
    containerPath,
    sourceEncodedBytes: opacity.length,
    observationCount: observation,
    slotCount: manifest.slotCount,
    residualBytes: {
      boundary: residuals[0].length,
      endpoint: residuals[1].length,
      internal1: residuals[2].length,
      internal2: residuals[3].length,
    },
    candidates: [],
  };
  for (const [name, payload] of Object.entries(candidates)) {
    const path = resolve(outputDirectory, `${name}.symbols`);
    await writeFile(path, payload);
    report.candidates.push({ name, bytes: payload.length, path });
  }
  await writeFile(resolve(outputDirectory, 'manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

await main();
