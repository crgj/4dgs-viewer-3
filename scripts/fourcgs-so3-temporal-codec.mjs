import { decodeRans, encodeRans, floatToHalf, halfToFloat } from './fourcgs-prs-codec.mjs';

const MAGIC = 'SO3TR001';

class ByteWriter {
  constructor() { this.bytes = []; }
  byte(value) { this.bytes.push(value & 0xff); }
  uint(value) {
    let remaining = Math.trunc(value);
    while (remaining >= 128) { this.byte((remaining % 128) | 0x80); remaining = Math.floor(remaining / 128); }
    this.byte(remaining);
  }
  sint(value) { this.uint(value >= 0 ? value * 2 : -value * 2 - 1); }
  ushort(value) { this.byte(value); this.byte(value >>> 8); }
  finish() { return Buffer.from(this.bytes); }
}

class ByteReader {
  constructor(bytes) { this.bytes = bytes; this.offset = 0; }
  byte() { if (this.offset >= this.bytes.length) throw new Error('Unexpected SO(3) stream end.'); return this.bytes[this.offset++]; }
  uint() {
    let value = 0;
    let multiplier = 1;
    for (let index = 0; index < 8; index += 1) {
      const byte = this.byte(); value += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) return value;
      multiplier *= 128;
    }
    throw new Error('Oversized SO(3) varint.');
  }
  sint() { const value = this.uint(); return value & 1 ? -(value + 1) / 2 : value / 2; }
  ushort() { return this.byte() | (this.byte() << 8); }
  done() { if (this.offset !== this.bytes.length) throw new Error(`Unused SO(3) bytes: ${this.bytes.length - this.offset}`); }
}

class BitWriter {
  constructor() { this.bytes = []; this.value = 0; this.bits = 0; }
  write(value, bits) {
    this.value += value * 2 ** this.bits;
    this.bits += bits;
    while (this.bits >= 8) { this.bytes.push(this.value & 0xff); this.value = Math.floor(this.value / 256); this.bits -= 8; }
  }
  finish() { if (this.bits) this.bytes.push(this.value & 0xff); return Buffer.from(this.bytes); }
}

class BitReader {
  constructor(bytes) { this.bytes = bytes; this.offset = 0; this.value = 0; this.bits = 0; }
  read(bits) {
    while (this.bits < bits) { this.value += this.bytes[this.offset++] * 2 ** this.bits; this.bits += 8; }
    const base = 2 ** bits;
    const result = this.value % base;
    this.value = Math.floor(this.value / base);
    this.bits -= bits;
    return result;
  }
}

function normalized(values) {
  const length = Math.hypot(...values);
  let result = length > 1e-12 && Number.isFinite(length) ? values.map((value) => value / length) : [1, 0, 0, 0];
  if (result[0] < 0) result = result.map((value) => -value);
  return result;
}

