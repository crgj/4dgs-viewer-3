import { createHash } from 'node:crypto';

const RANS_MAGIC = 'RANSB001';
const RANS_SCALE_BITS = 12;
const RANS_TOTAL = 1 << RANS_SCALE_BITS;
const RANS_LOW = 1 << 23;
const floatView = new DataView(new ArrayBuffer(4));

function decodeHalfBits(bits) {
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

// #WDD-gpt 2026-08-16 - Position/Crop/SH 会重复读取数千万个 FP16；64K 查表消除 DataView 热循环且保持逐 bit 解码语义。
const halfToFloatTable = new Float32Array(1 << 16);
for (let bits = 0; bits < halfToFloatTable.length; bits += 1) halfToFloatTable[bits] = decodeHalfBits(bits);

export function halfToFloat(bits) {
  return halfToFloatTable[bits & 0xffff];
}

export function floatToHalf(value) {
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

// #WDD-gpt 2026-09-19 - 所有大码流统一使用 TypedArray 分块写入，禁止逐字节堆积为 V8 number[]。
export class ByteWriter {
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
    let remaining = Math.trunc(value);
    if (!Number.isSafeInteger(remaining) || remaining < 0) throw new Error(`Invalid unsigned varint ${value}`);
    while (remaining >= 128) {
      this.byte((remaining % 128) | 0x80);
      remaining = Math.floor(remaining / 128);
    }
    this.byte(remaining);
  }

  sint(value) {
    this.uint(value >= 0 ? value * 2 : -value * 2 - 1);
  }

  ushort(value) {
    this.byte(value);
    this.byte(value >>> 8);
  }

  flush() {
    if (this.offset > 0) this.chunks.push(this.chunk.subarray(0, this.offset));
    this.chunk = Buffer.allocUnsafe(this.chunkBytes);
    this.offset = 0;
  }

  finish() {
    this.flush();
    const chunks = this.chunks;
    const length = this.length;
    this.chunks = [];
    this.chunk = Buffer.alloc(0);
    this.offset = 0;
    this.length = 0;
    return Buffer.concat(chunks, length);
  }
}

class ByteReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }

  byte() {
    if (this.offset >= this.bytes.length) throw new Error('Unexpected end of PRS byte stream.');
    return this.bytes[this.offset++];
  }

  uint() {
    let value = 0;
    let multiplier = 1;
    for (let byteIndex = 0; byteIndex < 8; byteIndex += 1) {
      const byte = this.byte();
      value += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) return value;
      multiplier *= 128;
    }
    throw new Error('Oversized PRS varint.');
  }

  sint() {
    const value = this.uint();
    return value & 1 ? -(value + 1) / 2 : value / 2;
  }

  ushort() {
    return this.byte() | (this.byte() << 8);
  }

  done() {
    if (this.offset !== this.bytes.length) throw new Error(`Unused PRS bytes: ${this.bytes.length - this.offset}`);
  }
}

function normalizedFrequencies(bytes) {
  const counts = new Uint32Array(256);
  for (const value of bytes) counts[value] += 1;
  const frequencies = new Uint16Array(256);
  if (bytes.length === 0) return frequencies;
  const entries = [];
  let sum = 0;
  for (let symbol = 0; symbol < 256; symbol += 1) {
    if (counts[symbol] === 0) continue;
    const ideal = counts[symbol] * RANS_TOTAL / bytes.length;
    const frequency = Math.max(1, Math.floor(ideal));
    frequencies[symbol] = frequency;
    entries.push({ symbol, fraction: ideal - Math.floor(ideal), count: counts[symbol] });
    sum += frequency;
  }
  if (sum < RANS_TOTAL) {
    entries.sort((a, b) => b.fraction - a.fraction || b.count - a.count || a.symbol - b.symbol);
    for (let index = 0; sum < RANS_TOTAL; index = (index + 1) % entries.length) {
      frequencies[entries[index].symbol] += 1;
      sum += 1;
    }
  } else if (sum > RANS_TOTAL) {
    entries.sort((a, b) => a.fraction - b.fraction || a.count - b.count || b.symbol - a.symbol);
    for (let index = 0; sum > RANS_TOTAL; index = (index + 1) % entries.length) {
      const symbol = entries[index].symbol;
      if (frequencies[symbol] > 1) {
        frequencies[symbol] -= 1;
        sum -= 1;
      }
    }
  }
  return frequencies;
}

// #WDD-gpt 2026-08-15 - 使用静态字节 rANS 取代浏览器不稳定的外部压缩依赖，格式可由纯 JS 确定性解码。
export function encodeRans(bytes) {
  const frequencies = normalizedFrequencies(bytes);
  const cumulative = new Uint16Array(256);
  let sum = 0;
  for (let symbol = 0; symbol < 256; symbol += 1) {
    cumulative[symbol] = sum;
    sum += frequencies[symbol];
  }
  // #WDD-gpt 2026-09-19 - rANS 反向输出可能达到数亿字节；分块 Buffer 避免每字节一个 JS number 导致 Worker old-space OOM。
  const emittedWriter = new ByteWriter();
  let state = RANS_LOW;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    const symbol = bytes[index];
    const frequency = frequencies[symbol];
    const maximum = Math.floor(RANS_LOW / RANS_TOTAL) * 256 * frequency;
    while (state >= maximum) {
      emittedWriter.byte(state & 0xff);
      state = Math.floor(state / 256);
    }
    state = Math.floor(state / frequency) * RANS_TOTAL + state % frequency + cumulative[symbol];
  }
  const emitted = emittedWriter.finish();
  emitted.reverse();
  const header = Buffer.alloc(20 + 256 * 2);
  header.write(RANS_MAGIC, 0, 'ascii');
  header.writeUInt32LE(bytes.length, 8);
  header.writeUInt32LE(emitted.length, 12);
  header.writeUInt32LE(state >>> 0, 16);
  for (let symbol = 0; symbol < 256; symbol += 1) header.writeUInt16LE(frequencies[symbol], 20 + symbol * 2);
  return Buffer.concat([header, emitted]);
}

export function decodeRans(encoded) {
  if (encoded.subarray(0, 8).toString('ascii') !== RANS_MAGIC) throw new Error('Invalid rANS byte stream.');
  const rawBytes = encoded.readUInt32LE(8);
  const emittedBytes = encoded.readUInt32LE(12);
  if (encoded.length !== 20 + 256 * 2 + emittedBytes) throw new Error('Invalid rANS byte count.');
  const frequencies = new Uint16Array(256);
  const cumulative = new Uint16Array(256);
  const lookup = new Uint8Array(RANS_TOTAL);
  let total = 0;
  for (let symbol = 0; symbol < 256; symbol += 1) {
    cumulative[symbol] = total;
    frequencies[symbol] = encoded.readUInt16LE(20 + symbol * 2);
    lookup.fill(symbol, total, total + frequencies[symbol]);
    total += frequencies[symbol];
  }
  if (rawBytes > 0 && total !== RANS_TOTAL) throw new Error(`Invalid rANS frequency total ${total}.`);
  const output = Buffer.allocUnsafe(rawBytes);
  let state = encoded.readUInt32LE(16);
  let source = 20 + 256 * 2;
  for (let index = 0; index < rawBytes; index += 1) {
    const slot = state & (RANS_TOTAL - 1);
    const symbol = lookup[slot];
    output[index] = symbol;
    state = frequencies[symbol] * Math.floor(state / RANS_TOTAL) + slot - cumulative[symbol];
    while (state < RANS_LOW && source < encoded.length) state = state * 256 + encoded[source++];
  }
  if (source !== encoded.length) throw new Error(`Unused rANS renormalization bytes: ${encoded.length - source}`);
  return output;
}

