import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

class ByteReader {
  constructor(bytes) { this.bytes = bytes; this.offset = 0; }
  byte() { if (this.offset >= this.bytes.length) throw new Error('Unexpected varint end.'); return this.bytes[this.offset++]; }
  uint() {
    let value = 0;
    let multiplier = 1;
    for (let index = 0; index < 8; index += 1) {
      const byte = this.byte();
      value += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) return value;
      multiplier *= 128;
    }
    throw new Error('Oversized varint.');
  }
  sint() { const value = this.uint(); return value & 1 ? -(value + 1) / 2 : value / 2; }
}

class ByteWriter {
  constructor(chunkBytes = 1 << 20) { this.chunkBytes = chunkBytes; this.chunks = []; this.chunk = Buffer.allocUnsafe(chunkBytes); this.offset = 0; this.length = 0; }
  byte(value) { if (this.offset === this.chunk.length) this.flush(); this.chunk[this.offset++] = value & 0xff; this.length += 1; }
  uint(value) { let remaining = value; while (remaining >= 128) { this.byte((remaining % 128) | 0x80); remaining = Math.floor(remaining / 128); } this.byte(remaining); }
  sint(value) { this.uint(value >= 0 ? value * 2 : -value * 2 - 1); }
  flush() { if (this.offset) this.chunks.push(this.chunk.subarray(0, this.offset)); this.chunk = Buffer.allocUnsafe(this.chunkBytes); this.offset = 0; }
  finish() { this.flush(); return Buffer.concat(this.chunks, this.length); }
}

class PackedBits {
  constructor(bits) { this.bytes = Buffer.alloc(Math.ceil(bits / 8)); this.bitOffset = 0; }
  unary(zeros) { this.bitOffset += zeros; this.bytes[this.bitOffset >>> 3] |= 1 << (this.bitOffset & 7); this.bitOffset += 1; }
  write(value, bits) { for (let bit = 0; bit < bits; bit += 1) { if ((value & (2 ** bit)) !== 0) this.bytes[this.bitOffset >>> 3] |= 1 << (this.bitOffset & 7); this.bitOffset += 1; } }
}

function decodeSigned(bytes) {
  const reader = new ByteReader(bytes);
  const values = [];
  while (reader.offset < bytes.length) values.push(reader.sint());
  return Int32Array.from(values);
}

function encodeSigned(values) { const writer = new ByteWriter(); for (const value of values) writer.sint(value); return writer.finish(); }

