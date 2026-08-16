import { brotliDecompressSync, inflateSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { sha256 } from './fourcgs-prs-codec.mjs';
import { decodeV21StructuredStream, encodeV21StructuredStream } from './fourcgs-v21-lossless-codec.mjs';

const MAGIC = '4CGSPRS2';
const TARGET_STREAMS = new Set(['prs_position', 'so3_rotation', 'tattr_scale', 'tattr_dc']);

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

function readContainer(bytes) {
  if (bytes.subarray(0, 8).toString('ascii') !== MAGIC) throw new Error('Unsupported 4CGS source.');
  const manifestBytes = bytes.readUInt32LE(8);
  const manifest = JSON.parse(bytes.subarray(12, 12 + manifestBytes).toString('utf8'));
  const stored = new Map();
  const raw = new Map();
  let offset = 12 + manifestBytes;
  for (const entry of manifest.streams) {
    const payload = bytes.subarray(offset, offset + entry.storedBytes);
    if (payload.length !== entry.storedBytes || sha256(payload) !== entry.storedSha256) throw new Error(`Stored stream validation failed: ${entry.name}.`);
    let decoded;
    if (entry.compression === 'deflate') decoded = inflateSync(payload);
    else if (entry.compression === 'brotli') decoded = brotliDecompressSync(payload);
    else if (entry.compression === 'brotli-shuffle16') decoded = unshuffle16(brotliDecompressSync(payload));
    else decoded = payload;
    if (decoded.length !== entry.rawBytes || sha256(decoded) !== entry.rawSha256) throw new Error(`Raw stream validation failed: ${entry.name}.`);
    stored.set(entry.name, payload);
    raw.set(entry.name, decoded);
    offset += entry.storedBytes;
  }
  if (offset !== bytes.length) throw new Error(`Unexpected source trailing bytes: ${bytes.length - offset}.`);
  return { manifest, stored, raw };
}

function packContainer(manifest, streams) {
  const directory = Buffer.from(JSON.stringify(manifest), 'utf8');
  const prefix = Buffer.alloc(12);
  prefix.write(MAGIC, 0, 'ascii');
  prefix.writeUInt32LE(directory.length, 8);
  return Buffer.concat([prefix, directory, ...manifest.streams.map((entry) => streams.get(entry.name))]);
}

// #WDD-gpt 2026-08-16 - 将 68M 级结构化熵探针落成可解码 V2.1 容器，并在写包前用浏览器 WASM 路径逐流还原 V2 哈希。
async function main() {
  const sourcePath = resolve(process.argv[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16_attribute_so3_hybrid_lossless_v2.4cgs');
  const outputPath = resolve(process.argv[3] ?? 'artifacts/compression_v2_20260816/collected_master_ply4_cleaned_fp16_lossless_v2_1.4cgs');
  const reportPath = `${outputPath}.repack.json`;
  const sourceBytes = await readFile(sourcePath);
  const source = readContainer(sourceBytes);
  const outputStreams = new Map();
  const metrics = [];
  for (const entry of source.manifest.streams) {
    if (!TARGET_STREAMS.has(entry.name)) {
      outputStreams.set(entry.name, source.stored.get(entry.name));
      metrics.push({ name: entry.name, sourceBytes: entry.storedBytes, storedBytes: entry.storedBytes, ratio: 1, preservedStoredBytes: true });
      continue;
    }
    process.stderr.write(`V2.1 encode ${entry.name}...\n`);
    const result = await encodeV21StructuredStream(entry.name, source.raw.get(entry.name), source.manifest);
    const restored = await decodeV21StructuredStream(entry.name, result.encoded, source.manifest);
    if (!restored.equals(source.raw.get(entry.name))) throw new Error(`V2.1 byte verification failed: ${entry.name}.`);
    outputStreams.set(entry.name, result.encoded);
    metrics.push({ ...result.metrics, reconstructedSha256: sha256(restored), byteExactToV2InnerStream: true });
  }
  const nextManifest = {
    ...source.manifest,
    codecName: `${source.manifest.codecName}-V21StructuredXz`,
    losslessV21: {
      version: 1,
      parentContainer: sourcePath,
      parentSha256: sha256(sourceBytes),
      targetStreams: [...TARGET_STREAMS],
      invariant: 'Decoded inner streams are byte-identical to V2 before attribute reconstruction.',
      browserDecoder: 'xzwasm 0.1.2 with immediate chunk copies',
    },
    streams: source.manifest.streams.map((entry) => {
      if (!TARGET_STREAMS.has(entry.name)) return entry;
      const payload = outputStreams.get(entry.name);
      return {
        ...entry,
        compression: 'raw',
        rawBytes: payload.length,
        rawSha256: sha256(payload),
        storedBytes: payload.length,
        storedSha256: sha256(payload),
        v21DecodedBytes: entry.rawBytes,
        v21DecodedSha256: entry.rawSha256,
      };
    }),
  };
  const container = packContainer(nextManifest, outputStreams);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, container);
  const report = {
    sourcePath,
    sourceBytes: sourceBytes.length,
    sourceBytesM: sourceBytes.length / 1_000_000,
    sourceSha256: sha256(sourceBytes),
    outputPath,
    outputBytes: container.length,
    outputBytesM: container.length / 1_000_000,
    outputSha256: sha256(container),
    ratioToSourceContainer: sourceBytes.length / container.length,
    metrics,
    allTargetStreamsByteExactToV2InnerStream: metrics.filter((entry) => TARGET_STREAMS.has(entry.name)).every((entry) => entry.byteExactToV2InnerStream),
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}

await main();