function entropyPair(magic, main, exceptions) {
  const encodedMain = encodeRans(main);
  const encodedExceptions = encodeRans(exceptions);
  const header = Buffer.alloc(16);
  header.write(magic, 0, 'ascii');
  header.writeUInt32LE(encodedMain.length, 8);
  header.writeUInt32LE(encodedExceptions.length, 12);
  return Buffer.concat([header, encodedMain, encodedExceptions]);
}

function decodeEntropyPair(bytes, magic) {
  if (bytes.subarray(0, 8).toString('ascii') !== magic) throw new Error(`Invalid ${magic} stream.`);
  const mainBytes = bytes.readUInt32LE(8);
  const exceptionBytes = bytes.readUInt32LE(12);
  if (16 + mainBytes + exceptionBytes !== bytes.length) throw new Error(`Invalid ${magic} stream length.`);
  return {
    main: decodeRans(bytes.subarray(16, 16 + mainBytes)),
    exceptions: decodeRans(bytes.subarray(16 + mainBytes)),
  };
}

function createTripleDictionary(radius) {
  const entries = [];
  for (let x = -radius; x <= radius; x += 1) {
    for (let y = -radius; y <= radius; y += 1) {
      for (let z = -radius; z <= radius; z += 1) entries.push([x, y, z]);
    }
  }
  entries.sort((a, b) => {
    const aL1 = Math.abs(a[0]) + Math.abs(a[1]) + Math.abs(a[2]);
    const bL1 = Math.abs(b[0]) + Math.abs(b[1]) + Math.abs(b[2]);
    const aMaximum = Math.max(Math.abs(a[0]), Math.abs(a[1]), Math.abs(a[2]));
    const bMaximum = Math.max(Math.abs(b[0]), Math.abs(b[1]), Math.abs(b[2]));
    return aL1 - bL1 || aMaximum - bMaximum || a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  });
  const side = radius * 2 + 1;
  const denseIndices = new Uint16Array(side * side * side);
  for (let index = 0; index < entries.length; index += 1) {
    const [x, y, z] = entries[index];
    denseIndices[(x + radius) * side * side + (y + radius) * side + z + radius] = index + 1;
  }
  return { entries, radius, side, denseIndices };
}

const tripleDictionary = createTripleDictionary(7);

function writeTriple(writer, x, y, z) {
  const radius = tripleDictionary.radius;
  if (x >= -radius && x <= radius && y >= -radius && y <= radius && z >= -radius && z <= radius) {
    const side = tripleDictionary.side;
    writer.uint(tripleDictionary.denseIndices[(x + radius) * side * side + (y + radius) * side + z + radius]);
  } else {
    writer.uint(0);
    writer.sint(x);
    writer.sint(y);
    writer.sint(z);
  }
}

function readTriple(reader) {
  const code = reader.uint();
  return code === 0
    ? [reader.sint(), reader.sint(), reader.sint()]
    : tripleDictionary.entries[code - 1];
}

function positionAt(segment, local, bank) {
  const stride = segment.propertyNames.length;
  const base = local * stride;
  return ['x', 'y', 'z'].map((component) => halfToFloat(segment.rows[base + segment.propertyIndex.get(`xyz_bank_${bank}_${component}`)]));
}

function spreadMorton10(value) {
  let result = value & 0x3ff;
  result = (result | (result << 16)) & 0x030000ff;
  result = (result | (result << 8)) & 0x0300f00f;
  result = (result | (result << 4)) & 0x030c30c3;
  return (result | (result << 2)) & 0x09249249;
}

function mortonCode(position, center, halfExtent) {
  const scale = 1023 / (halfExtent * 2);
  const x = Math.max(0, Math.min(1023, Math.round((position[0] - (center[0] - halfExtent)) * scale)));
  const y = Math.max(0, Math.min(1023, Math.round((position[1] - (center[1] - halfExtent)) * scale)));
  const z = Math.max(0, Math.min(1023, Math.round((position[2] - (center[2] - halfExtent)) * scale)));
  return spreadMorton10(x) | (spreadMorton10(y) << 1) | (spreadMorton10(z) << 2);
}

// #WDD-gpt 2026-09-19 - 千万级 Track 以稳定字节基数排序替代 JS comparator sort，限制临时内存并保持 code/birth/id 原有顺序。
function stableRadixSortOrder(order, passes) {
  let input = order;
  let output = new Int32Array(order.length);
  for (const { keyAt, byteCount } of passes) {
    for (let byte = 0; byte < byteCount; byte += 1) {
      const shift = byte * 8;
      const counts = new Uint32Array(256);
      for (let index = 0; index < input.length; index += 1) counts[(keyAt(input[index]) >>> shift) & 0xff] += 1;
      let offset = 0;
      for (let value = 0; value < counts.length; value += 1) {
        const count = counts[value];
        counts[value] = offset;
        offset += count;
      }
      for (let index = 0; index < input.length; index += 1) {
        const item = input[index];
        output[counts[(keyAt(item) >>> shift) & 0xff]++] = item;
      }
      [input, output] = [output, input];
    }
  }
  if (input !== order) order.set(input);
}

function insideCube(position, center, halfExtent) {
  return position.every((value, axis) => Math.abs(value - center[axis]) <= halfExtent);
}

