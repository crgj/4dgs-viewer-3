import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { decodeRans, encodeRans, sha256 } from './fourcgs-prs-codec.mjs';

const execFileAsync = promisify(execFile);
const ENVELOPE_MAGICS = new Set(['V21PCTX1', 'V21ROT01', 'V21SCL01', 'V21DC001', 'V22ROT01', 'V22SCL01', 'V22DC001', 'V23SCL01']);
const TARGET_STREAMS = new Set(['prs_position', 'so3_rotation', 'tattr_scale', 'tattr_dc']);

class ByteReader {
  constructor(bytes, label = 'V2.1 stream') { this.bytes = bytes; this.offset = 0; this.label = label; }
  byte() { if (this.offset >= this.bytes.length) throw new Error(`Unexpected ${this.label} end.`); return this.bytes[this.offset++]; }
  uint() {
    let value = 0;
    let multiplier = 1;
    for (let index = 0; index < 8; index += 1) {
      const byte = this.byte();
      value += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) return value;
      multiplier *= 128;
    }
    throw new Error(`Oversized ${this.label} varint.`);
  }
  sint() { const value = this.uint(); return value & 1 ? -(value + 1) / 2 : value / 2; }
  done() { if (this.offset !== this.bytes.length) throw new Error(`Unused ${this.label} bytes: ${this.bytes.length - this.offset}`); }
}

class ByteWriter {
  constructor(chunkBytes = 1 << 20) {
    this.chunkBytes = chunkBytes;
    this.chunks = [];
    this.chunk = Buffer.allocUnsafe(chunkBytes);
    this.offset = 0;
    this.length = 0;
  }
  byte(value) { if (this.offset === this.chunk.length) this.flush(); this.chunk[this.offset++] = value & 0xff; this.length += 1; }
  uint(value) {
    let remaining = Math.trunc(value);
    if (!Number.isSafeInteger(remaining) || remaining < 0) throw new Error(`Invalid unsigned varint ${value}.`);
    while (remaining >= 128) { this.byte((remaining % 128) | 0x80); remaining = Math.floor(remaining / 128); }
    this.byte(remaining);
  }
  sint(value) { this.uint(value >= 0 ? value * 2 : -value * 2 - 1); }
  flush() {
    if (this.offset) this.chunks.push(this.chunk.subarray(0, this.offset));
    this.chunk = Buffer.allocUnsafe(this.chunkBytes);
    this.offset = 0;
  }
  finish() { this.flush(); return Buffer.concat(this.chunks, this.length); }
}

class PackedBits {
  constructor(bits) { this.bytes = Buffer.alloc(Math.ceil(bits / 8)); this.bitOffset = 0; }
  unary(zeros) { this.bitOffset += zeros; this.bytes[this.bitOffset >>> 3] |= 1 << (this.bitOffset & 7); this.bitOffset += 1; }
  write(value, bits) {
    for (let bit = 0; bit < bits; bit += 1) {
      if ((value & (2 ** bit)) !== 0) this.bytes[this.bitOffset >>> 3] |= 1 << (this.bitOffset & 7);
      this.bitOffset += 1;
    }
  }
}

class PackedBitReader {
  constructor(bytes, totalBits) { this.bytes = bytes; this.totalBits = totalBits; this.bitOffset = 0; }
  bit() {
    if (this.bitOffset >= this.totalBits) throw new Error('Unexpected Rice bitstream end.');
    const value = (this.bytes[this.bitOffset >>> 3] >>> (this.bitOffset & 7)) & 1;
    this.bitOffset += 1;
    return value;
  }
  unary() { let zeros = 0; while (this.bit() === 0) zeros += 1; return zeros; }
  read(bits) { let value = 0; for (let bit = 0; bit < bits; bit += 1) value += this.bit() * (2 ** bit); return value; }
  done() { if (this.bitOffset !== this.totalBits) throw new Error(`Unused Rice bits: ${this.totalBits - this.bitOffset}`); }
}

class PredictiveRiceSignedReader {
  constructor(header, parameters, bits) {
    this.valueCount = header.readUInt32LE(0);
    this.blockSize = header.readUInt32LE(4);
    this.blockCount = header.readUInt32LE(8);
    this.totalBits = header.readUInt32LE(12);
    if (parameters.length !== this.blockCount || bits.length !== Math.ceil(this.totalBits / 8)) throw new Error('Invalid direct predictive Rice parts.');
    const bitReader = new PackedBitReader(bits, this.totalBits);
    this.values = new Int32Array(this.valueCount);
    this.index = 0;
    for (let block = 0; block < this.blockCount; block += 1) {
      const parameter = parameters[block];
      const mode = parameter >>> 5;
      const k = parameter & 31;
      const first = block * this.blockSize;
      const last = Math.min(this.valueCount, first + this.blockSize);
      let anchor = 0;
      let previous = 0;
      let previous2 = 0;
      for (let ordinal = first; ordinal < last; ordinal += 1) {
        const blockOffset = ordinal - first;
        const unsigned = bitReader.unary() * (2 ** k) + bitReader.read(k);
        const residual = unsigned & 1 ? -(unsigned + 1) / 2 : unsigned / 2;
        let value = residual;
        if (mode === 1 && blockOffset > 0) value += previous;
        else if (mode === 2 && blockOffset === 1) value += previous;
        else if (mode === 2 && blockOffset > 1) value += 2 * previous - previous2;
        else if (mode === 3 && blockOffset > 0) value += anchor;
        if (blockOffset === 0) anchor = value;
        previous2 = previous;
        previous = value;
        this.values[ordinal] = value;
      }
    }
    bitReader.done();
  }
  sint() { if (this.index >= this.valueCount) throw new Error('Unexpected direct predictive Rice end.'); return this.values[this.index++]; }
  done() {
    if (this.index !== this.valueCount) throw new Error(`Unused direct predictive Rice values: ${this.valueCount - this.index}`);
  }
}

