import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

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

function decodeUnsignedVarints(bytes) {
  const values = [];
  let offset = 0;
  while (offset < bytes.length) {
    let value = 0;
    let multiplier = 1;
    for (;;) {
      const byte = bytes[offset++];
      value += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) break;
      multiplier *= 128;
    }
    values.push(value);
  }
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

class PackedBits {
  constructor(bits) { this.bytes = Buffer.alloc(Math.ceil(bits / 8)); this.bitOffset = 0; }
  unary(zeros) {
    this.bitOffset += zeros;
    this.bytes[this.bitOffset >>> 3] |= 1 << (this.bitOffset & 7);
    this.bitOffset += 1;
  }
  write(value, bits) {
    for (let bit = 0; bit < bits; bit += 1) {
      if ((value & (2 ** bit)) !== 0) this.bytes[this.bitOffset >>> 3] |= 1 << (this.bitOffset & 7);
      this.bitOffset += 1;
    }
  }
}

function riceEncode(bytes, blockSize) {
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
  if (writer.bitOffset !== totalBits) throw new Error('Rice bit count mismatch.');
  const header = Buffer.alloc(16);
  header.writeUInt32LE(values.length, 0);
  header.writeUInt32LE(blockSize, 4);
  header.writeUInt32LE(blockCount, 8);
  header.writeUInt32LE(totalBits, 12);
  return Buffer.concat([header, parameters, writer.bytes]);
}

function shuffleScaleBirth(raw) {
  if (raw.length % 6 !== 0) throw new Error('Scale birth is not XYZ FP16.');
  const count = raw.length / 6;
  const output = Buffer.allocUnsafe(raw.length);
  let ordinal = 0;
  for (let axis = 0; axis < 3; axis += 1) {
    for (let index = 0; index < count; index += 1) {
      const value = raw.readUInt16LE((index * 3 + axis) * 2);
      output[ordinal] = value & 0xff;
      output[raw.length / 2 + ordinal] = value >>> 8;
      ordinal += 1;
    }
  }
  return output;
}

function signedVarintStream(name, attribute) {
  if (name === 'birth' || name === 'exceptions') return false;
  if (attribute === 'rotation') return name.startsWith('boundary:') || name.startsWith('endpoint:');
  return name.includes(':');
}

// #WDD-gpt 2026-08-16 - 对 Scale/DC/Rotation 的 ZigZag 残差试验分块自适应 Rice，判断专用整数熵码能否越过 XZ 上限。
async function main() {
  const entropyReportPath = resolve(process.argv[2] ?? 'artifacts/compression_v2_20260816/inner_entropy_probe.json');
  const symbolDirectory = resolve(process.argv[3] ?? '/tmp/compression_v2_inner_entropy');
  const outputDirectory = resolve(process.argv[4] ?? '/tmp/compression_v2_rice_residuals');
  const entropyReport = JSON.parse(await readFile(entropyReportPath, 'utf8'));
  const blockSizes = (process.argv[5] ?? '256,1024,4096').split(',').map(Number);
  await mkdir(outputDirectory, { recursive: true });
  const report = [];
  for (const attribute of ['scale', 'dc', 'rotation']) {
    const probe = entropyReport.probes.find((entry) => entry.name === attribute);
    const symbols = await readFile(resolve(symbolDirectory, `${attribute}.symbols`));
    const streams = splitStreams(symbols, probe);
    for (const blockSize of blockSizes) {
      const parts = [];
      const metrics = [];
      for (const stream of probe.streams) {
        let source = streams.get(stream.name);
        if (attribute === 'scale' && stream.name === 'birth') source = shuffleScaleBirth(source);
        const encoded = signedVarintStream(stream.name, attribute) && source.length
          ? riceEncode(source, blockSize)
          : source;
        parts.push(encoded);
        metrics.push({ name: stream.name, sourceBytes: source.length, encodedBytes: encoded.length });
      }
      const payload = Buffer.concat(parts);
      const path = resolve(outputDirectory, `${attribute}_rice_${blockSize}.symbols`);
      await writeFile(path, payload);
      report.push({ attribute, blockSize, sourceBytes: symbols.length, encodedBytes: payload.length, streams: metrics, path });
    }
  }
  await writeFile(resolve(outputDirectory, 'manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

await main();