// #WDD-gpt 2026-08-15 - 只保留所有位置关键帧均在中心立方体内的轨迹，并按首次出现位置的 Morton 码生成永久 Track ID。
export function buildCroppedMortonLayout(segments, permanent, center, halfExtent, options = {}) {
  const kept = new Uint8Array(permanent.slotCount);
  kept.fill(1);
  const codes = new Uint32Array(permanent.slotCount);
  const birthSegments = new Int16Array(permanent.slotCount);
  birthSegments.fill(-1);
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    let positionBanks = 0;
    while (segment.propertyIndex.has(`xyz_bank_${positionBanks}_x`)) positionBanks += 1;
    for (let local = 0; local < segment.count; local += 1) {
      const oldTrack = permanent.maps[segmentIndex][local];
      if (birthSegments[oldTrack] < 0) {
        // #WDD-gpt 2026-09-19 - 首次出现时直接保存 Morton 码，避免为千万级 Track 保留海量 JS 三元数组。
        codes[oldTrack] = mortonCode(positionAt(segment, local, 0), center, halfExtent);
        birthSegments[oldTrack] = segmentIndex;
      }
      if (!options.positionsAlreadyInside) {
        for (let bank = 0; bank < positionBanks; bank += 1) {
          if (!insideCube(positionAt(segment, local, bank), center, halfExtent)) kept[oldTrack] = 0;
        }
      }
    }
  }
  const keptCount = options.positionsAlreadyInside
    ? permanent.slotCount
    : kept.reduce((sum, value) => sum + value, 0);
  // #WDD-gpt 2026-09-19 - 浏览器大序列使用定长 TypedArray 排序，避免 2,000 万项 JS number[] 的对象/堆开销。
  const order = options.sparseInverse ? new Int32Array(keptCount) : [];
  let orderLength = 0;
  for (let oldTrack = 0; oldTrack < permanent.slotCount; oldTrack += 1) {
    if (kept[oldTrack]) order[orderLength++] = oldTrack;
  }
  if (options.sparseInverse) {
    stableRadixSortOrder(order, [
      { keyAt: (track) => birthSegments[track], byteCount: 2 },
      { keyAt: (track) => codes[track], byteCount: 4 },
    ]);
  } else {
    order.sort((a, b) => codes[a] - codes[b] || birthSegments[a] - birthSegments[b] || a - b);
  }
  const oldToNew = new Int32Array(permanent.slotCount);
  oldToNew.fill(-1);
  order.forEach((oldTrack, newTrack) => { oldToNew[oldTrack] = newTrack; });
  if (options.sparseInverse) {
    const shared = options.sharedArrays && typeof SharedArrayBuffer !== 'undefined';
    const allocateInt32 = (length) => new Int32Array(shared
      ? new SharedArrayBuffer(length * Int32Array.BYTES_PER_ELEMENT)
      : new ArrayBuffer(length * Int32Array.BYTES_PER_ELEMENT));
    const activeLocals = permanent.maps.map((map) => {
      let activeCount = 0;
      for (let local = 0; local < map.length; local += 1) {
        if (oldToNew[map[local]] >= 0) activeCount += 1;
      }
      const locals = allocateInt32(activeCount);
      let destination = 0;
      for (let local = 0; local < map.length; local += 1) {
        if (oldToNew[map[local]] >= 0) locals[destination++] = local;
      }
      stableRadixSortOrder(locals, [
        { keyAt: (local) => oldToNew[map[local]], byteCount: 4 },
      ]);
      return locals;
    });
    const activeSlots = activeLocals.map((locals, segmentIndex) => {
      const slots = allocateInt32(locals.length);
      const map = permanent.maps[segmentIndex];
      for (let row = 0; row < locals.length; row += 1) slots[row] = oldToNew[map[locals[row]]];
      return slots;
    });
    // #WDD-gpt 2026-09-19 - 稀疏布局按 activeSlots 同序保存 local，仅占 O(总点数)，不再分配 segmentCount × slotCount 反表。
    const retainRemap = options.retainRemap !== false;
    return {
      slotCount: order.length,
      trackCount: order.length,
      sourcePermanentTrackCount: permanent.slotCount,
      droppedTrackCount: permanent.slotCount - order.length,
      maps: [],
      slotToLocal: [],
      activeSlots,
      activeLocals,
      order: retainRemap ? order : new Int32Array(0),
      oldToNew: retainRemap ? oldToNew : new Int32Array(0),
      continuedLocal: retainRemap ? permanent.continuedLocal : [],
      matches: permanent.matches,
    };
  }
  const maps = permanent.maps.map((map) => {
    const result = new Int32Array(map.length);
    result.fill(-1);
    for (let local = 0; local < map.length; local += 1) result[local] = oldToNew[map[local]];
    return result;
  });
  const slotToLocal = maps.map((map) => {
    const inverse = new Int32Array(order.length);
    inverse.fill(-1);
    for (let local = 0; local < map.length; local += 1) {
      if (map[local] >= 0) inverse[map[local]] = local;
    }
    return inverse;
  });
  const activeSlots = slotToLocal.map((inverse) => Int32Array.from(inverse.keys()).filter((slot) => inverse[slot] >= 0));
  return {
    slotCount: order.length,
    trackCount: order.length,
    sourcePermanentTrackCount: permanent.slotCount,
    droppedTrackCount: permanent.slotCount - order.length,
    maps,
    slotToLocal,
    activeSlots,
    activeLocals: [],
    order,
    oldToNew,
    continuedLocal: permanent.continuedLocal,
    matches: permanent.matches,
  };
}

function propertyIndexSets(segments, prefix, components, bankCounts) {
  return segments.map((segment, segmentIndex) => Array.from(
    { length: bankCounts[segmentIndex] },
    (_, bank) => components.map((component) => segment.propertyIndex.get(`${prefix}_${bank}_${component}`)),
  ));
}

function exceptionRecords(bytes) {
  const reader = new ByteReader(bytes);
  const count = reader.uint();
  const result = new Map();
  let ordinal = 0;
  for (let index = 0; index < count; index += 1) {
    ordinal += reader.uint();
    const componentCount = reader.byte();
    const values = Array.from({ length: componentCount }, () => reader.ushort());
    result.set(ordinal, values);
  }
  reader.done();
  return result;
}

class ExceptionWriter {
  constructor() {
    this.body = new ByteWriter();
    this.count = 0;
    this.previousOrdinal = 0;
  }

  add(ordinal, bits) {
    this.body.uint(ordinal - this.previousOrdinal);
    this.body.byte(bits.length);
    for (const value of bits) this.body.ushort(value);
    this.previousOrdinal = ordinal;
    this.count += 1;
  }

  finish() {
    const header = new ByteWriter();
    header.uint(this.count);
    return Buffer.concat([header.finish(), this.body.finish()]);
  }
}

function quantizedPosition(position, origin, step) {
  return position.map((value, axis) => Math.round((value - origin[axis]) / step));
}

function decodedPosition(quantized, origin, step) {
  return quantized.map((value, axis) => halfToFloat(floatToHalf(origin[axis] + value * step)));
}

