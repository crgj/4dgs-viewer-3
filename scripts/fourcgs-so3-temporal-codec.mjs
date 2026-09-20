import { ByteWriter, decodeRans, encodeRans, floatToHalf, halfToFloat } from './fourcgs-prs-codec.mjs';

const MAGIC = 'SO3TR001';

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
  constructor() { this.output = new ByteWriter(); this.value = 0; this.bits = 0; }
  write(value, bits) {
    this.value += value * 2 ** this.bits;
    this.bits += bits;
    while (this.bits >= 8) { this.output.byte(this.value & 0xff); this.value = Math.floor(this.value / 256); this.bits -= 8; }
  }
  finish() { if (this.bits) this.output.byte(this.value & 0xff); return this.output.finish(); }
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
  const exceptionBody = new ByteWriter();
  let exceptionCount = 0;
  let previousExceptionOrdinal = -1;
  let ordinal = 0;
  let squared = 0;
  let maximum = 0;
  const accept = (source, reconstructed, sourceBits) => {
    const error = angleDegrees(source, reconstructed);
    squared += error * error;
    maximum = Math.max(maximum, error);
    if (error > maximumAngleDegrees || !Number.isFinite(error)) {
      exceptionBody.uint(ordinal - previousExceptionOrdinal - 1);
      for (const value of sourceBits) exceptionBody.ushort(value);
      previousExceptionOrdinal = ordinal;
      exceptionCount += 1;
      return source;
    }
    return reconstructed;
  };
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    if (!Number.isInteger(bankCounts[segmentIndex]) || bankCounts[segmentIndex] < 1) {
      throw new Error('SO(3) codec requires at least one Rotation bank per segment.');
    }
    const segment = segments[segmentIndex];
    const active = layout.activeSlots[segmentIndex];
    const activeLocals = layout.activeLocals?.[segmentIndex];
    const inverse = activeLocals ? null : layout.slotToLocal[segmentIndex];
    for (let row = 0; row < active.length; row += 1) {
      const slot = active[row];
      const local = activeLocals ? activeLocals[row] : inverse[slot];
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
      let previous = start;
      for (let bank = 1; bank < bankCounts[segmentIndex]; bank += 1) {
        const source = sourceQuaternion(segment, local, bank);
        const vector = tangent(previous, source);
        const codes = vector.map((value) => Math.round(value / step));
        for (let axis = 0; axis < 3; axis += 1) context.endpoint[axis].sint(codes[axis]);
        let reconstructed = halfQuaternion(applyTangent(previous, codes.map((value) => value * step)));
        reconstructed = accept(source, reconstructed, bitsAt(bank)); ordinal += 1;
        previous = reconstructed;
      }
      state.set(previous, slot * 4);
      initialized[slot] = 1;
    }
  }
  const birth = new BitWriter();
  for (let slot = 0; slot < layout.slotCount; slot += 1) {
    birth.write(birthLargest[slot], 2);
    for (let axis = 0; axis < 3; axis += 1) birth.write(birthCodes[axis][slot], bits);
  }
  const exceptionWriter = new ByteWriter();
  exceptionWriter.uint(exceptionCount);
  const exceptionPrefix = exceptionWriter.finish();
  const exceptionRaw = Buffer.concat([exceptionPrefix, exceptionBody.finish()]);
  const rawWriters = [{ name: 'birth', writer: birth }];
  for (const name of ['boundary', 'endpoint']) {
    for (let axis = 0; axis < 3; axis += 1) rawWriters.push({ name: `${name}:${axis}`, writer: context[name][axis] });
  }
  const streams = rawWriters.map((stream) => {
    const raw = stream.writer.finish();
    return { name: stream.name, bytes: encodeRans(raw), rawBytes: raw.length };
  });
  streams.push({ name: 'exceptions', bytes: encodeRans(exceptionRaw), rawBytes: exceptionRaw.length });
  const encoded = pack({ bits, stepDegrees, maximumAngleDegrees, slotCount: layout.slotCount, bankCounts }, streams);
  return { encoded, metrics: { encodedBytes: encoded.length, observationCount: ordinal, bits, stepDegrees, measuredAngularRmseDegrees: Math.sqrt(squared / ordinal), measuredMaximumAngleDegrees: maximum, exceptionCount, streams: streams.map((stream) => ({ name: stream.name, rawBytes: stream.rawBytes, encodedBytes: stream.bytes.length })) } };
}