function decodeUnsignedVarints(bytes) {
  const reader = new ByteReader(bytes, 'unsigned-varint stream');
  const values = [];
  while (reader.offset < bytes.length) values.push(reader.uint());
  return Uint32Array.from(values);
}

function riceBits(values, first, last, k) {
  const divisor = 2 ** k;
  let bits = 0;
  for (let index = first; index < last; index += 1) bits += Math.floor(values[index] / divisor) + 1 + k;
  return bits;
}

function bestRiceK(values, first, last) {
  let bestK = 0;
  let bestBits = Number.POSITIVE_INFINITY;
  for (let k = 0; k <= 20; k += 1) {
    const bits = riceBits(values, first, last, k);
    if (bits < bestBits) { bestBits = bits; bestK = k; }
  }
  return { k: bestK, bits: bestBits };
}

function riceEncode(bytes, blockSize = 256) {
  const values = decodeUnsignedVarints(bytes);
  const blockCount = Math.ceil(values.length / blockSize);
  const parameters = Buffer.alloc(blockCount);
  const blocks = [];
  let totalBits = 0;
  for (let block = 0; block < blockCount; block += 1) {
    const first = block * blockSize;
    const last = Math.min(values.length, first + blockSize);
    const best = bestRiceK(values, first, last);
    parameters[block] = best.k;
    blocks.push({ first, last, k: best.k });
    totalBits += best.bits;
  }
  const writer = new PackedBits(totalBits);
  for (const block of blocks) {
    const divisor = 2 ** block.k;
    for (let index = block.first; index < block.last; index += 1) {
      const value = values[index];
      writer.unary(Math.floor(value / divisor));
      writer.write(value % divisor, block.k);
    }
  }
  const header = Buffer.alloc(16);
  header.writeUInt32LE(values.length, 0);
  header.writeUInt32LE(blockSize, 4);
  header.writeUInt32LE(blockCount, 8);
  header.writeUInt32LE(totalBits, 12);
  return Buffer.concat([header, parameters, writer.bytes]);
}

function riceDecode(bytes) {
  if (bytes.length < 16) throw new Error('Truncated Rice stream.');
  const valueCount = bytes.readUInt32LE(0);
  const blockSize = bytes.readUInt32LE(4);
  const blockCount = bytes.readUInt32LE(8);
  const totalBits = bytes.readUInt32LE(12);
  if (blockCount !== Math.ceil(valueCount / blockSize) || bytes.length !== 16 + blockCount + Math.ceil(totalBits / 8)) {
    throw new Error('Invalid Rice directory.');
  }
  const parameters = bytes.subarray(16, 16 + blockCount);
  const reader = new PackedBitReader(bytes.subarray(16 + blockCount), totalBits);
  const writer = new ByteWriter();
  for (let index = 0; index < valueCount; index += 1) {
    const k = parameters[Math.floor(index / blockSize)];
    writer.uint(reader.unary() * (2 ** k) + reader.read(k));
  }
  reader.done();
  return writer.finish();
}

function zigzag(value) { return value >= 0 ? value * 2 : -value * 2 - 1; }

function predictiveCodes(values, first, last, mode) {
  const codes = new Uint32Array(last - first);
  const anchor = values[first] ?? 0;
  for (let index = first; index < last; index += 1) {
    let residual = values[index];
    if (mode === 1 && index > first) residual -= values[index - 1];
    else if (mode === 2 && index === first + 1) residual -= values[index - 1];
    else if (mode === 2 && index > first + 1) residual -= 2 * values[index - 1] - values[index - 2];
    else if (mode === 3 && index > first) residual -= anchor;
    codes[index - first] = zigzag(residual);
  }
  return codes;
}

// #WDD-gpt 2026-08-16 - V2.2 每个 64 值块可逆选择原值、一阶、二阶或锚点预测，减少 Rotation/Scale 残差熵。
function predictiveRiceEncode(bytes, blockSize = 64) {
  const values = signedValues(bytes);
  const blockCount = Math.ceil(values.length / blockSize);
  const parameters = Buffer.alloc(blockCount);
  const blocks = [];
  let totalBits = 0;
  for (let block = 0; block < blockCount; block += 1) {
    const first = block * blockSize;
    const last = Math.min(values.length, first + blockSize);
    let selected;
    for (let mode = 0; mode < 4; mode += 1) {
      const codes = predictiveCodes(values, first, last, mode);
      const best = bestRiceK(codes, 0, codes.length);
      if (!selected || best.bits < selected.bits) selected = { mode, codes, ...best };
    }
    parameters[block] = (selected.mode << 5) | selected.k;
    blocks.push(selected);
    totalBits += selected.bits;
  }
  const writer = new PackedBits(totalBits);
  for (const block of blocks) {
    const divisor = 2 ** block.k;
    for (const value of block.codes) {
      writer.unary(Math.floor(value / divisor));
      writer.write(value % divisor, block.k);
    }
  }
  const header = Buffer.alloc(16);
  header.writeUInt32LE(values.length, 0);
  header.writeUInt32LE(blockSize, 4);
  header.writeUInt32LE(blockCount, 8);
  header.writeUInt32LE(totalBits, 12);
  return Buffer.concat([header, parameters, writer.bytes]);
}