// #WDD-gpt 2026-08-16 - 暴露 Position 原始上下文，浏览器封装可跳过随后立即被解开的临时 rANS 层。
export function encodePositionRaw(segments, layout, bankCounts, options) {
  const { center, halfExtent, step, maximumError, cellSize } = options;
  const origin = center.map((value) => value - halfExtent);
  const cellQuant = Math.max(1, Math.round(cellSize / step));
  const indices = propertyIndexSets(segments, 'xyz_bank', ['x', 'y', 'z'], bankCounts);
  const main = new ByteWriter();
  const stateX = new Int32Array(layout.slotCount);
  const stateY = new Int32Array(layout.slotCount);
  const stateZ = new Int32Array(layout.slotCount);
  const initialized = new Uint8Array(layout.slotCount);
  // #WDD-gpt 2026-09-19 - Position 修正直接写分块字节流，避免高修正率时保留数百万对象与 bits 数组。
  const exceptions = new ExceptionWriter();
  let ordinal = 0;
  let squaredError = 0;
  let maximumObservedError = 0;
  let valueCount = 0;
  main.uint(bankCounts.reduce((sum, count) => sum + count, 0));
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const active = layout.activeSlots[segmentIndex];
    const activeLocals = layout.activeLocals?.[segmentIndex];
    const inverse = activeLocals ? null : layout.slotToLocal[segmentIndex];
    const stride = segment.propertyNames.length;
    for (let bank = 0; bank < bankCounts[segmentIndex]; bank += 1) {
      const current = new Int32Array(active.length * 3);
      let globalCount = 0;
      let globalSumX = 0;
      let globalSumY = 0;
      let globalSumZ = 0;
      const [indexX, indexY, indexZ] = indices[segmentIndex][bank];
      for (let row = 0; row < active.length; row += 1) {
        const slot = active[row];
        const local = activeLocals ? activeLocals[row] : inverse[slot];
        const sourceBase = local * stride;
        const sourceBitsX = segment.rows[sourceBase + indexX];
        const sourceBitsY = segment.rows[sourceBase + indexY];
        const sourceBitsZ = segment.rows[sourceBase + indexZ];
        const sourceX = halfToFloat(sourceBitsX);
        const sourceY = halfToFloat(sourceBitsY);
        const sourceZ = halfToFloat(sourceBitsZ);
        const quantizedX = Math.round((sourceX - origin[0]) / step);
        const quantizedY = Math.round((sourceY - origin[1]) / step);
        const quantizedZ = Math.round((sourceZ - origin[2]) / step);
        const offset = row * 3;
        current[offset] = quantizedX;
        current[offset + 1] = quantizedY;
        current[offset + 2] = quantizedZ;
        if (initialized[slot]) {
          globalSumX += quantizedX - stateX[slot];
          globalSumY += quantizedY - stateY[slot];
          globalSumZ += quantizedZ - stateZ[slot];
          globalCount += 1;
        }
        const decodedX = halfToFloat(floatToHalf(origin[0] + quantizedX * step));
        const decodedY = halfToFloat(floatToHalf(origin[1] + quantizedY * step));
        const decodedZ = halfToFloat(floatToHalf(origin[2] + quantizedZ * step));
        const error = Math.hypot(decodedX - sourceX, decodedY - sourceY, decodedZ - sourceZ);
        squaredError += error * error;
        maximumObservedError = Math.max(maximumObservedError, error);
        if (!Number.isFinite(error) || error > maximumError) {
          exceptions.add(ordinal + row, [sourceBitsX, sourceBitsY, sourceBitsZ]);
        }
      }
      const globalX = globalCount ? Math.round(globalSumX / globalCount) : 0;
      const globalY = globalCount ? Math.round(globalSumY / globalCount) : 0;
      const globalZ = globalCount ? Math.round(globalSumZ / globalCount) : 0;
      const cells = new Map();
      for (let row = 0; row < active.length; row += 1) {
        const slot = active[row];
        if (!initialized[slot]) continue;
        const cx = Math.floor(stateX[slot] / cellQuant);
        const cy = Math.floor(stateY[slot] / cellQuant);
        const cz = Math.floor(stateZ[slot] / cellQuant);
        const key = cx + cy * 32 + cz * 1024;
        let cell = cells.get(key);
        if (!cell) {
          cell = [0, 0, 0, 0];
          cells.set(key, cell);
        }
        const offset = row * 3;
        cell[0] += current[offset] - stateX[slot] - globalX;
        cell[1] += current[offset + 1] - stateY[slot] - globalY;
        cell[2] += current[offset + 2] - stateZ[slot] - globalZ;
        cell[3] += 1;
      }
      const cellMotions = new Map();
      for (const [key, cell] of cells) cellMotions.set(key, cell.slice(0, 3).map((sum) => Math.round(sum / cell[3])));
      main.sint(globalX);
      main.sint(globalY);
      main.sint(globalZ);
      const cellEntries = [...cellMotions].sort((a, b) => a[0] - b[0]);
      main.uint(cellEntries.length);
      let previousKey = 0;
      for (const [key, motion] of cellEntries) {
        main.uint(key - previousKey);
        writeTriple(main, motion[0], motion[1], motion[2]);
        previousKey = key;
      }
      let birthX = 0;
      let birthY = 0;
      let birthZ = 0;
      let hasBirth = false;
      for (let row = 0; row < active.length; row += 1) {
        const slot = active[row];
        const offset = row * 3;
        const quantizedX = current[offset];
        const quantizedY = current[offset + 1];
        const quantizedZ = current[offset + 2];
        let residualX;
        let residualY;
        let residualZ;
        if (initialized[slot]) {
          const key = Math.floor(stateX[slot] / cellQuant)
            + Math.floor(stateY[slot] / cellQuant) * 32
            + Math.floor(stateZ[slot] / cellQuant) * 1024;
          const cell = cellMotions.get(key) ?? [0, 0, 0];
          residualX = quantizedX - stateX[slot] - globalX - cell[0];
          residualY = quantizedY - stateY[slot] - globalY - cell[1];
          residualZ = quantizedZ - stateZ[slot] - globalZ - cell[2];
        } else {
          residualX = quantizedX - (hasBirth ? birthX : 0);
          residualY = quantizedY - (hasBirth ? birthY : 0);
          residualZ = quantizedZ - (hasBirth ? birthZ : 0);
          birthX = quantizedX;
          birthY = quantizedY;
          birthZ = quantizedZ;
          hasBirth = true;
        }
        writeTriple(main, residualX, residualY, residualZ);
        stateX[slot] = quantizedX;
        stateY[slot] = quantizedY;
        stateZ[slot] = quantizedZ;
        initialized[slot] = 1;
      }
      ordinal += active.length;
      valueCount += active.length * 3;
    }
  }
  const mainRaw = main.finish();
  const exceptionRaw = exceptions.finish();
  return {
    mainRaw,
    exceptionRaw,
    metrics: {
      observationCount: ordinal,
      valueCount,
      step,
      hardMaximumEuclideanError: maximumError,
      measuredRmse: Math.sqrt(squaredError / ordinal),
      measuredMaximumEuclideanError: maximumObservedError,
      exceptionCount: exceptions.count,
      mainRawBytes: mainRaw.length,
      exceptionRawBytes: exceptionRaw.length,
      cellSize,
      temporalTransform: 'reversible integer first-order lifting delta',
      residualDictionary: 'exact 3D radius-7 dictionary with signed-varint escape',
      entropyCodec: 'static byte rANS-12',
    },
  };
}

// #WDD-gpt 2026-08-16 - 保留旧 P3DPR001 API 供 CLI、回归测试和兼容链路使用；生产浏览器改走原始上下文入口。
export function encodePositions(segments, layout, bankCounts, options) {
  const raw = encodePositionRaw(segments, layout, bankCounts, options);
  const encoded = entropyPair('P3DPR001', raw.mainRaw, raw.exceptionRaw);
  return { encoded, metrics: { ...raw.metrics, encodedBytes: encoded.length } };
}