export function decodeSo3Rotations(encoded, manifest, activeSlots, rows, indices) {
  const { metadata, streams } = unpack(encoded);
  return decodeSo3RotationStreams(metadata, streams, manifest, activeSlots, rows, indices);
}

function int32Storage(length, shared) {
  const buffer = shared && typeof SharedArrayBuffer !== 'undefined'
    ? new SharedArrayBuffer(length * Int32Array.BYTES_PER_ELEMENT)
    : new ArrayBuffer(length * Int32Array.BYTES_PER_ELEMENT);
  return new Int32Array(buffer);
}

function uint16Storage(length, shared) {
  const buffer = shared && typeof SharedArrayBuffer !== 'undefined'
    ? new SharedArrayBuffer(length * Uint16Array.BYTES_PER_ELEMENT)
    : new ArrayBuffer(length * Uint16Array.BYTES_PER_ELEMENT);
  return new Uint16Array(buffer);
}

function uint8Storage(length, shared) {
  const buffer = shared && typeof SharedArrayBuffer !== 'undefined'
    ? new SharedArrayBuffer(length)
    : new ArrayBuffer(length);
  return new Uint8Array(buffer);
}

// #WDD-gpt 2026-08-16 - Rotation 先顺序展开位流为共享整数平面，随后可按永久 Track 分区并行执行独立 SO(3) 重建。
export function prepareSo3RotationStreams(metadata, streams, manifest, activeSlots, shared = false, directReaders = null) {
  if (metadata.slotCount !== manifest.slotCount) throw new Error('SO(3) slot mismatch.');
  const birthReader = new BitReader(streams.get('birth'));
  const birthLargest = uint8Storage(manifest.slotCount, shared);
  const birthCodes = uint16Storage(manifest.slotCount * 3, shared);
  for (let slot = 0; slot < manifest.slotCount; slot += 1) {
    birthLargest[slot] = birthReader.read(2);
    const offset = slot * 3;
    birthCodes[offset] = birthReader.read(metadata.bits);
    birthCodes[offset + 1] = birthReader.read(metadata.bits);
    birthCodes[offset + 2] = birthReader.read(metadata.bits);
  }
  const context = Object.fromEntries(['boundary', 'endpoint'].map((name) => [name, Array.from({ length: 3 }, (_, axis) => directReaders?.get(`${name}:${axis}`) ?? new ByteReader(streams.get(`${name}:${axis}`)))]));
  const exceptionReader = new ByteReader(streams.get('exceptions'));
  const exceptionCount = exceptionReader.uint();
  const exceptionOrdinals = int32Storage(exceptionCount, shared);
  const exceptionBits = uint16Storage(exceptionCount * 4, shared);
  let exceptionOrdinal = -1;
  for (let index = 0; index < exceptionCount; index += 1) {
    exceptionOrdinal += exceptionReader.uint() + 1;
    exceptionOrdinals[index] = exceptionOrdinal;
    const offset = index * 4;
    exceptionBits[offset] = exceptionReader.ushort();
    exceptionBits[offset + 1] = exceptionReader.ushort();
    exceptionBits[offset + 2] = exceptionReader.ushort();
    exceptionBits[offset + 3] = exceptionReader.ushort();
  }
  exceptionReader.done();

  const seen = new Uint8Array(manifest.slotCount);
  let instanceCount = 0;
  let boundaryCount = 0;
  let intraCount = 0;
  for (let segmentIndex = 0; segmentIndex < activeSlots.length; segmentIndex += 1) {
    const active = activeSlots[segmentIndex];
    for (let row = 0; row < active.length; row += 1) {
      const slot = active[row];
      if (seen[slot]) boundaryCount += 1;
      else seen[slot] = 1;
      instanceCount += 1;
    }
    intraCount += active.length * (metadata.bankCounts[segmentIndex] - 1);
  }
  const boundary = Array.from({ length: 3 }, (_, axis) => {
    const values = int32Storage(boundaryCount, shared);
    for (let index = 0; index < values.length; index += 1) values[index] = context.boundary[axis].sint();
    context.boundary[axis].done();
    return values;
  });
  const endpoint = Array.from({ length: 3 }, (_, axis) => {
    const values = int32Storage(intraCount, shared);
    for (let index = 0; index < values.length; index += 1) values[index] = context.endpoint[axis].sint();
    context.endpoint[axis].done();
    return values;
  });
  const expectedObservations = metadata.bankCounts.reduce(
    (sum, count, segmentIndex) => sum + count * activeSlots[segmentIndex].length, 0,
  );
  if (expectedObservations !== instanceCount + intraCount) throw new Error('SO(3) Rotation bank observation count mismatch.');
  return {
    bits: metadata.bits,
    stepDegrees: metadata.stepDegrees,
    slotCount: manifest.slotCount,
    instanceCount,
    intraCount,
    bankCounts: metadata.bankCounts,
    boundaryCount,
    exceptionCount,
    birthLargest,
    birthCodes,
    boundary,
    endpoint,
    exceptionOrdinals,
    exceptionBits,
  };
}