function multiply(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

function tangent(from, to) {
  let target = to;
  if (from.reduce((sum, value, index) => sum + value * target[index], 0) < 0) target = target.map((value) => -value);
  const relative = normalized(multiply([from[0], -from[1], -from[2], -from[3]], target));
  const sine = Math.hypot(relative[1], relative[2], relative[3]);
  if (sine < 1e-12) return [0, 0, 0];
  const angle = 2 * Math.atan2(sine, Math.max(0, relative[0]));
  return [relative[1] / sine * angle, relative[2] / sine * angle, relative[3] / sine * angle];
}

function applyTangent(from, vector) {
  const angle = Math.hypot(...vector);
  if (angle < 1e-12) return from;
  const scale = Math.sin(angle / 2) / angle;
  return normalized(multiply(from, [Math.cos(angle / 2), vector[0] * scale, vector[1] * scale, vector[2] * scale]));
}

function angleDegrees(a, b) {
  const dot = Math.min(1, Math.abs(a.reduce((sum, value, index) => sum + value * b[index], 0)));
  return 2 * Math.acos(dot) * 180 / Math.PI;
}

function quantizeSmallestThree(source, bits) {
  const quaternion = normalized(source);
  let largest = 0;
  for (let index = 1; index < 4; index += 1) if (Math.abs(quaternion[index]) > Math.abs(quaternion[largest])) largest = index;
  const sign = quaternion[largest] < 0 ? -1 : 1;
  const maximum = (1 << bits) - 1;
  const codes = [];
  for (let index = 0; index < 4; index += 1) if (index !== largest) {
    codes.push(Math.max(0, Math.min(maximum, Math.round(((quaternion[index] * sign + Math.SQRT1_2) / Math.SQRT2) * maximum))));
  }
  return { largest, codes };
}

function decodeSmallestThree(largest, codes, bits) {
  const maximum = (1 << bits) - 1;
  const values = [];
  let source = 0;
  let square = 0;
  for (let index = 0; index < 4; index += 1) {
    if (index === largest) values.push(0);
    else { const value = codes[source++] / maximum * Math.SQRT2 - Math.SQRT1_2; values.push(value); square += value * value; }
  }
  values[largest] = Math.sqrt(Math.max(0, 1 - square));
  return normalized(values);
}

function halfQuaternion(quaternion) {
  return normalized(quaternion.map((value) => halfToFloat(floatToHalf(value))));
}

function sourceQuaternion(segment, local, bank) {
  const base = local * segment.propertyNames.length;
  return normalized(['w', 'x', 'y', 'z'].map((component) => halfToFloat(segment.rows[base + segment.propertyIndex.get(`rot_bank_${bank}_${component}`)])));
}

function pack(metadata, streams) {
  const directory = Buffer.from(JSON.stringify({ ...metadata, streams: streams.map((stream) => ({ name: stream.name, bytes: stream.bytes.length })) }), 'utf8');
  const prefix = Buffer.alloc(12); prefix.write(MAGIC, 0, 'ascii'); prefix.writeUInt32LE(directory.length, 8);
  return Buffer.concat([prefix, directory, ...streams.map((stream) => stream.bytes)]);
}

function unpack(encoded) {
  if (encoded.subarray(0, 8).toString('ascii') !== MAGIC) throw new Error('Unsupported SO(3) temporal stream.');
  const directoryBytes = encoded.readUInt32LE(8);
  const metadata = JSON.parse(encoded.subarray(12, 12 + directoryBytes).toString('utf8'));
  const streams = new Map();
  let offset = 12 + directoryBytes;
  for (const stream of metadata.streams) { streams.set(stream.name, decodeRans(encoded.subarray(offset, offset + stream.bytes))); offset += stream.bytes; }
  if (offset !== encoded.length) throw new Error('SO(3) trailing bytes.');
  return { metadata, streams };
}

// #WDD-gpt 2026-08-15 - Rotation 使用独立的 smallest-three 出生姿态和 SO(3) 边界/段内切空间残差，避免四元数分量跳变。
export function encodeSo3Rotations(segments, layout, bankCounts, options = {}) {
  const bits = options.bits ?? 12;
  const stepDegrees = options.stepDegrees ?? 0.025;
  const step = stepDegrees * Math.PI / 180;
  const maximumAngleDegrees = options.maximumAngleDegrees ?? 0.1;
  const birthLargest = new Uint8Array(layout.slotCount);
  const birthCodes = [new Uint16Array(layout.slotCount), new Uint16Array(layout.slotCount), new Uint16Array(layout.slotCount)];
  const context = { boundary: [new ByteWriter(), new ByteWriter(), new ByteWriter()], endpoint: [new ByteWriter(), new ByteWriter(), new ByteWriter()] };
  const state = new Float32Array(layout.slotCount * 4);
  const initialized = new Uint8Array(layout.slotCount);
  const exceptions = [];
  let ordinal = 0;
  let squared = 0;
  let maximum = 0;
  const accept = (source, reconstructed, sourceBits) => {
    const error = angleDegrees(source, reconstructed);
    squared += error * error;
    maximum = Math.max(maximum, error);
    if (error > maximumAngleDegrees || !Number.isFinite(error)) { exceptions.push({ ordinal, bits: sourceBits }); return source; }
    return reconstructed;
  };
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    if (bankCounts[segmentIndex] !== 2) throw new Error('SO(3) codec expects two Rotation banks per segment.');
    const segment = segments[segmentIndex];
    const active = layout.activeSlots[segmentIndex];
    const inverse = layout.slotToLocal[segmentIndex];
    for (const slot of active) {
      const local = inverse[slot];
      const base = local * segment.propertyNames.length;
      const bitsAt = (bank) => ['w', 'x', 'y', 'z'].map((component) => segment.rows[base + segment.propertyIndex.get(`rot_bank_${bank}_${component}`)]);
      const startSource = sourceQuaternion(segment, local, 0);
      let start;
      if (!initialized[slot]) {
        const quantized = quantizeSmallestThree(startSource, bits);
        birthLargest[slot] = quantized.largest;
        for (let axis = 0; axis < 3; axis += 1) birthCodes[axis][slot] = quantized.codes[axis];
        start = halfQuaternion(decodeSmallestThree(quantized.largest, quantized.codes, bits));
      } else {
        const previous = Array.from(state.subarray(slot * 4, slot * 4 + 4));
        const vector = tangent(previous, startSource);
        const codes = vector.map((value) => Math.round(value / step));
        for (let axis = 0; axis < 3; axis += 1) context.boundary[axis].sint(codes[axis]);
        start = halfQuaternion(applyTangent(previous, codes.map((value) => value * step)));
      }
      start = accept(startSource, start, bitsAt(0)); ordinal += 1;
      const endSource = sourceQuaternion(segment, local, 1);
      const vector = tangent(start, endSource);
      const codes = vector.map((value) => Math.round(value / step));
      for (let axis = 0; axis < 3; axis += 1) context.endpoint[axis].sint(codes[axis]);
      let end = halfQuaternion(applyTangent(start, codes.map((value) => value * step)));
      end = accept(endSource, end, bitsAt(1)); ordinal += 1;
      state.set(end, slot * 4);
      initialized[slot] = 1;
    }
  }
  const birth = new BitWriter();
  for (let slot = 0; slot < layout.slotCount; slot += 1) {
    birth.write(birthLargest[slot], 2);
    for (let axis = 0; axis < 3; axis += 1) birth.write(birthCodes[axis][slot], bits);
  }
  const exceptionWriter = new ByteWriter();
  exceptionWriter.uint(exceptions.length);
  let previousOrdinal = -1;
  for (const exception of exceptions) {
    exceptionWriter.uint(exception.ordinal - previousOrdinal - 1); previousOrdinal = exception.ordinal;
    for (const value of exception.bits) exceptionWriter.ushort(value);
  }
  const raw = [{ name: 'birth', raw: birth.finish() }];
  for (const name of ['boundary', 'endpoint']) for (let axis = 0; axis < 3; axis += 1) raw.push({ name: `${name}:${axis}`, raw: context[name][axis].finish() });
  raw.push({ name: 'exceptions', raw: exceptionWriter.finish() });
  const streams = raw.map((stream) => ({ name: stream.name, bytes: encodeRans(stream.raw), rawBytes: stream.raw.length }));
  const encoded = pack({ bits, stepDegrees, maximumAngleDegrees, slotCount: layout.slotCount, bankCounts }, streams);
  return { encoded, metrics: { encodedBytes: encoded.length, observationCount: ordinal, bits, stepDegrees, measuredAngularRmseDegrees: Math.sqrt(squared / ordinal), measuredMaximumAngleDegrees: maximum, exceptionCount: exceptions.length, streams: streams.map((stream) => ({ name: stream.name, rawBytes: stream.rawBytes, encodedBytes: stream.bytes.length })) } };
}