export function decodePositions(encoded, manifest, activeSlots, rows, indices) {
  const { main: mainBytes, exceptions: exceptionBytes } = decodeEntropyPair(encoded, 'P3DPR001');
  const reader = new ByteReader(mainBytes);
  const exceptionMap = exceptionRecords(exceptionBytes);
  const { center, halfExtent, step, cellSize } = manifest.prs.position;
  const origin = center.map((value) => value - halfExtent);
  const cellQuant = Math.max(1, Math.round(cellSize / step));
  const state = [new Int32Array(manifest.slotCount), new Int32Array(manifest.slotCount), new Int32Array(manifest.slotCount)];
  const initialized = new Uint8Array(manifest.slotCount);
  const layerCount = reader.uint();
  let decodedLayers = 0;
  let ordinal = 0;
  for (let segmentIndex = 0; segmentIndex < manifest.segments.length; segmentIndex += 1) {
    const active = activeSlots[segmentIndex];
    const rowValues = rows[segmentIndex];
    const stride = indices[segmentIndex].size;
    for (let bank = 0; bank < manifest.segments[segmentIndex].bankCounts.position; bank += 1) {
      const global = [reader.sint(), reader.sint(), reader.sint()];
      const cellCount = reader.uint();
      const cells = new Map();
      let key = 0;
      for (let index = 0; index < cellCount; index += 1) {
        key += reader.uint();
        cells.set(key, readTriple(reader));
      }
      let birth = [0, 0, 0];
      let hasBirth = false;
      for (let row = 0; row < active.length; row += 1) {
        const slot = active[row];
        const residual = readTriple(reader);
        let quantized;
        if (initialized[slot]) {
          const cellKey = Math.floor(state[0][slot] / cellQuant)
            + Math.floor(state[1][slot] / cellQuant) * 32
            + Math.floor(state[2][slot] / cellQuant) * 1024;
          const cell = cells.get(cellKey) ?? [0, 0, 0];
          quantized = residual.map((value, axis) => state[axis][slot] + global[axis] + cell[axis] + value);
        } else {
          quantized = residual.map((value, axis) => (hasBirth ? birth[axis] : 0) + value);
          birth = quantized;
          hasBirth = true;
        }
        const exception = exceptionMap.get(ordinal);
        for (let axis = 0; axis < 3; axis += 1) {
          state[axis][slot] = quantized[axis];
          const name = `xyz_bank_${bank}_${['x', 'y', 'z'][axis]}`;
          rowValues[row * stride + indices[segmentIndex].get(name)] = exception?.[axis]
            ?? floatToHalf(origin[axis] + quantized[axis] * step);
        }
        initialized[slot] = 1;
        ordinal += 1;
      }
      decodedLayers += 1;
    }
  }
  if (decodedLayers !== layerCount) throw new Error(`Position layer mismatch ${decodedLayers} != ${layerCount}`);
  reader.done();
  return { observationCount: ordinal, appliedExceptions: exceptionMap.size };
}

// #WDD-gpt 2026-08-16 - V2.4 直接并行读取 Position 元数据、字典码和 XYZ escape 流，消除旧 P3D/rANS 中间格式。
export function decodePositionContextStreams(contexts, manifest, activeSlots, rows, indices) {
  const metadata = new ByteReader(contexts.get('metadata'));
  const dictionaryCodes = new ByteReader(contexts.get('dictionary_codes'));
  const escape = [0, 1, 2].map((axis) => new ByteReader(contexts.get(`escape_${axis}`)));
  const exceptionMap = exceptionRecords(contexts.get('exceptions'));
  const { center, halfExtent, step, cellSize } = manifest.prs.position;
  const origin = center.map((value) => value - halfExtent);
  const cellQuant = Math.max(1, Math.round(cellSize / step));
  // #WDD-gpt 2026-09-20 - 常见量化坐标预建逐位相同的 FP16 查表，范围外仍走原转换，限制额外内存。
  const lookupCount = Math.min(262144, Math.max(0, Math.ceil(halfExtent * 2 / step) + 2));
  const halfLookup = origin.map(value => Uint16Array.from({ length: lookupCount }, (_, q) => floatToHalf(value + q * step)));
  const stateX = new Int32Array(manifest.slotCount);
  const stateY = new Int32Array(manifest.slotCount);
  const stateZ = new Int32Array(manifest.slotCount);
  const initialized = new Uint8Array(manifest.slotCount);
  const layerCount = metadata.uint();
  const hasExceptions = exceptionMap.size > 0;
  let decodedLayers = 0;
  let ordinal = 0;
  // #WDD-gpt 2026-08-16 - Position 热循环消除逐点 Array/map、模板字符串和属性 Map 查询，保持相同整数状态与 FP16 写出顺序。
  for (let segmentIndex = 0; segmentIndex < manifest.segments.length; segmentIndex += 1) {
    const active = activeSlots[segmentIndex];
    const rowValues = rows[segmentIndex];
    const stride = indices[segmentIndex].size;
    for (let bank = 0; bank < manifest.segments[segmentIndex].bankCounts.position; bank += 1) {
      const propertyX = indices[segmentIndex].get(`xyz_bank_${bank}_x`);
      const propertyY = indices[segmentIndex].get(`xyz_bank_${bank}_y`);
      const propertyZ = indices[segmentIndex].get(`xyz_bank_${bank}_z`);
      if (propertyX === undefined || propertyY === undefined || propertyZ === undefined) {
        throw new Error(`Position property layout missing for segment ${segmentIndex}, bank ${bank}.`);
      }
      const globalX = metadata.sint();
      const globalY = metadata.sint();
      const globalZ = metadata.sint();
      const cellCount = metadata.uint();
      const cells = new Map();
      let key = 0;
      for (let index = 0; index < cellCount; index += 1) {
        key += metadata.uint();
        cells.set(key, readTriple(metadata));
      }
      // 稀疏元数据转成有界稠密查表；超范围 key 仍保留 Map 路径。
      const denseCells = key >= 0 && key < 262144 ? new Float64Array((key + 1) * 3) : null;
      if (denseCells) for (const [cellKey, cell] of cells) {
        if (cellKey >= 0 && cellKey <= key) { denseCells[cellKey * 3] = cell[0]; denseCells[cellKey * 3 + 1] = cell[1]; denseCells[cellKey * 3 + 2] = cell[2]; }
      }
      let birthX = 0;
      let birthY = 0;
      let birthZ = 0;
      let hasBirth = false;
      for (let row = 0; row < active.length; row += 1) {
        const slot = active[row];
        const code = dictionaryCodes.uint();
        let residualX;
        let residualY;
        let residualZ;
        if (code === 0) {
          residualX = escape[0].sint();
          residualY = escape[1].sint();
          residualZ = escape[2].sint();
        } else {
          const residual = tripleDictionary.entries[code - 1];
          residualX = residual[0];
          residualY = residual[1];
          residualZ = residual[2];
        }
        let quantizedX;
        let quantizedY;
        let quantizedZ;
        if (initialized[slot]) {
          const cellKey = Math.floor(stateX[slot] / cellQuant)
            + Math.floor(stateY[slot] / cellQuant) * 32
            + Math.floor(stateZ[slot] / cellQuant) * 1024;
          if (denseCells && cellKey >= 0 && cellKey * 3 < denseCells.length) {
            quantizedX = stateX[slot] + globalX + denseCells[cellKey * 3] + residualX;
            quantizedY = stateY[slot] + globalY + denseCells[cellKey * 3 + 1] + residualY;
            quantizedZ = stateZ[slot] + globalZ + denseCells[cellKey * 3 + 2] + residualZ;
          } else {
            const cell = cells.get(cellKey);
            quantizedX = stateX[slot] + globalX + (cell?.[0] ?? 0) + residualX;
            quantizedY = stateY[slot] + globalY + (cell?.[1] ?? 0) + residualY;
            quantizedZ = stateZ[slot] + globalZ + (cell?.[2] ?? 0) + residualZ;
          }
        } else {
          quantizedX = (hasBirth ? birthX : 0) + residualX;
          quantizedY = (hasBirth ? birthY : 0) + residualY;
          quantizedZ = (hasBirth ? birthZ : 0) + residualZ;
          birthX = quantizedX;
          birthY = quantizedY;
          birthZ = quantizedZ;
          hasBirth = true;
        }
        const exception = hasExceptions ? exceptionMap.get(ordinal) : undefined;
        stateX[slot] = quantizedX;
        stateY[slot] = quantizedY;
        stateZ[slot] = quantizedZ;
        const output = row * stride;
        rowValues[output + propertyX] = exception?.[0] ?? (quantizedX >= 0 && quantizedX < lookupCount ? halfLookup[0][quantizedX] : floatToHalf(origin[0] + quantizedX * step));
        rowValues[output + propertyY] = exception?.[1] ?? (quantizedY >= 0 && quantizedY < lookupCount ? halfLookup[1][quantizedY] : floatToHalf(origin[1] + quantizedY * step));
        rowValues[output + propertyZ] = exception?.[2] ?? (quantizedZ >= 0 && quantizedZ < lookupCount ? halfLookup[2][quantizedZ] : floatToHalf(origin[2] + quantizedZ * step));
        initialized[slot] = 1;
        ordinal += 1;
      }
      decodedLayers += 1;
    }
  }
  if (decodedLayers !== layerCount) throw new Error(`Direct Position layer mismatch ${decodedLayers} != ${layerCount}`);
  metadata.done();
  dictionaryCodes.done();
  for (const reader of escape) reader.done();
  return { observationCount: ordinal, appliedExceptions: exceptionMap.size };
}