// #WDD-gpt 2026-09-20 - 旋转重建复用四元数暂存，保留原归一化、FP16 回环和乘法次序，消除逐点短数组分配。
function normalizeQuaternionInPlace(q) {
  const length = Math.hypot(q[0], q[1], q[2], q[3]);
  if (length > 1e-12 && Number.isFinite(length)) { q[0] /= length; q[1] /= length; q[2] /= length; q[3] /= length; }
  else { q[0] = 1; q[1] = 0; q[2] = 0; q[3] = 0; }
  if (q[0] < 0) { q[0] = -q[0]; q[1] = -q[1]; q[2] = -q[2]; q[3] = -q[3]; }
}
function halfQuaternionInPlace(q) {
  for (let axis = 0; axis < 4; axis++) q[axis] = halfToFloat(floatToHalf(q[axis]));
  normalizeQuaternionInPlace(q);
}
function birthQuaternionInPlace(q, prepared, slot) {
  const largest = prepared.birthLargest[slot], maximum = (1 << prepared.bits) - 1;
  let source = slot * 3, square = 0;
  for (let axis = 0; axis < 4; axis++) {
    if (axis === largest) q[axis] = 0;
    else { const value = prepared.birthCodes[source++] / maximum * Math.SQRT2 - Math.SQRT1_2; q[axis] = value; square += value * value; }
  }
  q[largest] = Math.sqrt(Math.max(0, 1 - square));
  normalizeQuaternionInPlace(q);
}
function tangentQuaternionInPlace(q, vx, vy, vz) {
  const angle = Math.hypot(vx, vy, vz);
  if (angle < 1e-12) return;
  const scale = Math.sin(angle / 2) / angle, bw = Math.cos(angle / 2), bx = vx * scale, by = vy * scale, bz = vz * scale;
  const w = q[0], x = q[1], y = q[2], z = q[3];
  q[0] = w * bw - x * bx - y * by - z * bz;
  q[1] = w * bx + x * bw + y * bz - z * by;
  q[2] = w * by - x * bz + y * bw + z * bx;
  q[3] = w * bz + x * by - y * bx + z * bw;
  normalizeQuaternionInPlace(q);
}