export function decodeSo3Rotations(encoded, manifest, activeSlots, rows, indices) {
  const { metadata, streams } = unpack(encoded);
  return decodeSo3RotationStreams(metadata, streams, manifest, activeSlots, rows, indices);
}

// #WDD-gpt 2026-08-16 - V2.4 直接消费结构化外层恢复出的原始子流，跳过昂贵的 rANS 重编码再解码。
export function decodeSo3RotationStreams(metadata, streams, manifest, activeSlots, rows, indices) {
  if (metadata.slotCount !== manifest.slotCount) throw new Error('SO(3) slot mismatch.');
  const birthReader = new BitReader(streams.get('birth'));
  const birth = Array.from({ length: manifest.slotCount }, () => ({ largest: birthReader.read(2), codes: [birthReader.read(metadata.bits), birthReader.read(metadata.bits), birthReader.read(metadata.bits)] }));
  const context = Object.fromEntries(['boundary', 'endpoint'].map((name) => [name, Array.from({ length: 3 }, (_, axis) => new ByteReader(streams.get(`${name}:${axis}`)))]));
  const exceptionReader = new ByteReader(streams.get('exceptions'));
  const exceptions = new Map();
  const exceptionCount = exceptionReader.uint();
  let exceptionOrdinal = -1;
  for (let index = 0; index < exceptionCount; index += 1) {
    exceptionOrdinal += exceptionReader.uint() + 1;
    exceptions.set(exceptionOrdinal, [exceptionReader.ushort(), exceptionReader.ushort(), exceptionReader.ushort(), exceptionReader.ushort()]);
  }
  exceptionReader.done();
  const step = metadata.stepDegrees * Math.PI / 180;
  const state = new Float32Array(manifest.slotCount * 4);
  const initialized = new Uint8Array(manifest.slotCount);
  let ordinal = 0;
  for (let segmentIndex = 0; segmentIndex < manifest.segments.length; segmentIndex += 1) {
    const rowValues = rows[segmentIndex];
    const stride = indices[segmentIndex].size;
    for (let row = 0; row < activeSlots[segmentIndex].length; row += 1) {
      const slot = activeSlots[segmentIndex][row];
      let start;
      if (!initialized[slot]) start = halfQuaternion(decodeSmallestThree(birth[slot].largest, birth[slot].codes, metadata.bits));
      else {
        const previous = Array.from(state.subarray(slot * 4, slot * 4 + 4));
        start = halfQuaternion(applyTangent(previous, context.boundary.map((reader) => reader.sint() * step)));
      }
      const startException = exceptions.get(ordinal++);
      const startBits = startException ?? start.map(floatToHalf);
      if (startException) start = normalized(startBits.map(halfToFloat));
      for (let axis = 0; axis < 4; axis += 1) rowValues[row * stride + indices[segmentIndex].get(`rot_bank_0_${['w', 'x', 'y', 'z'][axis]}`)] = startBits[axis];
      let end = halfQuaternion(applyTangent(start, context.endpoint.map((reader) => reader.sint() * step)));
      const endException = exceptions.get(ordinal++);
      const endBits = endException ?? end.map(floatToHalf);
      if (endException) end = normalized(endBits.map(halfToFloat));
      for (let axis = 0; axis < 4; axis += 1) rowValues[row * stride + indices[segmentIndex].get(`rot_bank_1_${['w', 'x', 'y', 'z'][axis]}`)] = endBits[axis];
      state.set(end, slot * 4);
      initialized[slot] = 1;
    }
  }
  for (const readers of Object.values(context)) for (const reader of readers) reader.done();
  if (ordinal !== metadata.bankCounts.reduce((sum, count, segmentIndex) => sum + count * activeSlots[segmentIndex].length, 0)) throw new Error('SO(3) observation mismatch.');
  return { observationCount: ordinal, appliedExceptions: exceptionCount, stepDegrees: metadata.stepDegrees };
}