function predictiveRiceDecode(bytes) {
  if (bytes.length < 16) throw new Error('Truncated predictive Rice stream.');
  const valueCount = bytes.readUInt32LE(0);
  const blockSize = bytes.readUInt32LE(4);
  const blockCount = bytes.readUInt32LE(8);
  const totalBits = bytes.readUInt32LE(12);
  if (!blockSize || blockCount !== Math.ceil(valueCount / blockSize) || bytes.length !== 16 + blockCount + Math.ceil(totalBits / 8)) {
    throw new Error('Invalid predictive Rice directory.');
  }
  const parameters = bytes.subarray(16, 16 + blockCount);
  const reader = new PackedBitReader(bytes.subarray(16 + blockCount), totalBits);
  const writer = new ByteWriter();
  for (let block = 0; block < blockCount; block += 1) {
    const parameter = parameters[block];
    const mode = parameter >>> 5;
    const k = parameter & 31;
    if (mode > 3 || k > 20) throw new Error(`Invalid predictive Rice parameter ${parameter}.`);
    const first = block * blockSize;
    const last = Math.min(valueCount, first + blockSize);
    let anchor = 0;
    let previous = 0;
    let previous2 = 0;
    for (let index = first; index < last; index += 1) {
      const unsigned = reader.unary() * (2 ** k) + reader.read(k);
      const residual = unsigned & 1 ? -(unsigned + 1) / 2 : unsigned / 2;
      let value = residual;
      if (mode === 1 && index > first) value += previous;
      else if (mode === 2 && index === first + 1) value += previous;
      else if (mode === 2 && index > first + 1) value += 2 * previous - previous2;
      else if (mode === 3 && index > first) value += anchor;
      if (index === first) anchor = value;
      previous2 = previous;
      previous = value;
      writer.sint(value);
    }
  }
  reader.done();
  return writer.finish();
}

function splitRiceContextParts(parts, isResidual) {
  const plain = [];
  const headers = [];
  const parameters = [];
  const bits = [];
  for (const part of parts) {
    if (!isResidual(part.name) || part.bytes.length === 0) { plain.push(part); continue; }
    const blockCount = part.bytes.readUInt32LE(8);
    headers.push({ name: `${part.name}$header`, bytes: part.bytes.subarray(0, 16) });
    parameters.push({ name: `${part.name}$parameters`, bytes: part.bytes.subarray(16, 16 + blockCount) });
    bits.push({ name: `${part.name}$bits`, bytes: part.bytes.subarray(16 + blockCount) });
  }
  return [...plain, ...headers, ...parameters, ...bits];
}

function restoreRiceContextParts(parts, streamNames, isResidual, decode) {
  const streams = new Map();
  for (const name of streamNames) {
    if (!isResidual(name) || parts.has(name)) streams.set(name, parts.get(name));
    else {
      const encoded = Buffer.concat([parts.get(`${name}$header`), parts.get(`${name}$parameters`), parts.get(`${name}$bits`)]);
      streams.set(name, decode(encoded));
    }
  }
  return streams;
}

function compactV22PartNames(metadata) {
  const streamNames = JSON.parse(Buffer.from(metadata.directoryBase64, 'base64').toString('utf8')).streams.map((entry) => entry.name);
  let isResidual;
  if (metadata.transform === 'so3-predictive-rice64-contexts') {
    isResidual = (name) => name.startsWith('boundary:') || name.startsWith('endpoint:');
  } else if (metadata.transform === 'scale-fp16-shuffle-plus-predictive-rice64-contexts') {
    isResidual = (name) => name.startsWith('boundary:') || name.startsWith('endpoint:') || name.startsWith('internal:');
  } else if (metadata.transform === 'scale-quantized-predictive-rice64-contexts') isResidual = () => true;
  else if (metadata.transform === 'dc-ycocg-r-plus-rice32-contexts') isResidual = (name) => name !== 'birth';
  else throw new Error(`Unsupported compact V2.2 transform ${metadata.transform}.`);
  const empty = new Set(metadata.emptyResidualNames ?? []);
  const plain = streamNames.filter((name) => !isResidual(name) || empty.has(name));
  const coded = streamNames.filter((name) => isResidual(name) && !empty.has(name));
  return [...plain, ...coded.map((name) => `${name}$header`), ...coded.map((name) => `${name}$parameters`), ...coded.map((name) => `${name}$bits`)];
}

function unpackEntropyPair(encoded, magic) {
  if (encoded.subarray(0, 8).toString('ascii') !== magic) throw new Error(`Expected ${magic} stream.`);
  const firstBytes = encoded.readUInt32LE(8);
  const secondBytes = encoded.readUInt32LE(12);
  if (16 + firstBytes + secondBytes !== encoded.length) throw new Error(`${magic} length mismatch.`);
  return [decodeRans(encoded.subarray(16, 16 + firstBytes)), decodeRans(encoded.subarray(16 + firstBytes))];
}

function packEntropyPair(first, second, magic) {
  const firstEncoded = encodeRans(first);
  const secondEncoded = encodeRans(second);
  const header = Buffer.alloc(16);
  header.write(magic, 0, 'ascii');
  header.writeUInt32LE(firstEncoded.length, 8);
  header.writeUInt32LE(secondEncoded.length, 12);
  return Buffer.concat([header, firstEncoded, secondEncoded]);
}

function unpackDirectoryRans(encoded, magic) {
  if (encoded.subarray(0, 8).toString('ascii') !== magic) throw new Error(`Expected ${magic} stream.`);
  const directoryBytes = encoded.readUInt32LE(8);
  const directoryBuffer = encoded.subarray(12, 12 + directoryBytes);
  const metadata = JSON.parse(directoryBuffer.toString('utf8'));
  const streams = new Map();
  let offset = 12 + directoryBytes;
  for (const entry of metadata.streams) {
    streams.set(entry.name, decodeRans(encoded.subarray(offset, offset + entry.bytes)));
    offset += entry.bytes;
  }
  if (offset !== encoded.length) throw new Error(`${magic} trailing bytes.`);
  return { directoryBuffer, metadata, streams };
}