function normalizedQuaternion(values) {
  const length = Math.hypot(...values);
  return length > 0 && Number.isFinite(length) ? values.map((value) => value / length) : [1, 0, 0, 0];
}

function quantizeQuaternion(values, bits) {
  const normalized = normalizedQuaternion(values);
  let largest = 0;
  for (let index = 1; index < 4; index += 1) {
    if (Math.abs(normalized[index]) > Math.abs(normalized[largest])) largest = index;
  }
  const sign = normalized[largest] < 0 ? -1 : 1;
  const maximum = (1 << bits) - 1;
  const range = Math.SQRT1_2;
  const codes = [];
  for (let index = 0; index < 4; index += 1) {
    if (index === largest) continue;
    codes.push(Math.max(0, Math.min(maximum, Math.round(((normalized[index] * sign + range) / (2 * range)) * maximum))));
  }
  return { largest, codes };
}

function decodeQuaternion(largest, codes, bits) {
  const maximum = (1 << bits) - 1;
  const range = Math.SQRT1_2;
  const values = [];
  let source = 0;
  let square = 0;
  for (let index = 0; index < 4; index += 1) {
    if (index === largest) {
      values.push(0);
    } else {
      const value = codes[source++] / maximum * (2 * range) - range;
      values.push(value);
      square += value * value;
    }
  }
  values[largest] = Math.sqrt(Math.max(0, 1 - square));
  return normalizedQuaternion(values);
}

function quaternionAngleDegrees(a, b) {
  const normalizedA = normalizedQuaternion(a);
  const normalizedB = normalizedQuaternion(b);
  const dot = Math.min(1, Math.abs(normalizedA.reduce((sum, value, index) => sum + value * normalizedB[index], 0)));
  return 2 * Math.acos(dot) * 180 / Math.PI;
}

// #WDD-gpt 2026-08-15 - Rotation 使用 12-bit smallest-three、永久轨迹整数时差和超角误差 FP16 例外修复。
export function encodeRotations(segments, layout, bankCounts, options) {
  const bits = options.bits;
  const indices = propertyIndexSets(segments, 'rot_bank', ['w', 'x', 'y', 'z'], bankCounts);
  const candidateRadius = 63;
  const candidateSpan = candidateRadius * 2 + 1;
  const candidateCounts = new Map();
  let largestState = new Uint8Array(layout.slotCount);
  let codeState = [new Uint16Array(layout.slotCount), new Uint16Array(layout.slotCount), new Uint16Array(layout.slotCount)];
  let initialized = new Uint8Array(layout.slotCount);
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const active = layout.activeSlots[segmentIndex];
    const activeLocals = layout.activeLocals?.[segmentIndex];
    const inverse = activeLocals ? null : layout.slotToLocal[segmentIndex];
    const stride = segment.propertyNames.length;
    for (let bank = 0; bank < bankCounts[segmentIndex]; bank += 1) {
      for (let row = 0; row < active.length; row += 1) {
        const slot = active[row];
        const local = activeLocals ? activeLocals[row] : inverse[slot];
        const base = local * stride;
        const source = indices[segmentIndex][bank].map((index) => halfToFloat(segment.rows[base + index]));
        const quantized = quantizeQuaternion(source, bits);
        const delta = initialized[slot] && largestState[slot] === quantized.largest;
        const residual = quantized.codes.map((value, axis) => delta ? value - codeState[axis][slot] : value);
        if (residual.every((value) => Math.abs(value) <= candidateRadius)) {
          const key = (residual[0] + candidateRadius) * candidateSpan * candidateSpan
            + (residual[1] + candidateRadius) * candidateSpan
            + residual[2] + candidateRadius;
          candidateCounts.set(key, (candidateCounts.get(key) ?? 0) + 1);
        }
        largestState[slot] = quantized.largest;
        for (let axis = 0; axis < 3; axis += 1) codeState[axis][slot] = quantized.codes[axis];
        initialized[slot] = 1;
      }
    }
  }
  const dictionary = [...candidateCounts]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 255)
    .map(([key]) => {
      const x = Math.floor(key / (candidateSpan * candidateSpan)) - candidateRadius;
      const remainder = key % (candidateSpan * candidateSpan);
      const y = Math.floor(remainder / candidateSpan) - candidateRadius;
      const z = remainder % candidateSpan - candidateRadius;
      return [x, y, z];
    });
  const dictionaryIndices = new Map(dictionary.map((value, index) => [value.join(','), index + 1]));
  const main = new ByteWriter();
  largestState = new Uint8Array(layout.slotCount);
  codeState = [new Uint16Array(layout.slotCount), new Uint16Array(layout.slotCount), new Uint16Array(layout.slotCount)];
  initialized = new Uint8Array(layout.slotCount);
  const exceptions = new ExceptionWriter();
  let ordinal = 0;
  let squaredAngle = 0;
  let maximumAngle = 0;
  main.uint(bankCounts.reduce((sum, count) => sum + count, 0));
  main.uint(dictionary.length);
  for (const value of dictionary) {
    main.sint(value[0]);
    main.sint(value[1]);
    main.sint(value[2]);
  }
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const active = layout.activeSlots[segmentIndex];
    const activeLocals = layout.activeLocals?.[segmentIndex];
    const inverse = activeLocals ? null : layout.slotToLocal[segmentIndex];
    const stride = segment.propertyNames.length;
    for (let bank = 0; bank < bankCounts[segmentIndex]; bank += 1) {
      for (let row = 0; row < active.length; row += 1) {
        const slot = active[row];
        const local = activeLocals ? activeLocals[row] : inverse[slot];
        const base = local * stride;
        const source = indices[segmentIndex][bank].map((index) => halfToFloat(segment.rows[base + index]));
        const quantized = quantizeQuaternion(source, bits);
        const delta = initialized[slot] && largestState[slot] === quantized.largest;
        main.byte(quantized.largest | (delta ? 0 : 4));
        const residual = quantized.codes.map((value, axis) => delta ? value - codeState[axis][slot] : value);
        const dictionaryIndex = dictionaryIndices.get(residual.join(',')) ?? 0;
        main.byte(dictionaryIndex);
        if (dictionaryIndex === 0) {
          main.sint(residual[0]);
          main.sint(residual[1]);
          main.sint(residual[2]);
        }
        const decoded = decodeQuaternion(quantized.largest, quantized.codes, bits).map((value) => halfToFloat(floatToHalf(value)));
        const angle = quaternionAngleDegrees(source, decoded);
        squaredAngle += angle * angle;
        maximumAngle = Math.max(maximumAngle, angle);
        if (!Number.isFinite(angle) || angle > options.maximumAngleDegrees) {
          exceptions.add(ordinal, indices[segmentIndex][bank].map((index) => segment.rows[base + index]));
        }
        largestState[slot] = quantized.largest;
        for (let axis = 0; axis < 3; axis += 1) codeState[axis][slot] = quantized.codes[axis];
        initialized[slot] = 1;
        ordinal += 1;
      }
    }
  }
  const mainRaw = main.finish();
  const exceptionRaw = exceptions.finish();
  const encoded = entropyPair('Q3DPR001', mainRaw, exceptionRaw);
  return {
    encoded,
    metrics: {
      observationCount: ordinal,
      bits,
      hardMaximumAngleDegrees: options.maximumAngleDegrees,
      measuredAngularRmseDegrees: Math.sqrt(squaredAngle / ordinal),
      measuredMaximumAngleDegrees: maximumAngle,
      exceptionCount: exceptions.count,
      learnedResidualDictionaryEntries: dictionary.length,
      mainRawBytes: mainRaw.length,
      exceptionRawBytes: exceptionRaw.length,
      encodedBytes: encoded.length,
      representation: 'smallest-three canonical quaternion',
      temporalTransform: 'reversible integer first-order delta when dominant component is stable',
      entropyCodec: 'static byte rANS-12',
    },
  };
}

