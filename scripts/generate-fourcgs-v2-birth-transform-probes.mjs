import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

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
    while (remaining >= 128) {
      this.byte((remaining % 128) | 0x80);
      remaining = Math.floor(remaining / 128);
    }
    this.byte(remaining);
  }

  sint(value) {
    this.uint(value >= 0 ? value * 2 : -value * 2 - 1);
  }

  flush() {
    if (this.offset > 0) this.chunks.push(this.chunk.subarray(0, this.offset));
    this.chunk = Buffer.allocUnsafe(this.chunkBytes);
    this.offset = 0;
  }

  finish() {
    this.flush();
    return Buffer.concat(this.chunks, this.length);
  }
}

function readSint(bytes) {
  const values = [];
  let offset = 0;
  while (offset < bytes.length) {
    let code = 0;
    let multiplier = 1;
    for (;;) {
      const byte = bytes[offset++];
      code += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) break;
      multiplier *= 128;
    }
    values.push(code & 1 ? -(code + 1) / 2 : code / 2);
  }
  return values;
}

function encodeSint(values) {
  const writer = new ByteWriter();
  for (const value of values) writer.sint(value);
  return writer.finish();
}

function modulo16(value) {
  return value & 0xffff;
}

function encodeUint16Planes(planes, byteShuffle) {
  const values = planes.reduce((sum, plane) => sum + plane.length, 0);
  const output = Buffer.allocUnsafe(values * 2);
  let ordinal = 0;
  for (const plane of planes) {
    for (const value of plane) {
      if (byteShuffle) {
        output[ordinal] = value & 0xff;
        output[values + ordinal] = value >>> 8;
      } else {
        output.writeUInt16LE(value, ordinal * 2);
      }
      ordinal += 1;
    }
  }
  return output;
}

function halfBirthCandidates(raw) {
  if (raw.length % 6 !== 0) throw new Error('Scale birth is not an XYZ uint16 sequence.');
  const count = raw.length / 6;
  const xyz = [new Uint16Array(count), new Uint16Array(count), new Uint16Array(count)];
  for (let index = 0; index < count; index += 1) {
    for (let axis = 0; axis < 3; axis += 1) xyz[axis][index] = raw.readUInt16LE((index * 3 + axis) * 2);
  }
  const lifted = [new Uint16Array(count), new Uint16Array(count), new Uint16Array(count)];
  const delta = [new Uint16Array(count), new Uint16Array(count), new Uint16Array(count)];
  for (let index = 0; index < count; index += 1) {
    lifted[0][index] = xyz[1][index];
    lifted[1][index] = modulo16(xyz[0][index] - xyz[1][index]);
    lifted[2][index] = modulo16(xyz[2][index] - xyz[1][index]);
    for (let axis = 0; axis < 3; axis += 1) {
      delta[axis][index] = modulo16(lifted[axis][index] - (index ? lifted[axis][index - 1] : 0));
    }
  }
  return {
    plane16: encodeUint16Planes(xyz, false),
    plane16_shuffle: encodeUint16Planes(xyz, true),
    isotropic16: encodeUint16Planes(lifted, false),
    isotropic16_shuffle: encodeUint16Planes(lifted, true),
    isotropic_spatial_delta16: encodeUint16Planes(delta, false),
    isotropic_spatial_delta16_shuffle: encodeUint16Planes(delta, true),
  };
}

function dcBirthCandidates(raw) {
  const values = readSint(raw);
  if (values.length % 3 !== 0) throw new Error('DC birth is not an XYZ signed-varint sequence.');
  const count = values.length / 3;
  const planes = [new Array(count), new Array(count), new Array(count)];
  const lifted = [new Array(count), new Array(count), new Array(count)];
  const ycocg = [new Array(count), new Array(count), new Array(count)];
  const delta = [new Array(count), new Array(count), new Array(count)];
  for (let index = 0; index < count; index += 1) {
    const x = values[index * 3];
    const y = values[index * 3 + 1];
    const z = values[index * 3 + 2];
    planes[0][index] = x;
    planes[1][index] = y;
    planes[2][index] = z;
    lifted[0][index] = y;
    lifted[1][index] = x - y;
    lifted[2][index] = z - y;
    const co = x - z;
    const temporary = z + (co >> 1);
    const cg = y - temporary;
    ycocg[0][index] = temporary + (cg >> 1);
    ycocg[1][index] = co;
    ycocg[2][index] = cg;
    for (let axis = 0; axis < 3; axis += 1) {
      delta[axis][index] = lifted[axis][index] - (index ? lifted[axis][index - 1] : 0);
    }
  }
  return {
    plane_varint: Buffer.concat(planes.map(encodeSint)),
    isotropic_varint: Buffer.concat(lifted.map(encodeSint)),
    ycocg_r_varint: Buffer.concat(ycocg.map(encodeSint)),
    isotropic_spatial_delta_varint: Buffer.concat(delta.map(encodeSint)),
  };
}