function packDirectoryRans(directoryBuffer, rawStreams, magic) {
  const metadata = JSON.parse(directoryBuffer.toString('utf8'));
  const encodedStreams = metadata.streams.map((entry) => {
    const raw = rawStreams.get(entry.name);
    if (!raw) throw new Error(`Missing reconstructed stream ${entry.name}.`);
    const encoded = encodeRans(raw);
    if (encoded.length !== entry.bytes) throw new Error(`${entry.name} rANS size changed: ${encoded.length} != ${entry.bytes}.`);
    return encoded;
  });
  const prefix = Buffer.alloc(12);
  prefix.write(magic, 0, 'ascii');
  prefix.writeUInt32LE(directoryBuffer.length, 8);
  return Buffer.concat([prefix, directoryBuffer, ...encodedStreams]);
}

function positionContexts(raw, manifest) {
  const [main, exceptions] = unpackEntropyPair(raw, 'P3DPR001');
  const reader = new ByteReader(main, 'Position main stream');
  const metadata = new ByteWriter();
  const dictionaryCodes = new ByteWriter();
  const escape = [new ByteWriter(), new ByteWriter(), new ByteWriter()];
  const layerCount = reader.uint();
  metadata.uint(layerCount);
  let decodedLayers = 0;
  for (const segment of manifest.segments) {
    for (let bank = 0; bank < segment.bankCounts.position; bank += 1) {
      for (let axis = 0; axis < 3; axis += 1) metadata.sint(reader.sint());
      const cellCount = reader.uint();
      metadata.uint(cellCount);
      for (let cell = 0; cell < cellCount; cell += 1) {
        metadata.uint(reader.uint());
        const code = reader.uint();
        metadata.uint(code);
        if (code === 0) for (let axis = 0; axis < 3; axis += 1) metadata.sint(reader.sint());
      }
      for (let row = 0; row < segment.gaussianCount; row += 1) {
        const code = reader.uint();
        dictionaryCodes.uint(code);
        if (code === 0) for (let axis = 0; axis < 3; axis += 1) escape[axis].sint(reader.sint());
      }
      decodedLayers += 1;
    }
  }
  reader.done();
  if (decodedLayers !== layerCount) throw new Error(`Position layer mismatch: ${decodedLayers} != ${layerCount}.`);
  return [
    { name: 'metadata', bytes: metadata.finish() },
    { name: 'dictionary_codes', bytes: dictionaryCodes.finish() },
    ...escape.map((writer, axis) => ({ name: `escape_${axis}`, bytes: writer.finish() })),
    { name: 'exceptions', bytes: exceptions },
  ];
}

function restorePosition(parts, manifest) {
  const metadata = new ByteReader(parts.get('metadata'), 'Position metadata');
  const dictionaryCodes = new ByteReader(parts.get('dictionary_codes'), 'Position dictionary codes');
  const escape = [0, 1, 2].map((axis) => new ByteReader(parts.get(`escape_${axis}`), `Position escape ${axis}`));
  const writer = new ByteWriter();
  const layerCount = metadata.uint();
  writer.uint(layerCount);
  let decodedLayers = 0;
  for (const segment of manifest.segments) {
    for (let bank = 0; bank < segment.bankCounts.position; bank += 1) {
      for (let axis = 0; axis < 3; axis += 1) writer.sint(metadata.sint());
      const cellCount = metadata.uint();
      writer.uint(cellCount);
      for (let cell = 0; cell < cellCount; cell += 1) {
        writer.uint(metadata.uint());
        const code = metadata.uint();
        writer.uint(code);
        if (code === 0) for (let axis = 0; axis < 3; axis += 1) writer.sint(metadata.sint());
      }
      for (let row = 0; row < segment.gaussianCount; row += 1) {
        const code = dictionaryCodes.uint();
        writer.uint(code);
        if (code === 0) for (let axis = 0; axis < 3; axis += 1) writer.sint(escape[axis].sint());
      }
      decodedLayers += 1;
    }
  }
  metadata.done();
  dictionaryCodes.done();
  for (const reader of escape) reader.done();
  if (decodedLayers !== layerCount) throw new Error('Reconstructed Position layer mismatch.');
  return packEntropyPair(writer.finish(), parts.get('exceptions'), 'P3DPR001');
}

function shuffleScaleBirth(raw) {
  if (raw.length % 6 !== 0) throw new Error('Scale birth is not XYZ FP16.');
  const count = raw.length / 6;
  const values = raw.length / 2;
  const output = Buffer.allocUnsafe(raw.length);
  let ordinal = 0;
  for (let axis = 0; axis < 3; axis += 1) for (let index = 0; index < count; index += 1) {
    const value = raw.readUInt16LE((index * 3 + axis) * 2);
    output[ordinal] = value & 0xff;
    output[values + ordinal] = value >>> 8;
    ordinal += 1;
  }
  return output;
}

function unshuffleScaleBirth(raw) {
  if (raw.length % 6 !== 0) throw new Error('Scale shuffled birth is invalid.');
  const count = raw.length / 6;
  const values = raw.length / 2;
  const output = Buffer.allocUnsafe(raw.length);
  let ordinal = 0;
  for (let axis = 0; axis < 3; axis += 1) for (let index = 0; index < count; index += 1) {
    output.writeUInt16LE(raw[ordinal] | (raw[values + ordinal] << 8), (index * 3 + axis) * 2);
    ordinal += 1;
  }
  return output;
}