export function decodeRotations(encoded, manifest, activeSlots, rows, indices) {
  const { main: mainBytes, exceptions: exceptionBytes } = decodeEntropyPair(encoded, 'Q3DPR001');
  const reader = new ByteReader(mainBytes);
  const exceptionMap = exceptionRecords(exceptionBytes);
  const bits = manifest.prs.rotation.bits;
  const largestState = new Uint8Array(manifest.slotCount);
  const codeState = [new Uint16Array(manifest.slotCount), new Uint16Array(manifest.slotCount), new Uint16Array(manifest.slotCount)];
  const initialized = new Uint8Array(manifest.slotCount);
  const layerCount = reader.uint();
  const dictionaryCount = reader.uint();
  const dictionary = Array.from({ length: dictionaryCount }, () => [reader.sint(), reader.sint(), reader.sint()]);
  let decodedLayers = 0;
  let ordinal = 0;
  for (let segmentIndex = 0; segmentIndex < manifest.segments.length; segmentIndex += 1) {
    const active = activeSlots[segmentIndex];
    const rowValues = rows[segmentIndex];
    const stride = indices[segmentIndex].size;
    for (let bank = 0; bank < manifest.segments[segmentIndex].bankCounts.rotation; bank += 1) {
      for (let row = 0; row < active.length; row += 1) {
        const slot = active[row];
        const control = reader.byte();
        const largest = control & 3;
        const delta = (control & 4) === 0;
        const dictionaryIndex = reader.byte();
        const residual = dictionaryIndex === 0
          ? [reader.sint(), reader.sint(), reader.sint()]
          : dictionary[dictionaryIndex - 1];
        if (delta && (!initialized[slot] || largestState[slot] !== largest)) throw new Error('Invalid quaternion delta state.');
        const codes = residual.map((value, axis) => delta ? codeState[axis][slot] + value : value);
        const quaternion = decodeQuaternion(largest, codes, bits);
        const exception = exceptionMap.get(ordinal);
        for (let axis = 0; axis < 4; axis += 1) {
          const name = `rot_bank_${bank}_${['w', 'x', 'y', 'z'][axis]}`;
          rowValues[row * stride + indices[segmentIndex].get(name)] = exception?.[axis] ?? floatToHalf(quaternion[axis]);
        }
        largestState[slot] = largest;
        for (let axis = 0; axis < 3; axis += 1) codeState[axis][slot] = codes[axis];
        initialized[slot] = 1;
        ordinal += 1;
      }
      decodedLayers += 1;
    }
  }
  if (decodedLayers !== layerCount) throw new Error(`Rotation layer mismatch ${decodedLayers} != ${layerCount}`);
  reader.done();
  return { observationCount: ordinal, appliedExceptions: exceptionMap.size };
}