export function decodeSo3RotationPartition(prepared, manifest, activeSlots, rows, indices, partitionIndex = 0, partitionCount = 1) {
  if (!Number.isInteger(partitionIndex) || !Number.isInteger(partitionCount)
    || partitionCount < 1 || partitionIndex < 0 || partitionIndex >= partitionCount) {
    throw new Error('SO(3) partition is invalid.');
  }
  // #WDD-gpt 2026-09-20 - 例外序号本来已严格递增；分区遍历用游标读取共享 TypedArray，禁止每个 Worker 再建立数百万项 JS Map。
  let exceptionCursor = 0;
  const exceptionOffset = (ordinal) => {
    while (exceptionCursor < prepared.exceptionCount
      && prepared.exceptionOrdinals[exceptionCursor] < ordinal) exceptionCursor += 1;
    return exceptionCursor < prepared.exceptionCount
      && prepared.exceptionOrdinals[exceptionCursor] === ordinal
      ? exceptionCursor * 4
      : -1;
  };
  const step = prepared.stepDegrees * Math.PI / 180;
  // #WDD-gpt 2026-09-20 - 每个分区只保存自己负责的 Track 四元数；多 Worker 总状态量保持约 slotCount×4，而不再按分区数倍增。
  const partitionSlotCount = Math.max(0, Math.ceil((manifest.slotCount - partitionIndex) / partitionCount));
  const state = new Float32Array(partitionSlotCount * 4);
  const seen = new Uint8Array(manifest.slotCount);
  const propertyOffsets = manifest.segments.map((segment, segmentIndex) => Array.from({ length: segment.bankCounts.rotation }, (_, bank) => ['w', 'x', 'y', 'z'].map((component) => {
    const property = indices[segmentIndex].get(`rot_bank_${bank}_${component}`);
    if (property === undefined) throw new Error(`SO(3) property layout missing for segment ${segmentIndex}, bank ${bank}, ${component}.`);
    return property;
  })));
  let instance = 0;
  let boundaryIndex = 0;
  let intraIndex = 0;
  let observationOrdinal = 0;
  let processedObservations = 0;
  const q = new Float64Array(4);
  for (let segmentIndex = 0; segmentIndex < manifest.segments.length; segmentIndex += 1) {
    const rowValues = rows[segmentIndex];
    const stride = indices[segmentIndex].size;
    const offsets = propertyOffsets[segmentIndex];
    for (let row = 0; row < activeSlots[segmentIndex].length; row += 1) {
      const slot = activeSlots[segmentIndex][row];
      const continuing = seen[slot] !== 0;
      if (!continuing) seen[slot] = 1;
      const currentBoundary = boundaryIndex;
      if (continuing) boundaryIndex += 1;
      instance += 1;
      const bankCount = prepared.bankCounts[segmentIndex];
      const currentIntraIndex = intraIndex;
      intraIndex += bankCount - 1;
      const currentObservationOrdinal = observationOrdinal;
      observationOrdinal += bankCount;
      if (slot % partitionCount !== partitionIndex) continue;
      const partitionSlot = Math.floor(slot / partitionCount);
      const stateOffset = partitionSlot * 4;
      processedObservations += bankCount;
      if (!continuing) birthQuaternionInPlace(q, prepared, slot);
      else {
        for (let axis = 0; axis < 4; axis++) q[axis] = state[stateOffset + axis];
        tangentQuaternionInPlace(q, prepared.boundary[0][currentBoundary] * step,
          prepared.boundary[1][currentBoundary] * step, prepared.boundary[2][currentBoundary] * step);
      }
      const rowOffset = row * stride;
      for (let bank = 0; bank < bankCount; bank++) {
        if (bank > 0) {
          const endpoint = currentIntraIndex + bank - 1;
          tangentQuaternionInPlace(q, prepared.endpoint[0][endpoint] * step,
            prepared.endpoint[1][endpoint] * step, prepared.endpoint[2][endpoint] * step);
        }
        halfQuaternionInPlace(q);
        const exception = exceptionOffset(currentObservationOrdinal + bank);
        for (let axis = 0; axis < 4; axis++) {
          const bits = exception >= 0 ? prepared.exceptionBits[exception + axis] : floatToHalf(q[axis]);
          rowValues[rowOffset + offsets[bank][axis]] = bits;
          if (exception >= 0) q[axis] = halfToFloat(bits);
        }
        if (exception >= 0) normalizeQuaternionInPlace(q);
      }
      state.set(q, stateOffset);
    }
  }
  if (instance !== prepared.instanceCount || boundaryIndex !== prepared.boundaryCount
    || intraIndex !== prepared.intraCount) throw new Error('SO(3) partition traversal mismatch.');
  return {
    observationCount: processedObservations,
    appliedExceptions: prepared.exceptionCount,
    stepDegrees: prepared.stepDegrees,
  };
}

// #WDD-gpt 2026-08-16 - V2.4 直接消费结构化外层恢复出的原始子流，跳过昂贵的 rANS 重编码再解码。
export function decodeSo3RotationStreams(metadata, streams, manifest, activeSlots, rows, indices) {
  const prepared = prepareSo3RotationStreams(metadata, streams, manifest, activeSlots, false);
  const result = decodeSo3RotationPartition(prepared, manifest, activeSlots, rows, indices);
  if (result.observationCount !== prepared.instanceCount + prepared.intraCount) throw new Error('SO(3) observation mismatch.');
  return result;
}
