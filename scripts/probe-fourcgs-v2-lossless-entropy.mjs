import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants,
  deflateSync,
  inflateSync,
} from 'node:zlib';
import { decodeRans, sha256 } from './fourcgs-prs-codec.mjs';

const CONTAINER_MAGIC = '4CGSPRS2';

function unshuffle16(shuffled) {
  if (shuffled.length % 2 !== 0) throw new Error('FP16 byte unshuffle requires an even byte count.');
  const raw = Buffer.allocUnsafe(shuffled.length);
  const values = shuffled.length / 2;
  for (let index = 0; index < values; index += 1) {
    raw[index * 2] = shuffled[index];
    raw[index * 2 + 1] = shuffled[values + index];
  }
  return raw;
}

function restore(entry, stored) {
  if (entry.compression === 'raw') return stored;
  if (entry.compression === 'deflate') return inflateSync(stored);
  if (entry.compression === 'brotli') return brotliDecompressSync(stored);
  if (entry.compression === 'brotli-shuffle16') return unshuffle16(brotliDecompressSync(stored));
  throw new Error(`Unsupported outer compression ${entry.compression}.`);
}

function unpackEntropyPair(encoded, magic) {
  if (encoded.subarray(0, 8).toString('ascii') !== magic) throw new Error(`Invalid ${magic} stream.`);
  const mainBytes = encoded.readUInt32LE(8);
  const exceptionBytes = encoded.readUInt32LE(12);
  if (16 + mainBytes + exceptionBytes !== encoded.length) throw new Error(`Invalid ${magic} byte count.`);
  return [
    { name: 'main', encodedBytes: mainBytes, raw: decodeRans(encoded.subarray(16, 16 + mainBytes)) },
    { name: 'exceptions', encodedBytes: exceptionBytes, raw: decodeRans(encoded.subarray(16 + mainBytes)) },
  ];
}

function unpackDirectoryRans(encoded, magic) {
  if (encoded.subarray(0, 8).toString('ascii') !== magic) throw new Error(`Invalid ${magic} stream.`);
  const directoryBytes = encoded.readUInt32LE(8);
  const metadata = JSON.parse(encoded.subarray(12, 12 + directoryBytes).toString('utf8'));
  let offset = 12 + directoryBytes;
  const streams = metadata.streams.map((entry) => {
    const bytes = encoded.subarray(offset, offset + entry.bytes);
    offset += entry.bytes;
    return { name: entry.name, encodedBytes: entry.bytes, raw: decodeRans(bytes) };
  });
  if (offset !== encoded.length) throw new Error(`${magic} has ${encoded.length - offset} trailing bytes.`);
  return streams;
}

function framingBytes(name, streams) {
  return Buffer.byteLength(JSON.stringify({
    codec: 'single-lossless-frame',
    source: name,
    streams: streams.map((stream) => ({ name: stream.name, rawBytes: stream.raw.length })),
  }), 'utf8') + 12;
}

function brotli(raw, quality) {
  return brotliCompressSync(raw, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: quality,
      [constants.BROTLI_PARAM_LGWIN]: 24,
      [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  });
}

function benchmark(name, currentBytes, streams, brotliQuality) {
  const concatenated = Buffer.concat(streams.map((stream) => stream.raw));
  const frameBytes = framingBytes(name, streams);
  const deflate = deflateSync(concatenated, { level: 9 });
  const brotliEncoded = brotli(concatenated, brotliQuality);
  return {
    name,
    currentBytes,
    symbolBytes: concatenated.length,
    framingBytes: frameBytes,
    streams: streams.map((stream) => ({
      name: stream.name,
      rawBytes: stream.raw.length,
      currentRansBytes: stream.encodedBytes,
    })),
    candidates: {
      deflate9: frameBytes + deflate.length,
      [`brotli${brotliQuality}`]: frameBytes + brotliEncoded.length,
    },
    payloads: { concatenated, deflate, brotli: brotliEncoded },
  };
}

function withoutPayloads(result) {
  const { payloads, ...summary } = result;
  summary.candidates = Object.fromEntries(Object.entries(summary.candidates).map(([codec, bytes]) => [codec, {
    bytes,
    savingsBytes: summary.currentBytes - bytes,
    savingsRatio: 1 - bytes / summary.currentBytes,
  }]));
  return summary;
}

// #WDD-gpt 2026-08-16 - 解开 V2 内层静态 rANS 并实测更强通用无损编码，给 60M 目标建立真实熵上限而不是估算。
async function main() {
  const sourcePath = resolve(process.argv[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16_attribute_so3_hybrid_lossless_v2.4cgs');
  const outputDirectory = resolve(process.argv[3] ?? '/tmp/compression_v2_inner_entropy');
  const reportPath = resolve(process.argv[4] ?? 'artifacts/compression_v2_20260816/inner_entropy_probe.json');
  const brotliQuality = Number(process.argv[5] ?? 9);
  if (!Number.isInteger(brotliQuality) || brotliQuality < 0 || brotliQuality > 11) throw new Error('Brotli quality must be 0..11.');

  const container = await readFile(sourcePath);
  if (container.subarray(0, 8).toString('ascii') !== CONTAINER_MAGIC) throw new Error('Unsupported 4CGS container.');
  const manifestBytes = container.readUInt32LE(8);
  const manifest = JSON.parse(container.subarray(12, 12 + manifestBytes).toString('utf8'));
  const rawStreams = new Map();
  let offset = 12 + manifestBytes;
  for (const entry of manifest.streams) {
    const stored = container.subarray(offset, offset + entry.storedBytes);
    const raw = restore(entry, stored);
    if (raw.length !== entry.rawBytes || sha256(raw) !== entry.rawSha256) throw new Error(`Outer stream validation failed: ${entry.name}`);
    rawStreams.set(entry.name, raw);
    offset += entry.storedBytes;
  }
  if (offset !== container.length) throw new Error(`Container has ${container.length - offset} trailing bytes.`);

  const probes = [
    benchmark('position', rawStreams.get('prs_position').length, unpackEntropyPair(rawStreams.get('prs_position'), 'P3DPR001'), brotliQuality),
    benchmark('rotation', rawStreams.get('so3_rotation').length, unpackDirectoryRans(rawStreams.get('so3_rotation'), 'SO3TR001'), brotliQuality),
    benchmark('scale', rawStreams.get('tattr_scale').length, unpackDirectoryRans(rawStreams.get('tattr_scale'), 'TATTR001'), brotliQuality),
    benchmark('dc', rawStreams.get('tattr_dc').length, unpackDirectoryRans(rawStreams.get('tattr_dc'), 'TATTR001'), brotliQuality),
  ];

  await mkdir(outputDirectory, { recursive: true });
  await mkdir(resolve(reportPath, '..'), { recursive: true });
  for (const probe of probes) {
    await writeFile(resolve(outputDirectory, `${probe.name}.symbols`), probe.payloads.concatenated);
    await writeFile(resolve(outputDirectory, `${probe.name}.deflate9`), probe.payloads.deflate);
    await writeFile(resolve(outputDirectory, `${probe.name}.brotli${brotliQuality}`), probe.payloads.brotli);
  }
  for (const name of ['mixsc_opacity', 'coresh5r_shared']) {
    await writeFile(resolve(outputDirectory, `${name}.encoded`), rawStreams.get(name));
  }

  const summary = {
    sourcePath,
    sourceFile: basename(sourcePath),
    sourceBytes: container.length,
    sourceSha256: sha256(container),
    brotliQuality,
    outputDirectory,
    probes: probes.map(withoutPayloads),
  };
  await writeFile(reportPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

await main();