function decodeUnsigned(bytes) {
  const reader = new ByteReader(bytes);
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

function riceEncode(bytes, blockSize) {
  const values = decodeUnsigned(bytes);
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

function predictiveRiceEncode(bytes, blockSize) {
  const values = decodeSigned(bytes);
  const blockCount = Math.ceil(values.length / blockSize);
  const parameters = Buffer.alloc(blockCount);
  const blocks = [];
  let totalBits = 0;
  for (let block = 0; block < blockCount; block += 1) {
    const first = block * blockSize;
    const last = Math.min(values.length, first + blockSize);
    let selected = null;
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
    for (const value of block.codes) { writer.unary(Math.floor(value / divisor)); writer.write(value % divisor, block.k); }
  }
  const header = Buffer.alloc(16);
  header.writeUInt32LE(values.length, 0);
  header.writeUInt32LE(blockSize, 4);
  header.writeUInt32LE(blockCount, 8);
  header.writeUInt32LE(totalBits, 12);
  return Buffer.concat([header, parameters, writer.bytes]);
}

function golombBitCount(values, first, last, divisor) {
  const remainderBits = Math.ceil(Math.log2(divisor));
  const cutoff = 2 ** remainderBits - divisor;
  let bits = 0;
  for (let index = first; index < last; index += 1) {
    const quotient = Math.floor(values[index] / divisor);
    const remainder = values[index] % divisor;
    bits += quotient + 1 + (remainder < cutoff ? remainderBits - 1 : remainderBits);
  }
  return bits;
}

function bestGolombDivisor(values, first, last) {
  let sum = 0;
  for (let index = first; index < last; index += 1) sum += values[index];
  const mean = sum / Math.max(1, last - first);
  const estimate = mean > 0 ? Math.max(1, Math.round(-Math.LN2 / Math.log(mean / (mean + 1)))) : 1;
  const candidates = new Set([1]);
  for (const factor of [0.35, 0.5, 0.625, 0.75, 0.875, 1, 1.125, 1.25, 1.5, 1.75, 2, 2.5]) candidates.add(Math.max(1, Math.round(estimate * factor)));
  const power = 2 ** Math.round(Math.log2(Math.max(1, estimate)));
  for (const factor of [0.5, 1, 2]) candidates.add(Math.max(1, Math.round(power * factor)));
  let bestDivisor = 1;
  let bestBits = Number.POSITIVE_INFINITY;
  for (const divisor of candidates) {
    const bits = golombBitCount(values, first, last, divisor);
    if (bits < bestBits) { bestBits = bits; bestDivisor = divisor; }
  }
  return { divisor: bestDivisor, bits: bestBits };
}

function golombEncode(bytes, blockSize) {
  const values = decodeUnsigned(bytes);
  const blockCount = Math.ceil(values.length / blockSize);
  const parameterWriter = new ByteWriter();
  const blocks = [];
  let totalBits = 0;
  for (let block = 0; block < blockCount; block += 1) {
    const first = block * blockSize;
    const last = Math.min(values.length, first + blockSize);
    const best = bestGolombDivisor(values, first, last);
    parameterWriter.uint(best.divisor);
    blocks.push({ first, last, divisor: best.divisor });
    totalBits += best.bits;
  }
  const parameters = parameterWriter.finish();
  const writer = new PackedBits(totalBits);
  for (const block of blocks) {
    const remainderBits = Math.ceil(Math.log2(block.divisor));
    const cutoff = 2 ** remainderBits - block.divisor;
    for (let index = block.first; index < block.last; index += 1) {
      const quotient = Math.floor(values[index] / block.divisor);
      const remainder = values[index] % block.divisor;
      writer.unary(quotient);
      if (remainder < cutoff) writer.write(remainder, remainderBits - 1);
      else writer.write(remainder + cutoff, remainderBits);
    }
  }
  const header = Buffer.alloc(20);
  header.writeUInt32LE(values.length, 0);
  header.writeUInt32LE(blockSize, 4);
  header.writeUInt32LE(blockCount, 8);
  header.writeUInt32LE(totalBits, 12);
  header.writeUInt32LE(parameters.length, 16);
  return Buffer.concat([header, parameters, writer.bytes]);
}

function splitStreams(symbols, probe) {
  const streams = new Map();
  let offset = 0;
  for (const stream of probe.streams) {
    streams.set(stream.name, symbols.subarray(offset, offset + stream.rawBytes));
    offset += stream.rawBytes;
  }
  if (offset !== symbols.length) throw new Error(`${probe.name} symbol layout mismatch.`);
  return streams;
}

function shuffleScaleBirth(raw) {
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

function differenceSigned(bytes) {
  const source = decodeSigned(bytes);
  const target = new Int32Array(source.length);
  let previous = 0;
  for (let index = 0; index < source.length; index += 1) { target[index] = source[index] - previous; previous = source[index]; }
  return encodeSigned(target);
}

function ycocgTriplets(components) {
  const target = [new Int32Array(components[0].length), new Int32Array(components[0].length), new Int32Array(components[0].length)];
  for (let index = 0; index < components[0].length; index += 1) {
    const co = components[0][index] - components[2][index];
    const temporary = components[2][index] + (co >> 1);
    const cg = components[1][index] - temporary;
    target[0][index] = temporary + (cg >> 1);
    target[1][index] = co;
    target[2][index] = cg;
  }
  return target;
}

function dcBirthComponents(raw) {
  const interleaved = decodeSigned(raw);
  if (interleaved.length % 3 !== 0) throw new Error('DC birth mismatch.');
  const components = [new Int32Array(interleaved.length / 3), new Int32Array(interleaved.length / 3), new Int32Array(interleaved.length / 3)];
  for (let index = 0; index < components[0].length; index += 1) for (let axis = 0; axis < 3; axis += 1) components[axis][index] = interleaved[index * 3 + axis];
  return components;
}

function vectorKey(x, y, z) { return `${x},${y},${z}`; }

function vectorDictionary(components, maximumEntries) {
  if (!components.every((values) => values.length === components[0].length)) throw new Error('Vector component length mismatch.');
  const counts = new Map();
  for (let index = 0; index < components[0].length; index += 1) {
    const key = vectorKey(components[0][index], components[1][index], components[2][index]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const dictionary = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maximumEntries)
    .map(([key]) => key.split(',').map(Number));
  const codes = new Map(dictionary.map((values, index) => [vectorKey(...values), index + 1]));
  const header = new ByteWriter();
  header.uint(components[0].length);
  header.uint(dictionary.length);
  for (const values of dictionary) for (const value of values) header.sint(value);
  const codeWriter = new ByteWriter();
  const escapes = [new ByteWriter(), new ByteWriter(), new ByteWriter()];
  let escaped = 0;
  for (let index = 0; index < components[0].length; index += 1) {
    const values = [components[0][index], components[1][index], components[2][index]];
    const code = codes.get(vectorKey(...values)) ?? 0;
    codeWriter.uint(code);
    if (code === 0) { for (let axis = 0; axis < 3; axis += 1) escapes[axis].sint(values[axis]); escaped += 1; }
  }
  return {
    bytes: Buffer.concat([header.finish(), codeWriter.finish(), ...escapes.map((writer) => writer.finish())]),
    dictionaryEntries: dictionary.length,
    observations: components[0].length,
    escaped,
  };
}

function scalarDictionary(bytes, maximumEntries) {
  const values = decodeSigned(bytes);
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const dictionary = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, maximumEntries).map(([value]) => value);
  const codes = new Map(dictionary.map((value, index) => [value, index + 1]));
  const header = new ByteWriter();
  header.uint(values.length);
  header.uint(dictionary.length);
  for (const value of dictionary) header.sint(value);
  const codeBytes = Buffer.allocUnsafe(values.length);
  const escapes = new ByteWriter();
  let escaped = 0;
  for (let index = 0; index < values.length; index += 1) {
    const code = codes.get(values[index]) ?? 0;
    codeBytes[index] = code;
    if (code === 0) { escapes.sint(values[index]); escaped += 1; }
  }
  return { header: header.finish(), codes: codeBytes, escapes: escapes.finish(), values: values.length, escaped, dictionaryEntries: dictionary.length };
}

function scalarDictionaryPayload(parts, dictionaryEntries, predicate) {
  const plain = [];
  const headers = [];
  const codes = [];
  const escapes = [];
  const metrics = {};
  for (const part of parts) {
    if (!predicate(part) || part.bytes.length === 0) { plain.push(part.bytes); continue; }
    const encoded = scalarDictionary(part.bytes, dictionaryEntries);
    headers.push(encoded.header);
    codes.push(encoded.codes);
    escapes.push(encoded.escapes);
    metrics[part.name] = { values: encoded.values, escaped: encoded.escaped, dictionaryEntries: encoded.dictionaryEntries };
  }
  return { bytes: Buffer.concat([...plain, ...headers, ...codes, ...escapes]), metrics };
}

async function xzBytes(bytes, profile) {
  const directory = await mkdtemp(join(tmpdir(), 'fourcgs-v22-probe-'));
  const input = join(directory, 'payload.bin');
  try {
    await writeFile(input, bytes);
    const argumentsList = ['-f', '-k'];
    if (profile) argumentsList.push(`--lzma2=${profile}`);
    else argumentsList.push('-9e');
    argumentsList.push(input);
    await execFileAsync('xz', argumentsList, { maxBuffer: 1024 * 1024 });
    return (await readFile(`${input}.xz`)).length;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function measure(report, name, transform, payload, profile, details = {}) {
  process.stderr.write(`V2.2 probe ${name} ${transform}...\n`);
  const storedBytes = await xzBytes(payload, profile);
  report.push({ name, transform, payloadBytes: payload.length, storedBytes, ...details });
}

function tripletComponents(streams, context) { return [0, 1, 2].map((axis) => decodeSigned(streams.get(`${context}:${axis}`))); }

function currentRiceParts(name, streams, blockSize) {
  const parts = [];
  for (const [streamName, bytes] of streams) {
    let transformed = bytes;
    if (name === 'scale' && streamName === 'birth') transformed = shuffleScaleBirth(bytes);
    const residual = streamName.startsWith('boundary:') || streamName.startsWith('endpoint:') || (name === 'scale' && streamName.startsWith('internal:'));
    if (residual && transformed.length) transformed = riceEncode(transformed, blockSize);
    parts.push({ name: streamName, bytes: transformed });
  }
  return parts;
}

function currentGolombParts(name, streams, blockSize) {
  const parts = [];
  for (const [streamName, bytes] of streams) {
    let transformed = bytes;
    if (name === 'scale' && streamName === 'birth') transformed = shuffleScaleBirth(bytes);
    const residual = streamName.startsWith('boundary:') || streamName.startsWith('endpoint:') || (name === 'scale' && streamName.startsWith('internal:'));
    if (residual && transformed.length) transformed = golombEncode(transformed, blockSize);
    parts.push({ name: streamName, bytes: transformed });
  }
  return parts;
}

function currentPredictiveRiceParts(name, streams, blockSize) {
  const parts = [];
  for (const [streamName, bytes] of streams) {
    let transformed = bytes;
    if (name === 'scale' && streamName === 'birth') transformed = shuffleScaleBirth(bytes);
    const residual = streamName.startsWith('boundary:') || streamName.startsWith('endpoint:') || (name === 'scale' && streamName.startsWith('internal:'));
    if (residual && bytes.length) transformed = predictiveRiceEncode(bytes, blockSize);
    parts.push({ name: streamName, bytes: transformed });
  }
  return parts;
}

function splitRiceContexts(parts) {
  const plain = [];
  const headers = [];
  const parameters = [];
  const bits = [];
  for (const part of parts) {
    const residual = part.name.startsWith('boundary:') || part.name.startsWith('endpoint:') || part.name.startsWith('internal:');
    if (!residual || part.bytes.length === 0) { plain.push(part.bytes); continue; }
    const blockCount = part.bytes.readUInt32LE(8);
    headers.push(part.bytes.subarray(0, 16));
    parameters.push(part.bytes.subarray(16, 16 + blockCount));
    bits.push(part.bytes.subarray(16 + blockCount));
  }
  return Buffer.concat([...plain, ...headers, ...parameters, ...bits]);
}

function dcYcocgParts(streams, riceBlockSize = 0) {
  const parts = [];
  const birth = ycocgTriplets(dcBirthComponents(streams.get('birth'))).map(encodeSigned);
  parts.push({ name: 'birth', bytes: Buffer.concat(birth) });
  for (const context of ['boundary', 'endpoint', 'internal']) {
    const transformed = ycocgTriplets(tripletComponents(streams, context));
    for (let axis = 0; axis < 3; axis += 1) {
      let bytes = encodeSigned(transformed[axis]);
      if (riceBlockSize && bytes.length) bytes = riceEncode(bytes, riceBlockSize);
      parts.push({ name: `${context}:${axis}`, bytes });
    }
  }
  return parts;
}

// #WDD-gpt 2026-08-16 - V2.2 只探索 Rotation/DC/Scale 的可逆分量字典、空间差分和更细 Rice/XZ 分块，所有候选先按真实 XZ 字节数排序。
async function main() {
  const entropyPath = resolve(process.argv[2] ?? 'artifacts/compression_v2_20260816/inner_entropy_probe.json');
  const symbolDirectory = resolve(process.argv[3] ?? '/tmp/compression_v2_inner_entropy');
  const outputPath = resolve(process.argv[4] ?? 'artifacts/compression_v2_20260816/v22_rds_probe.json');
  const entropy = JSON.parse(await readFile(entropyPath, 'utf8'));
  const probes = new Map();
  for (const name of ['rotation', 'scale', 'dc']) {
    const probe = entropy.probes.find((entry) => entry.name === name);
    const streams = splitStreams(await readFile(resolve(symbolDirectory, `${name}.symbols`)), probe);
    probes.set(name, { probe, streams });
  }
  if (process.argv.includes('--emit-only')) {
    const payloadDirectory = resolve('/tmp/compression_v22_rds');
    await mkdir(payloadDirectory, { recursive: true });
    const payloads = {
      rotation_rice64: Buffer.concat(currentRiceParts('rotation', probes.get('rotation').streams, 64).map((part) => part.bytes)),
      scale_rice64: Buffer.concat(currentRiceParts('scale', probes.get('scale').streams, 64).map((part) => part.bytes)),
      dc_ycocg_r_rice32: Buffer.concat(dcYcocgParts(probes.get('dc').streams, 32).map((part) => part.bytes)),
    };
    for (const [name, bytes] of Object.entries(payloads)) await writeFile(resolve(payloadDirectory, `${name}.symbols`), bytes);
    console.log(JSON.stringify(Object.fromEntries(Object.entries(payloads).map(([name, bytes]) => [name, bytes.length])), null, 2));
    return;
  }
  if (process.argv.includes('--golomb-only')) {
    const candidates = [];
    for (const name of ['rotation', 'scale']) {
      const profile = name === 'scale' ? 'preset=9e,dict=4KiB,lc=0,lp=0,pb=0' : 'preset=9e,dict=1MiB,lc=2,lp=0,pb=0';
      for (const blockSize of [32, 64, 128, 256]) {
        const payload = Buffer.concat(currentGolombParts(name, probes.get(name).streams, blockSize).map((part) => part.bytes));
        await measure(candidates, name, `golomb${blockSize}`, payload, profile);
      }
    }
    for (const blockSize of [32, 64, 128, 256]) {
      const parts = dcYcocgParts(probes.get('dc').streams, 0).map((part) => ({
        ...part,
        bytes: part.name === 'birth' || part.bytes.length === 0 ? part.bytes : golombEncode(part.bytes, blockSize),
      }));
      await measure(candidates, 'dc', `ycocg-r-golomb${blockSize}`, Buffer.concat(parts.map((part) => part.bytes)), 'preset=9e,dict=16KiB,lc=1,lp=0,pb=0');
    }
    const summary = Object.fromEntries(['rotation', 'scale', 'dc'].map((name) => [name, candidates.filter((entry) => entry.name === name).sort((a, b) => a.storedBytes - b.storedBytes)]));
    const golombPath = resolve('artifacts/compression_v2_20260816/v22_golomb_probe.json');
    await writeFile(golombPath, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  if (process.argv.includes('--context-only')) {
    const candidates = [];
    for (const name of ['rotation', 'scale']) {
      const blockSize = 64;
      const profile = name === 'scale' ? 'preset=9e,dict=4KiB,lc=0,lp=0,pb=0' : 'preset=9e,dict=1MiB,lc=2,lp=0,pb=0';
      const parts = currentRiceParts(name, probes.get(name).streams, blockSize);
      await measure(candidates, name, `rice${blockSize}-context-split`, splitRiceContexts(parts), profile);
      const residual = parts.filter((part) => part.name.startsWith('boundary:') || part.name.startsWith('endpoint:') || part.name.startsWith('internal:'));
      const nonResidual = parts.filter((part) => !residual.includes(part));
      let separate = await xzBytes(Buffer.concat(nonResidual.map((part) => part.bytes)), profile);
      const split = splitRiceContexts(residual);
      separate += await xzBytes(split, profile);
      candidates.push({ name, transform: `rice${blockSize}-plain-and-residual-xz`, payloadBytes: parts.reduce((sum, part) => sum + part.bytes.length, 0), storedBytes: separate, blocks: 2 });
    }
    const dcParts = dcYcocgParts(probes.get('dc').streams, 32);
    const dcProfile = 'preset=9e,dict=16KiB,lc=1,lp=0,pb=0';
    await measure(candidates, 'dc', 'ycocg-r-rice32-context-split', splitRiceContexts(dcParts), dcProfile);
    const summary = Object.fromEntries(['rotation', 'scale', 'dc'].map((name) => [name, candidates.filter((entry) => entry.name === name).sort((a, b) => a.storedBytes - b.storedBytes)]));
    const contextPath = resolve('artifacts/compression_v2_20260816/v22_context_probe.json');
    await writeFile(contextPath, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  if (process.argv.includes('--scalar-only')) {
    const candidates = [];
    for (const name of ['rotation', 'scale']) {
      const streams = probes.get(name).streams;
      const parts = [...streams].map(([partName, bytes]) => ({ name: partName, bytes: name === 'scale' && partName === 'birth' ? shuffleScaleBirth(bytes) : bytes }));
      const profile = name === 'scale' ? 'preset=9e,dict=4KiB,lc=0,lp=0,pb=0' : 'preset=9e,dict=1MiB,lc=2,lp=0,pb=0';
      for (const dictionaryEntries of [31, 63, 127, 255]) {
        const encoded = scalarDictionaryPayload(parts, dictionaryEntries, (part) => part.name.startsWith('boundary:') || part.name.startsWith('endpoint:') || part.name.startsWith('internal:'));
        await measure(candidates, name, `scalar-dictionary-${dictionaryEntries}`, encoded.bytes, profile, { streams: encoded.metrics });
      }
    }
    const dcParts = dcYcocgParts(probes.get('dc').streams, 0);
    for (const dictionaryEntries of [31, 63, 127, 255]) {
      const encoded = scalarDictionaryPayload(dcParts, dictionaryEntries, () => true);
      await measure(candidates, 'dc', `ycocg-scalar-dictionary-${dictionaryEntries}`, encoded.bytes, 'preset=9e,dict=16KiB,lc=1,lp=0,pb=0', { streams: encoded.metrics });
    }
    const summary = Object.fromEntries(['rotation', 'scale', 'dc'].map((name) => [name, candidates.filter((entry) => entry.name === name).sort((a, b) => a.storedBytes - b.storedBytes)]));
    const scalarPath = resolve('artifacts/compression_v2_20260816/v22_scalar_dictionary_probe.json');
    await writeFile(scalarPath, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  if (process.argv.includes('--predictive-only')) {
    const candidates = [];
    for (const name of ['rotation', 'scale']) {
      const profile = name === 'scale' ? 'preset=9e,dict=4KiB,lc=0,lp=0,pb=0' : 'preset=9e,dict=1MiB,lc=2,lp=0,pb=0';
      for (const blockSize of [32, 64, 128, 256]) {
        const parts = currentPredictiveRiceParts(name, probes.get(name).streams, blockSize);
        await measure(candidates, name, `predictive-rice${blockSize}-context-split`, splitRiceContexts(parts), profile);
      }
    }
    const dcSourceParts = dcYcocgParts(probes.get('dc').streams, 0);
    for (const blockSize of [32, 64, 128, 256]) {
      const parts = dcSourceParts.map((part) => ({
        ...part,
        bytes: part.name === 'birth' || part.bytes.length === 0 ? part.bytes : predictiveRiceEncode(part.bytes, blockSize),
      }));
      await measure(candidates, 'dc', `ycocg-predictive-rice${blockSize}-context-split`, splitRiceContexts(parts), 'preset=9e,dict=16KiB,lc=1,lp=0,pb=0');
    }
    const summary = Object.fromEntries(['rotation', 'scale', 'dc'].map((name) => [name, candidates.filter((entry) => entry.name === name).sort((a, b) => a.storedBytes - b.storedBytes)]));
    const predictivePath = resolve('artifacts/compression_v2_20260816/v22_predictive_rice_probe.json');
    await writeFile(predictivePath, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const report = [];

  for (const name of ['rotation', 'scale']) {
    const { streams } = probes.get(name);
    const profile = name === 'scale' ? 'preset=9e,dict=4KiB,lc=0,lp=0,pb=0' : null;
    for (const blockSize of [32, 64, 128, 256, 512]) {
      const parts = currentRiceParts(name, streams, blockSize);
      await measure(report, name, `rice${blockSize}`, Buffer.concat(parts.map((part) => part.bytes)), profile);
    }
    const deltaParts = [];
    for (const [streamName, bytes] of streams) {
      let transformed = bytes;
      if (name === 'scale' && streamName === 'birth') transformed = shuffleScaleBirth(bytes);
      const residual = streamName.startsWith('boundary:') || streamName.startsWith('endpoint:') || (name === 'scale' && streamName.startsWith('internal:'));
      if (residual && transformed.length) transformed = riceEncode(differenceSigned(transformed), 128);
      deltaParts.push(transformed);
    }
    await measure(report, name, 'spatial-delta-rice128', Buffer.concat(deltaParts), profile);
    for (const maximumEntries of [63, 255, 1023]) {
      const parts = [];
      const details = {};
      parts.push(name === 'scale' ? shuffleScaleBirth(streams.get('birth')) : streams.get('birth'));
      for (const context of name === 'scale' ? ['boundary', 'endpoint', 'internal'] : ['boundary', 'endpoint']) {
        const dictionary = vectorDictionary(tripletComponents(streams, context), maximumEntries);
        parts.push(dictionary.bytes);
        details[context] = { dictionaryEntries: dictionary.dictionaryEntries, observations: dictionary.observations, escaped: dictionary.escaped };
      }
      if (name === 'rotation') parts.push(streams.get('exceptions'));
      await measure(report, name, `vector-dictionary-${maximumEntries}`, Buffer.concat(parts), profile, { contexts: details });
    }
    const currentParts = currentRiceParts(name, streams, 256);
    let separateBytes = 0;
    for (const part of currentParts) separateBytes += await xzBytes(part.bytes, profile);
    report.push({ name, transform: 'rice256-separate-xz', payloadBytes: currentParts.reduce((sum, part) => sum + part.bytes.length, 0), storedBytes: separateBytes, blocks: currentParts.length });
  }

  const dcStreams = probes.get('dc').streams;
  const dcProfile = 'preset=9e,dict=4KiB,lc=1,lp=0,pb=0';
  for (const blockSize of [0, 32, 64, 128, 256, 512]) {
    const parts = dcYcocgParts(dcStreams, blockSize);
    await measure(report, 'dc', blockSize ? `ycocg-r-rice${blockSize}` : 'ycocg-r', Buffer.concat(parts.map((part) => part.bytes)), dcProfile);
  }
  for (const maximumEntries of [63, 255, 1023]) {
    const parts = [];
    const details = {};
    const groups = [['birth', dcBirthComponents(dcStreams.get('birth'))], ...['boundary', 'endpoint'].map((context) => [context, tripletComponents(dcStreams, context)])];
    for (const [context, components] of groups) {
      const dictionary = vectorDictionary(ycocgTriplets(components), maximumEntries);
      parts.push(dictionary.bytes);
      details[context] = { dictionaryEntries: dictionary.dictionaryEntries, observations: dictionary.observations, escaped: dictionary.escaped };
    }
    await measure(report, 'dc', `ycocg-vector-dictionary-${maximumEntries}`, Buffer.concat(parts), dcProfile, { contexts: details });
  }
  const dcCurrentParts = dcYcocgParts(dcStreams, 0);
  let dcSeparateBytes = 0;
  for (const part of dcCurrentParts) dcSeparateBytes += await xzBytes(part.bytes, dcProfile);
  report.push({ name: 'dc', transform: 'ycocg-r-separate-xz', payloadBytes: dcCurrentParts.reduce((sum, part) => sum + part.bytes.length, 0), storedBytes: dcSeparateBytes, blocks: dcCurrentParts.length });

  const summary = {
    baselines: { rotation: 10730144, scale: 18613272, dc: 7951440 },
    candidates: report,
    best: Object.fromEntries(['rotation', 'scale', 'dc'].map((name) => {
      const candidate = report.filter((entry) => entry.name === name).sort((a, b) => a.storedBytes - b.storedBytes)[0];
      return [name, candidate];
    })),
  };
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

await main();