function signedValues(bytes) {
  const reader = new ByteReader(bytes, 'signed values');
  const values = [];
  while (reader.offset < bytes.length) values.push(reader.sint());
  return values;
}

function signedBytes(values) { const writer = new ByteWriter(); for (const value of values) writer.sint(value); return writer.finish(); }

function ycocgForward(x, y, z) {
  const co = x - z;
  const temporary = z + (co >> 1);
  const cg = y - temporary;
  return [temporary + (cg >> 1), co, cg];
}

function ycocgInverse(luma, co, cg) {
  const temporary = luma - (cg >> 1);
  const y = cg + temporary;
  const z = temporary - (co >> 1);
  return [z + co, y, z];
}

function transformDc(streams) {
  const transformed = new Map();
  const birth = signedValues(streams.get('birth'));
  if (birth.length % 3 !== 0) throw new Error('DC birth component mismatch.');
  const birthPlanes = [[], [], []];
  for (let index = 0; index < birth.length; index += 3) {
    const next = ycocgForward(birth[index], birth[index + 1], birth[index + 2]);
    for (let axis = 0; axis < 3; axis += 1) birthPlanes[axis].push(next[axis]);
  }
  transformed.set('birth', Buffer.concat(birthPlanes.map(signedBytes)));
  const birthPlaneBytes = birthPlanes.map((values) => signedBytes(values).length);
  for (const context of ['boundary', 'endpoint', 'internal']) {
    const source = [0, 1, 2].map((axis) => signedValues(streams.get(`${context}:${axis}`)));
    if (!source.every((values) => values.length === source[0].length)) throw new Error(`DC ${context} component mismatch.`);
    const target = [[], [], []];
    for (let index = 0; index < source[0].length; index += 1) {
      const next = ycocgForward(source[0][index], source[1][index], source[2][index]);
      for (let axis = 0; axis < 3; axis += 1) target[axis].push(next[axis]);
    }
    for (let axis = 0; axis < 3; axis += 1) transformed.set(`${context}:${axis}`, signedBytes(target[axis]));
  }
  return { transformed, birthPlaneBytes };
}

function restoreDc(transformed, birthPlaneBytes) {
  const streams = new Map();
  const birth = transformed.get('birth');
  const birthPlanes = [];
  let offset = 0;
  for (const bytes of birthPlaneBytes) { birthPlanes.push(signedValues(birth.subarray(offset, offset + bytes))); offset += bytes; }
  if (offset !== birth.length || !birthPlanes.every((values) => values.length === birthPlanes[0].length)) throw new Error('DC birth plane mismatch.');
  const restoredBirth = [];
  for (let index = 0; index < birthPlanes[0].length; index += 1) restoredBirth.push(...ycocgInverse(birthPlanes[0][index], birthPlanes[1][index], birthPlanes[2][index]));
  streams.set('birth', signedBytes(restoredBirth));
  for (const context of ['boundary', 'endpoint', 'internal']) {
    const source = [0, 1, 2].map((axis) => signedValues(transformed.get(`${context}:${axis}`)));
    if (!source.every((values) => values.length === source[0].length)) throw new Error(`DC ${context} transformed component mismatch.`);
    const target = [[], [], []];
    for (let index = 0; index < source[0].length; index += 1) {
      const next = ycocgInverse(source[0][index], source[1][index], source[2][index]);
      for (let axis = 0; axis < 3; axis += 1) target[axis].push(next[axis]);
    }
    for (let axis = 0; axis < 3; axis += 1) streams.set(`${context}:${axis}`, signedBytes(target[axis]));
  }
  return streams;
}

function packEnvelope(magic, metadata, blocks) {
  const directory = Buffer.from(JSON.stringify({ ...metadata, blocks: blocks.map((block) => ({ name: block.name, rawBytes: block.rawBytes, storedBytes: block.bytes.length, storedSha256: sha256(block.bytes) })) }), 'utf8');
  const header = Buffer.alloc(12);
  header.write(magic, 0, 'ascii');
  header.writeUInt32LE(directory.length, 8);
  return Buffer.concat([header, directory, ...blocks.map((block) => block.bytes)]);
}

function unpackEnvelope(encoded) {
  const magic = encoded.subarray(0, 8).toString('ascii');
  if (!ENVELOPE_MAGICS.has(magic)) throw new Error('Unsupported V2.1 structured stream.');
  const directoryBytes = encoded.readUInt32LE(8);
  const metadata = JSON.parse(encoded.subarray(12, 12 + directoryBytes).toString('utf8'));
  const blocks = new Map();
  let offset = 12 + directoryBytes;
  for (const block of metadata.blocks) {
    const bytes = encoded.subarray(offset, offset + block.storedBytes);
    if (bytes.length !== block.storedBytes || sha256(bytes) !== block.storedSha256) throw new Error(`V2.1 block validation failed: ${block.name}.`);
    blocks.set(block.name, bytes);
    offset += block.storedBytes;
  }
  if (offset !== encoded.length) throw new Error(`V2.1 trailing bytes: ${encoded.length - offset}.`);
  return { magic, metadata, blocks };
}

