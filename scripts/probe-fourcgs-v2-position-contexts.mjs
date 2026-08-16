import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

class ByteReader {
  constructor(bytes) { this.bytes = bytes; this.offset = 0; }
  byte() { if (this.offset >= this.bytes.length) throw new Error('Unexpected Position stream end.'); return this.bytes[this.offset++]; }
  uint() {
    let value = 0;
    let multiplier = 1;
    for (let index = 0; index < 8; index += 1) {
      const byte = this.byte();
      value += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) return value;
      multiplier *= 128;
    }
    throw new Error('Oversized Position varint.');
  }
  sint() { const value = this.uint(); return value & 1 ? -(value + 1) / 2 : value / 2; }
  done() { if (this.offset !== this.bytes.length) throw new Error(`Unused Position bytes: ${this.bytes.length - this.offset}`); }
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
    let remaining = value;
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
    if (this.offset !== this.bytes.length) throw new Error('Position bit-plane size mismatch.');
    return this.bytes;
  }
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
  return entries;
}

const tripleDictionary = createTripleDictionary(7);

function readTriple(reader) {
  const code = reader.uint();
  return { code, values: code === 0 ? [reader.sint(), reader.sint(), reader.sint()] : tripleDictionary[code - 1] };
}

function readContainerManifest(container) {
  const bytes = container.readUInt32LE(8);
  return JSON.parse(container.subarray(12, 12 + bytes).toString('utf8'));
}

function entropyBytes(counts, total) {
  let bits = 0;
  for (const count of counts) if (count) bits -= count * Math.log2(count / total);
  return bits / 8;
}

// #WDD-gpt 2026-08-16 - 将 Position 的层元数据、字典索引、逃逸值和 XYZ 残差拆成独立上下文，实测结构化熵编码的无损收益。
async function main() {
  const symbolPath = resolve(process.argv[2] ?? '/tmp/compression_v2_inner_entropy/position.symbols');
  const entropyReportPath = resolve(process.argv[3] ?? 'artifacts/compression_v2_20260816/inner_entropy_probe.json');
  const containerPath = resolve(process.argv[4] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16_attribute_so3_hybrid_lossless_v2.4cgs');
  const outputDirectory = resolve(process.argv[5] ?? '/tmp/compression_v2_position_contexts');
  const entropyReport = JSON.parse(await readFile(entropyReportPath, 'utf8'));
  const positionProbe = entropyReport.probes.find((probe) => probe.name === 'position');
  const mainBytes = positionProbe.streams.find((stream) => stream.name === 'main').rawBytes;
  const symbols = await readFile(symbolPath);
  const main = symbols.subarray(0, mainBytes);
  const exceptions = symbols.subarray(mainBytes);
  const manifest = readContainerManifest(await readFile(containerPath));
  const reader = new ByteReader(main);
  const metadata = new ByteWriter();
  const dictionaryCodes = new ByteWriter();
  const escape = [new ByteWriter(), new ByteWriter(), new ByteWriter()];
  const components = [new ByteWriter(), new ByteWriter(), new ByteWriter()];
  const layerCount = reader.uint();
  metadata.uint(layerCount);
  let decodedLayers = 0;
  let residualCount = 0;
  let escapeCount = 0;
  const expectedResiduals = manifest.segments.reduce((sum, segment) => sum + segment.gaussianCount * segment.bankCounts.position, 0);
  const codeLow = Buffer.allocUnsafe(expectedResiduals);
  const codeHigh = Buffer.allocUnsafe(expectedResiduals);
  const codeLow7 = new BitWriter(expectedResiduals * 7);
  const codeHigh7 = Buffer.allocUnsafe(expectedResiduals);
  const codeCounts = new Uint32Array(tripleDictionary.length + 1);
  const escapeCounts = [new Map(), new Map(), new Map()];
  for (const segment of manifest.segments) {
    for (let bank = 0; bank < segment.bankCounts.position; bank += 1) {
      for (let axis = 0; axis < 3; axis += 1) metadata.sint(reader.sint());
      const cellCount = reader.uint();
      metadata.uint(cellCount);
      for (let cell = 0; cell < cellCount; cell += 1) {
        metadata.uint(reader.uint());
        const triple = readTriple(reader);
        metadata.uint(triple.code);
        if (triple.code === 0) for (let axis = 0; axis < 3; axis += 1) metadata.sint(triple.values[axis]);
      }
      for (let row = 0; row < segment.gaussianCount; row += 1) {
        const triple = readTriple(reader);
        dictionaryCodes.uint(triple.code);
        codeLow[residualCount] = triple.code & 0xff;
        codeHigh[residualCount] = triple.code >>> 8;
        codeLow7.write(triple.code & 0x7f, 7);
        codeHigh7[residualCount] = triple.code >>> 7;
        codeCounts[triple.code] += 1;
        if (triple.code === 0) {
          for (let axis = 0; axis < 3; axis += 1) {
            escape[axis].sint(triple.values[axis]);
            escapeCounts[axis].set(triple.values[axis], (escapeCounts[axis].get(triple.values[axis]) ?? 0) + 1);
          }
          escapeCount += 1;
        }
        for (let axis = 0; axis < 3; axis += 1) components[axis].sint(triple.values[axis]);
        residualCount += 1;
      }
      decodedLayers += 1;
    }
  }
  reader.done();
  if (decodedLayers !== layerCount) throw new Error(`Position layer mismatch: ${decodedLayers} != ${layerCount}`);
  if (residualCount !== expectedResiduals) throw new Error(`Position residual mismatch: ${residualCount} != ${expectedResiduals}`);
  const metadataBytes = metadata.finish();
  const codeBytes = dictionaryCodes.finish();
  const escapeBytes = escape.map((writer) => writer.finish());
  const componentBytes = components.map((writer) => writer.finish());
  const candidates = {
    dictionary_contexts: Buffer.concat([metadataBytes, codeBytes, ...escapeBytes, exceptions]),
    dictionary_uint16_byteplanes: Buffer.concat([metadataBytes, codeLow, codeHigh, ...escapeBytes, exceptions]),
    dictionary_low7_highbyte: Buffer.concat([metadataBytes, codeLow7.finish(), codeHigh7, ...escapeBytes, exceptions]),
    xyz_component_contexts: Buffer.concat([metadataBytes, ...componentBytes, exceptions]),
  };
  await mkdir(outputDirectory, { recursive: true });
  const partDirectory = resolve(outputDirectory, 'parts');
  await mkdir(partDirectory, { recursive: true });
  await writeFile(resolve(partDirectory, 'metadata.varint'), metadataBytes);
  await writeFile(resolve(partDirectory, 'dictionary_codes.varint'), codeBytes);
  for (let axis = 0; axis < 3; axis += 1) await writeFile(resolve(partDirectory, `escape_${axis}.varint`), escapeBytes[axis]);
  await writeFile(resolve(partDirectory, 'exceptions.varint'), exceptions);
  const report = {
    sourceMainBytes: main.length,
    sourceExceptionBytes: exceptions.length,
    layerCount,
    residualCount,
    escapeCount,
    theoreticalZeroOrderBytes: {
      dictionaryCodes: entropyBytes(codeCounts, residualCount),
      escapeComponents: escapeCounts.map((counts) => entropyBytes(counts.values(), escapeCount)),
    },
    contexts: {
      metadataBytes: metadataBytes.length,
      dictionaryCodeBytes: codeBytes.length,
      escapeComponentBytes: escapeBytes.map((bytes) => bytes.length),
      residualComponentBytes: componentBytes.map((bytes) => bytes.length),
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