// #WDD-gpt 2026-08-15 - Scale 在 log 域量化后做 Morton 邻域 birth 预测与永久轨迹可逆整数时差，并用例外守住误差门限。
export function encodeScales(segments, layout, bankCounts, options) {
  const indices = propertyIndexSets(segments, 'scale_bank', ['0', '1', '2'], bankCounts);
  const candidateRadius = 31;
  const candidateSpan = candidateRadius * 2 + 1;
  const candidateCounts = new Map();
  let state = [new Int32Array(layout.slotCount), new Int32Array(layout.slotCount), new Int32Array(layout.slotCount)];
  let initialized = new Uint8Array(layout.slotCount);
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const active = layout.activeSlots[segmentIndex];
    const activeLocals = layout.activeLocals?.[segmentIndex];
    const inverse = activeLocals ? null : layout.slotToLocal[segmentIndex];
    const stride = segment.propertyNames.length;
    for (let bank = 0; bank < bankCounts[segmentIndex]; bank += 1) {
      let birth = [0, 0, 0];
      let hasBirth = false;
      for (let row = 0; row < active.length; row += 1) {
        const slot = active[row];
        const local = activeLocals ? activeLocals[row] : inverse[slot];
        const base = local * stride;
        const quantized = indices[segmentIndex][bank].map((index) => Math.round(halfToFloat(segment.rows[base + index]) / options.step));
        const residual = quantized.map((value, axis) => value - (initialized[slot] ? state[axis][slot] : hasBirth ? birth[axis] : 0));
        if (residual.every((value) => Math.abs(value) <= candidateRadius)) {
          const key = (residual[0] + candidateRadius) * candidateSpan * candidateSpan
            + (residual[1] + candidateRadius) * candidateSpan
            + residual[2] + candidateRadius;
          candidateCounts.set(key, (candidateCounts.get(key) ?? 0) + 1);
        }
        if (!initialized[slot]) {
          birth = quantized;
          hasBirth = true;
        }
        for (let axis = 0; axis < 3; axis += 1) state[axis][slot] = quantized[axis];
        initialized[slot] = 1;
      }
    }
  }
  const dictionary = [...candidateCounts]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 255)
    .map(([key]) => {
      const x = Math.floor(key / (candidateSpan * candidateSpan)) - candidateRadius;
      const remainder = key % (candidateSpan * candidateSpan);
      const y = Math.floor(remainder / candidateSpan) - candidateRadius;
      const z = remainder % candidateSpan - candidateRadius;
      return [x, y, z];
    });
  const dictionaryIndices = new Map(dictionary.map((value, index) => [value.join(','), index + 1]));
  const main = new ByteWriter();
  state = [new Int32Array(layout.slotCount), new Int32Array(layout.slotCount), new Int32Array(layout.slotCount)];
  initialized = new Uint8Array(layout.slotCount);
  const exceptions = new ExceptionWriter();
  let ordinal = 0;
  let squaredError = 0;
  let maximumError = 0;
  main.uint(bankCounts.reduce((sum, count) => sum + count, 0));
  main.uint(dictionary.length);
  for (const value of dictionary) {
    main.sint(value[0]);
    main.sint(value[1]);
    main.sint(value[2]);
  }
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const active = layout.activeSlots[segmentIndex];
    const activeLocals = layout.activeLocals?.[segmentIndex];
    const inverse = activeLocals ? null : layout.slotToLocal[segmentIndex];
    const stride = segment.propertyNames.length;
    for (let bank = 0; bank < bankCounts[segmentIndex]; bank += 1) {
      let birth = [0, 0, 0];
      let hasBirth = false;
      for (let row = 0; row < active.length; row += 1) {
        const slot = active[row];
        const local = activeLocals ? activeLocals[row] : inverse[slot];
        const base = local * stride;
        const source = indices[segmentIndex][bank].map((index) => halfToFloat(segment.rows[base + index]));
        const quantized = source.map((value) => Math.round(value / options.step));
        const residual = quantized.map((value, axis) => value - (initialized[slot] ? state[axis][slot] : hasBirth ? birth[axis] : 0));
        const dictionaryIndex = dictionaryIndices.get(residual.join(',')) ?? 0;
        main.byte(dictionaryIndex);
        if (dictionaryIndex === 0) {
          main.sint(residual[0]);
          main.sint(residual[1]);
          main.sint(residual[2]);
        }
        if (!initialized[slot]) {
          birth = quantized;
          hasBirth = true;
        }
        const decoded = quantized.map((value) => halfToFloat(floatToHalf(value * options.step)));
        const error = Math.max(...decoded.map((value, axis) => Math.abs(value - source[axis])));
        squaredError += decoded.reduce((sum, value, axis) => sum + (value - source[axis]) ** 2, 0);
        maximumError = Math.max(maximumError, error);
        if (!Number.isFinite(error) || error > options.maximumLogError) {
          exceptions.add(ordinal, indices[segmentIndex][bank].map((index) => segment.rows[base + index]));
        }
        for (let axis = 0; axis < 3; axis += 1) state[axis][slot] = quantized[axis];
        initialized[slot] = 1;
        ordinal += 1;
      }
    }
  }
  const mainRaw = main.finish();
  const exceptionRaw = exceptions.finish();
  const encoded = entropyPair('S3DPR001', mainRaw, exceptionRaw);
  return {
    encoded,
    metrics: {
      observationCount: ordinal,
      step: options.step,
      hardMaximumLogError: options.maximumLogError,
      measuredRmse: Math.sqrt(squaredError / (ordinal * 3)),
      measuredMaximumLogError: maximumError,
      measuredMaximumRelativeLinearError: Math.expm1(maximumError),
      exceptionCount: exceptions.count,
      learnedResidualDictionaryEntries: dictionary.length,
      mainRawBytes: mainRaw.length,
      exceptionRawBytes: exceptionRaw.length,
      encodedBytes: encoded.length,
      temporalTransform: 'reversible integer first-order lifting delta',
      entropyCodec: 'static byte rANS-12',
    },
  };
}

export function decodeScales(encoded, manifest, activeSlots, rows, indices) {
  const { main: mainBytes, exceptions: exceptionBytes } = decodeEntropyPair(encoded, 'S3DPR001');
  const reader = new ByteReader(mainBytes);
  const exceptionMap = exceptionRecords(exceptionBytes);
  const step = manifest.prs.scale.step;
  const stateX = new Int32Array(manifest.slotCount);
  const stateY = new Int32Array(manifest.slotCount);
  const stateZ = new Int32Array(manifest.slotCount);
  const initialized = new Uint8Array(manifest.slotCount);
  const layerCount = reader.uint();
  const dictionaryCount = reader.uint();
  const dictionary = Array.from({ length: dictionaryCount }, () => [reader.sint(), reader.sint(), reader.sint()]);
  const hasExceptions = exceptionMap.size > 0;
  let decodedLayers = 0;
  let ordinal = 0;
  // #WDD-gpt 2026-08-16 - Scale 热循环改为标量整数状态并缓存属性偏移，避免逐点 Array/map、模板字符串和 Map 查询。
  for (let segmentIndex = 0; segmentIndex < manifest.segments.length; segmentIndex += 1) {
    const active = activeSlots[segmentIndex];
    const rowValues = rows[segmentIndex];
    const stride = indices[segmentIndex].size;
    for (let bank = 0; bank < manifest.segments[segmentIndex].bankCounts.scale; bank += 1) {
      const propertyX = indices[segmentIndex].get(`scale_bank_${bank}_0`);
      const propertyY = indices[segmentIndex].get(`scale_bank_${bank}_1`);
      const propertyZ = indices[segmentIndex].get(`scale_bank_${bank}_2`);
      if (propertyX === undefined || propertyY === undefined || propertyZ === undefined) {
        throw new Error(`Scale property layout missing for segment ${segmentIndex}, bank ${bank}.`);
      }
      let birthX = 0;
      let birthY = 0;
      let birthZ = 0;
      let hasBirth = false;
      for (let row = 0; row < active.length; row += 1) {
        const slot = active[row];
        const dictionaryIndex = reader.byte();
        let residualX;
        let residualY;
        let residualZ;
        if (dictionaryIndex === 0) {
          residualX = reader.sint();
          residualY = reader.sint();
          residualZ = reader.sint();
        } else {
          const residual = dictionary[dictionaryIndex - 1];
          residualX = residual[0];
          residualY = residual[1];
          residualZ = residual[2];
        }
        const hasState = initialized[slot] !== 0;
        const quantizedX = residualX + (hasState ? stateX[slot] : hasBirth ? birthX : 0);
        const quantizedY = residualY + (hasState ? stateY[slot] : hasBirth ? birthY : 0);
        const quantizedZ = residualZ + (hasState ? stateZ[slot] : hasBirth ? birthZ : 0);
        if (!initialized[slot]) {
          birthX = quantizedX;
          birthY = quantizedY;
          birthZ = quantizedZ;
          hasBirth = true;
        }
        const exception = hasExceptions ? exceptionMap.get(ordinal) : undefined;
        const output = row * stride;
        rowValues[output + propertyX] = exception?.[0] ?? floatToHalf(quantizedX * step);
        rowValues[output + propertyY] = exception?.[1] ?? floatToHalf(quantizedY * step);
        rowValues[output + propertyZ] = exception?.[2] ?? floatToHalf(quantizedZ * step);
        stateX[slot] = quantizedX;
        stateY[slot] = quantizedY;
        stateZ[slot] = quantizedZ;
        initialized[slot] = 1;
        ordinal += 1;
      }
      decodedLayers += 1;
    }
  }
  if (decodedLayers !== layerCount) throw new Error(`Scale layer mismatch ${decodedLayers} != ${layerCount}`);
  reader.done();
  return { observationCount: ordinal, appliedExceptions: exceptionMap.size };
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