async function xzCompress(bytes, lzma2) {
  const directory = await mkdtemp(join(tmpdir(), 'fourcgs-v21-'));
  const input = join(directory, 'payload.bin');
  try {
    await writeFile(input, bytes);
    const argumentsList = ['-f', '-k'];
    if (lzma2) argumentsList.push(`--lzma2=${lzma2}`);
    else argumentsList.push('-9e');
    argumentsList.push(input);
    await execFileAsync('xz', argumentsList, { maxBuffer: 1024 * 1024 });
    return await readFile(`${input}.xz`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// #WDD-gpt 2026-08-16 - xzwasm 会复用 WASM 内存视图，必须在读取下一块前复制当前块，避免大流静默损坏。
export async function decodeXzBrowser(encoded) {
  if (globalThis.self === undefined) globalThis.self = globalThis;
  const imported = await import('xzwasm');
  const XzReadableStream = imported.XzReadableStream ?? imported.default?.XzReadableStream ?? globalThis.XzReadableStream;
  if (!XzReadableStream) throw new Error('xzwasm did not expose XzReadableStream.');
  const source = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength)); controller.close(); } });
  const reader = new XzReadableStream(source).getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const copied = Buffer.from(value.slice());
    chunks.push(copied);
    length += copied.length;
  }
  return Buffer.concat(chunks, length);
}

export function isV21StructuredStream(encoded) {
  return encoded.length >= 12 && ENVELOPE_MAGICS.has(encoded.subarray(0, 8).toString('ascii'));
}

// #WDD-gpt 2026-08-16 - V2.1 只做可逆上下文重排、Rice 和 XZ；还原后必须与 V2 内层流逐字节一致。
export async function encodeV21StructuredStream(name, raw, manifest) {
  if (!TARGET_STREAMS.has(name)) throw new Error(`Unsupported V2.1 target ${name}.`);
  let magic;
  let transform;
  let transformMetadata = {};
  let parts;
  let blocks;
  if (name === 'prs_position') {
    magic = 'V21PCTX1';
    transform = 'position-context-split';
    parts = positionContexts(raw, manifest);
    blocks = [];
    for (const part of parts) blocks.push({ name: part.name, rawBytes: part.bytes.length, bytes: await xzCompress(part.bytes, 'preset=9e,dict=4KiB,lc=1,lp=0,pb=0') });
  } else {
    const originalMagic = name === 'so3_rotation' ? 'SO3TR001' : 'TATTR001';
    const unpacked = unpackDirectoryRans(raw, originalMagic);
    transformMetadata.directoryBase64 = unpacked.directoryBuffer.toString('base64');
    if (name === 'tattr_scale') {
      magic = 'V21SCL01';
      transform = 'scale-fp16-shuffle-plus-rice256';
      parts = unpacked.metadata.streams.map((entry) => ({
        name: entry.name,
        bytes: entry.name === 'birth' ? shuffleScaleBirth(unpacked.streams.get(entry.name)) : riceEncode(unpacked.streams.get(entry.name), 256),
      }));
      blocks = [{ name: 'payload', rawBytes: parts.reduce((sum, part) => sum + part.bytes.length, 0), bytes: await xzCompress(Buffer.concat(parts.map((part) => part.bytes)), 'preset=9e,dict=4KiB,lc=0,lp=0,pb=0') }];
    } else if (name === 'so3_rotation') {
      magic = 'V21ROT01';
      transform = 'so3-residual-rice256';
      parts = unpacked.metadata.streams.map((entry) => ({
        name: entry.name,
        bytes: entry.name.startsWith('boundary:') || entry.name.startsWith('endpoint:') ? riceEncode(unpacked.streams.get(entry.name), 256) : unpacked.streams.get(entry.name),
      }));
      blocks = [{ name: 'payload', rawBytes: parts.reduce((sum, part) => sum + part.bytes.length, 0), bytes: await xzCompress(Buffer.concat(parts.map((part) => part.bytes))) }];
    } else {
      magic = 'V21DC001';
      transform = 'dc-ycocg-r';
      const dc = transformDc(unpacked.streams);
      transformMetadata.birthPlaneBytes = dc.birthPlaneBytes;
      parts = unpacked.metadata.streams.map((entry) => ({ name: entry.name, bytes: dc.transformed.get(entry.name) }));
      blocks = [{ name: 'payload', rawBytes: parts.reduce((sum, part) => sum + part.bytes.length, 0), bytes: await xzCompress(Buffer.concat(parts.map((part) => part.bytes)), 'preset=9e,dict=4KiB,lc=1,lp=0,pb=0') }];
    }
  }
  const encoded = packEnvelope(magic, {
    version: 1,
    streamName: name,
    transform,
    sourceBytes: raw.length,
    sourceSha256: sha256(raw),
    parts: parts.map((part) => ({ name: part.name, bytes: part.bytes.length })),
    ...transformMetadata,
  }, blocks);
  return { encoded, metrics: { name, transform, sourceBytes: raw.length, storedBytes: encoded.length, ratio: raw.length / encoded.length } };
}