function transformTripletStreams(streams, context, transform) {
  const source = [0, 1, 2].map((axis) => readSint(streams.get(`${context}:${axis}`)));
  if (source[0].length !== source[1].length || source[0].length !== source[2].length) {
    throw new Error(`${context} component counts do not match.`);
  }
  const output = [new Array(source[0].length), new Array(source[0].length), new Array(source[0].length)];
  for (let index = 0; index < source[0].length; index += 1) {
    const x = source[0][index];
    const y = source[1][index];
    const z = source[2][index];
    if (transform === 'isotropic') {
      output[0][index] = y;
      output[1][index] = x - y;
      output[2][index] = z - y;
    } else if (transform === 'ycocg-r') {
      const co = x - z;
      const temporary = z + (co >> 1);
      const cg = y - temporary;
      output[0][index] = temporary + (cg >> 1);
      output[1][index] = co;
      output[2][index] = cg;
    } else {
      throw new Error(`Unsupported triplet transform ${transform}.`);
    }
  }
  return new Map(output.map((values, axis) => [`${context}:${axis}`, encodeSint(values)]));
}

function payloadWithReplacements(probe, streams, replacements) {
  return Buffer.concat(probe.streams.map((stream) => replacements.get(stream.name) ?? streams.get(stream.name)));
}

function splitStreams(symbols, probe) {
  const result = new Map();
  let offset = 0;
  for (const stream of probe.streams) {
    result.set(stream.name, symbols.subarray(offset, offset + stream.rawBytes));
    offset += stream.rawBytes;
  }
  if (offset !== symbols.length) throw new Error(`${probe.name} symbol layout mismatch.`);
  return result;
}

// #WDD-gpt 2026-08-16 - 试验 Morton Track 顺序上的可逆分量提升和空间差分，单独量化 Scale/DC 出生值还能释放多少无损冗余。
async function main() {
  const reportPath = resolve(process.argv[2] ?? 'artifacts/compression_v2_20260816/inner_entropy_probe.json');
  const symbolDirectory = resolve(process.argv[3] ?? '/tmp/compression_v2_inner_entropy');
  const outputDirectory = resolve(process.argv[4] ?? '/tmp/compression_v2_birth_transforms');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  await mkdir(outputDirectory, { recursive: true });
  const summary = [];

  for (const name of ['scale', 'dc']) {
    const probe = report.probes.find((entry) => entry.name === name);
    const symbols = await readFile(resolve(symbolDirectory, `${name}.symbols`));
    const streams = splitStreams(symbols, probe);
    const candidates = name === 'scale' ? halfBirthCandidates(streams.get('birth')) : dcBirthCandidates(streams.get('birth'));
    const suffix = Buffer.concat(probe.streams.slice(1).map((stream) => streams.get(stream.name)));
    for (const [transform, birth] of Object.entries(candidates)) {
      const payload = Buffer.concat([birth, suffix]);
      const path = resolve(outputDirectory, `${name}_${transform}.symbols`);
      await writeFile(path, payload);
      summary.push({ name, transform, birthBytes: birth.length, payloadBytes: payload.length, path });
    }

    const residualTransform = name === 'scale' ? 'isotropic' : 'ycocg-r';
    const contexts = name === 'scale' ? ['boundary', 'endpoint', 'internal'] : ['boundary', 'endpoint'];
    const replacements = new Map();
    const transformedBirth = name === 'scale' ? candidates.plane16_shuffle : candidates.ycocg_r_varint;
    replacements.set('birth', transformedBirth);
    for (const context of contexts) {
      for (const [streamName, bytes] of transformTripletStreams(streams, context, residualTransform)) replacements.set(streamName, bytes);
    }
    const payload = payloadWithReplacements(probe, streams, replacements);
    const transform = name === 'scale' ? 'plane16_shuffle_plus_residual_isotropic' : 'ycocg_r_birth_and_residual';
    const path = resolve(outputDirectory, `${name}_${transform}.symbols`);
    await writeFile(path, payload);
    summary.push({ name, transform, birthBytes: transformedBirth.length, payloadBytes: payload.length, path });
  }

  const summaryPath = resolve(outputDirectory, 'manifest.json');
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ summaryPath, candidates: summary }, null, 2));
}

await main();