// #WDD-gpt 2026-08-16 - V2.2 仅替换 Rotation/DC/Scale 的无损内层编码，Position、SH、生命周期和外层语义保持 V2.1 不变。
export async function encodeV22StructuredStream(name, raw) {
  if (!['so3_rotation', 'tattr_scale', 'tattr_dc'].includes(name)) throw new Error(`Unsupported V2.2 target ${name}.`);
  const originalMagic = name === 'so3_rotation' ? 'SO3TR001' : 'TATTR001';
  const unpacked = unpackDirectoryRans(raw, originalMagic);
  const directoryBase64 = unpacked.directoryBuffer.toString('base64');
  const streamEntries = unpacked.metadata.streams;
  let magic;
  let transform;
  let transformMetadata = {};
  let version = 2;
  let logicalParts;
  let parts;
  let lzma2;
  if (name === 'so3_rotation') {
    magic = 'V22ROT01';
    transform = 'so3-predictive-rice64-contexts';
    const isResidual = (partName) => partName.startsWith('boundary:') || partName.startsWith('endpoint:');
    logicalParts = streamEntries.map((entry) => ({
      name: entry.name,
      bytes: isResidual(entry.name) && unpacked.streams.get(entry.name).length ? predictiveRiceEncode(unpacked.streams.get(entry.name), 64) : unpacked.streams.get(entry.name),
    }));
    parts = splitRiceContextParts(logicalParts, isResidual);
    lzma2 = 'preset=9e,dict=1MiB,lc=2,lp=0,pb=0';
  } else if (name === 'tattr_scale') {
    // #WDD-gpt 2026-08-16 - V2.3 量化 Scale 的 birth 也是有符号残差，使用独立魔数，禁止误按 FP16 byte-shuffle 解码。
    const exactHalf = Boolean(unpacked.metadata.exactHalf);
    magic = exactHalf ? 'V22SCL01' : 'V23SCL01';
    version = exactHalf ? 2 : 3;
    transform = exactHalf ? 'scale-fp16-shuffle-plus-predictive-rice64-contexts' : 'scale-quantized-predictive-rice64-contexts';
    const isResidual = exactHalf
      ? (partName) => partName.startsWith('boundary:') || partName.startsWith('endpoint:') || partName.startsWith('internal:')
      : () => true;
    logicalParts = streamEntries.map((entry) => {
      const source = unpacked.streams.get(entry.name);
      return {
        name: entry.name,
        bytes: exactHalf && entry.name === 'birth'
          ? shuffleScaleBirth(source)
          : isResidual(entry.name) && source.length
            ? predictiveRiceEncode(source, 64)
            : source,
      };
    });
    parts = splitRiceContextParts(logicalParts, isResidual);
    lzma2 = 'preset=9e,dict=4KiB,lc=0,lp=0,pb=0';
  } else {
    magic = 'V22DC001';
    transform = 'dc-ycocg-r-plus-rice32-contexts';
    const dc = transformDc(unpacked.streams);
    transformMetadata = { birthPlaneBytes: dc.birthPlaneBytes };
    const isResidual = (partName) => partName !== 'birth';
    logicalParts = streamEntries.map((entry) => ({
      name: entry.name,
      bytes: isResidual(entry.name) && dc.transformed.get(entry.name).length ? riceEncode(dc.transformed.get(entry.name), 32) : dc.transformed.get(entry.name),
    }));
    parts = splitRiceContextParts(logicalParts, isResidual);
    lzma2 = 'preset=9e,dict=16KiB,lc=1,lp=0,pb=0';
  }
  const payload = Buffer.concat(parts.map((part) => part.bytes));
  const blocks = [{ name: 'payload', rawBytes: payload.length, bytes: await xzCompress(payload, lzma2) }];
  const encoded = packEnvelope(magic, {
    version,
    streamName: name,
    transform,
    sourceBytes: raw.length,
    sourceSha256: sha256(raw),
    partBytes: parts.map((part) => part.bytes.length),
    emptyResidualNames: logicalParts.filter((part) => part.bytes.length === 0).map((part) => part.name),
    directoryBase64,
    ...transformMetadata,
  }, blocks);
  return { encoded, metrics: { name, transform, sourceBytes: raw.length, storedBytes: encoded.length, ratio: raw.length / encoded.length } };
}

// #WDD-gpt 2026-08-16 - V2.4 暴露 V2.2/V2.3 外层逆变换后的原始属性子流，运行时不再重建中间 rANS 文件。
export async function decodeV22StructuredParts(name, encoded) {
  const { metadata, blocks } = unpackEnvelope(encoded);
  if (metadata.streamName !== name || ![2, 3].includes(metadata.version)) {
    throw new Error(`V2.4 direct stream identity mismatch for ${name}.`);
  }
  if (metadata.transform === 'position-context-split' || !metadata.directoryBase64) {
    throw new Error(`V2.4 direct stream does not support ${metadata.transform}.`);
  }
  const payload = await decodeXzBrowser(blocks.get('payload'));
  const names = compactV22PartNames(metadata);
  if (names.length !== metadata.partBytes?.length) throw new Error(`V2.4 ${name} compact part count mismatch.`);
  const parts = new Map();
  let offset = 0;
  for (let index = 0; index < names.length; index += 1) {
    const bytes = metadata.partBytes[index];
    parts.set(names[index], payload.subarray(offset, offset + bytes));
    offset += bytes;
  }
  if (offset !== payload.length) throw new Error(`V2.4 ${name} payload length mismatch.`);
  const directoryBuffer = Buffer.from(metadata.directoryBase64, 'base64');
  const streamMetadata = JSON.parse(directoryBuffer.toString('utf8'));
  const streamNames = streamMetadata.streams.map((entry) => entry.name);
  let streams;
  if (metadata.transform === 'so3-predictive-rice64-contexts') {
    streams = restoreRiceContextParts(parts, streamNames, (partName) => partName.startsWith('boundary:') || partName.startsWith('endpoint:'), predictiveRiceDecode);
  } else if (metadata.transform === 'scale-fp16-shuffle-plus-predictive-rice64-contexts') {
    streams = restoreRiceContextParts(parts, streamNames, (partName) => partName.startsWith('boundary:') || partName.startsWith('endpoint:') || partName.startsWith('internal:'), predictiveRiceDecode);
    streams.set('birth', unshuffleScaleBirth(streams.get('birth')));
  } else if (metadata.transform === 'scale-quantized-predictive-rice64-contexts') {
    streams = restoreRiceContextParts(parts, streamNames, () => true, predictiveRiceDecode);
  } else if (metadata.transform === 'dc-ycocg-r-plus-rice32-contexts') {
    const transformed = restoreRiceContextParts(parts, streamNames, (partName) => partName !== 'birth', riceDecode);
    streams = restoreDc(transformed, metadata.birthPlaneBytes);
  } else {
    throw new Error(`Unsupported V2.4 direct transform ${metadata.transform}.`);
  }
  return { metadata: streamMetadata, streams, envelopeMetadata: metadata };
}

// #WDD-gpt 2026-08-16 - V2.4 Scale 从 Rice bitstream 按需取整数，避免先生成 21.1M Varint 再二次解析。
export async function decodeV22ScaleReaders(encoded) {
  const { metadata, blocks } = unpackEnvelope(encoded);
  if (metadata.streamName !== 'tattr_scale' || metadata.transform !== 'scale-quantized-predictive-rice64-contexts') {
    throw new Error('V2.4 direct Scale reader requires the quantized predictive Rice stream.');
  }
  const payload = await decodeXzBrowser(blocks.get('payload'));
  const names = compactV22PartNames(metadata);
  if (names.length !== metadata.partBytes?.length) throw new Error('V2.4 Scale compact part count mismatch.');
  const parts = new Map();
  let offset = 0;
  for (let index = 0; index < names.length; index += 1) {
    const bytes = metadata.partBytes[index];
    parts.set(names[index], payload.subarray(offset, offset + bytes));
    offset += bytes;
  }
  if (offset !== payload.length) throw new Error('V2.4 Scale payload length mismatch.');
  const streamMetadata = JSON.parse(Buffer.from(metadata.directoryBase64, 'base64').toString('utf8'));
  const readers = new Map();
  for (const entry of streamMetadata.streams) {
    if (metadata.emptyResidualNames?.includes(entry.name)) throw new Error(`V2.4 Scale unexpectedly contains empty stream ${entry.name}.`);
    readers.set(entry.name, new PredictiveRiceSignedReader(
      parts.get(`${entry.name}$header`),
      parts.get(`${entry.name}$parameters`),
      parts.get(`${entry.name}$bits`),
    ));
  }
  return { metadata: streamMetadata, readers, envelopeMetadata: metadata };
}

export async function decodeV21StructuredStream(name, encoded, manifest) {
  const { metadata, blocks } = unpackEnvelope(encoded);
  if (metadata.streamName !== name || ![1, 2, 3].includes(metadata.version)) throw new Error(`Structured stream identity mismatch for ${name}.`);
  const parts = new Map();
  if (metadata.transform === 'position-context-split') {
    for (const part of metadata.parts) {
      const decoded = await decodeXzBrowser(blocks.get(part.name));
      if (decoded.length !== part.bytes) throw new Error(`${part.name} decoded length mismatch.`);
      parts.set(part.name, decoded);
    }
  } else {
    const payload = await decodeXzBrowser(blocks.get('payload'));
    const partDirectory = metadata.parts ?? (() => {
      const names = compactV22PartNames(metadata);
      if (names.length !== metadata.partBytes?.length) throw new Error(`V2.2 ${name} compact part count mismatch.`);
      return names.map((partName, index) => ({ name: partName, bytes: metadata.partBytes[index] }));
    })();
    let offset = 0;
    for (const part of partDirectory) {
      parts.set(part.name, payload.subarray(offset, offset + part.bytes));
      offset += part.bytes;
    }
    if (offset !== payload.length) throw new Error(`Structured ${name} payload length mismatch.`);
  }
  let raw;
  if (metadata.transform === 'position-context-split') raw = restorePosition(parts, manifest);
  else {
    const directoryBuffer = Buffer.from(metadata.directoryBase64, 'base64');
    let streams;
    if (metadata.transform === 'scale-fp16-shuffle-plus-rice256') {
      streams = new Map([...parts].map(([partName, bytes]) => [partName, partName === 'birth' ? unshuffleScaleBirth(bytes) : riceDecode(bytes)]));
    } else if (metadata.transform === 'so3-residual-rice256') {
      streams = new Map([...parts].map(([partName, bytes]) => [partName, partName.startsWith('boundary:') || partName.startsWith('endpoint:') ? riceDecode(bytes) : bytes]));
    } else if (metadata.transform === 'dc-ycocg-r') streams = restoreDc(parts, metadata.birthPlaneBytes);
    else {
      const streamNames = JSON.parse(directoryBuffer.toString('utf8')).streams.map((entry) => entry.name);
      if (metadata.transform === 'so3-predictive-rice64-contexts') {
        streams = restoreRiceContextParts(parts, streamNames, (partName) => partName.startsWith('boundary:') || partName.startsWith('endpoint:'), predictiveRiceDecode);
      } else if (metadata.transform === 'scale-fp16-shuffle-plus-predictive-rice64-contexts') {
        streams = restoreRiceContextParts(parts, streamNames, (partName) => partName.startsWith('boundary:') || partName.startsWith('endpoint:') || partName.startsWith('internal:'), predictiveRiceDecode);
        streams.set('birth', unshuffleScaleBirth(streams.get('birth')));
      } else if (metadata.transform === 'scale-quantized-predictive-rice64-contexts') {
        streams = restoreRiceContextParts(parts, streamNames, () => true, predictiveRiceDecode);
      } else if (metadata.transform === 'dc-ycocg-r-plus-rice32-contexts') {
        const transformed = restoreRiceContextParts(parts, streamNames, (partName) => partName !== 'birth', riceDecode);
        streams = restoreDc(transformed, metadata.birthPlaneBytes);
      } else throw new Error(`Unsupported structured transform ${metadata.transform}.`);
    }
    raw = packDirectoryRans(directoryBuffer, streams, name === 'so3_rotation' ? 'SO3TR001' : 'TATTR001');
  }
  if (raw.length !== metadata.sourceBytes || sha256(raw) !== metadata.sourceSha256) throw new Error(`Structured ${name} lossless reconstruction failed.`);
  return raw;
}
