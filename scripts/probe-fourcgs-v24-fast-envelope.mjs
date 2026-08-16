import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import {
  constants,
  deflateRawSync,
  inflateRawSync,
  zstdCompressSync,
  zstdDecompressSync,
} from 'node:zlib';
import { decodeV22StructuredParts, decodeXzBrowser } from './fourcgs-v21-lossless-codec.mjs';
import { sha256 } from './fourcgs-prs-codec.mjs';

const TARGETS = new Set(['so3_rotation', 'tattr_scale', 'tattr_dc']);

function containerStreams(bytes) {
  const manifestBytes = bytes.readUInt32LE(8);
  const manifest = JSON.parse(bytes.subarray(12, 12 + manifestBytes).toString('utf8'));
  const streams = new Map();
  let offset = 12 + manifestBytes;
  for (const entry of manifest.streams) {
    streams.set(entry.name, bytes.subarray(offset, offset + entry.storedBytes));
    offset += entry.storedBytes;
  }
  return { manifest, streams };
}

function envelopeBlocks(encoded) {
  const directoryBytes = encoded.readUInt32LE(8);
  const metadata = JSON.parse(encoded.subarray(12, 12 + directoryBytes).toString('utf8'));
  const blocks = [];
  let offset = 12 + directoryBytes;
  for (const block of metadata.blocks) {
    blocks.push({ ...block, bytes: encoded.subarray(offset, offset + block.storedBytes) });
    offset += block.storedBytes;
  }
  return { metadata, blocks };
}

function measure(codec, raw, compress, decompress) {
  const encodeStarted = performance.now();
  const encoded = compress(raw);
  const encodeMilliseconds = performance.now() - encodeStarted;
  const decodeStarted = performance.now();
  const decoded = decompress(encoded);
  const decodeMilliseconds = performance.now() - decodeStarted;
  if (sha256(decoded) !== sha256(raw)) throw new Error(`${codec} round trip failed.`);
  return { codec, rawBytes: raw.length, storedBytes: encoded.length, encodeMilliseconds, decodeMilliseconds };
}

// #WDD-gpt 2026-08-16 - V2.4 用真实变换后负载比较浏览器原生 Deflate 与 Zstd 的码率和解码时间，禁止用理论吞吐替代实测。
async function main() {
  const sourcePath = process.argv[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16_v2_3.4cgs';
  const { streams } = containerStreams(await readFile(sourcePath));
  const results = [];
  const directResults = [];
  for (const [name, encoded] of streams) {
    if (!TARGETS.has(name)) continue;
    const envelope = envelopeBlocks(encoded);
    for (const block of envelope.blocks) {
      const xzStarted = performance.now();
      const raw = await decodeXzBrowser(block.bytes);
      const xzDecodeMilliseconds = performance.now() - xzStarted;
      if (raw.length !== block.rawBytes) throw new Error(`${name}/${block.name} raw length mismatch.`);
      const candidates = [
        measure('deflate-raw-1', raw, (value) => deflateRawSync(value, { level: 1 }), inflateRawSync),
        measure('deflate-raw-6', raw, (value) => deflateRawSync(value, { level: 6 }), inflateRawSync),
        measure('deflate-raw-9', raw, (value) => deflateRawSync(value, { level: 9 }), inflateRawSync),
        ...[3, 9, 15, 19].map((level) => measure(
          `zstd-${level}`,
          raw,
          (value) => zstdCompressSync(value, { params: { [constants.ZSTD_c_compressionLevel]: level } }),
          zstdDecompressSync,
        )),
      ];
      results.push({ name, block: block.name, xzBytes: block.storedBytes, xzDecodeMilliseconds, candidates });
      process.stderr.write(`${name}/${block.name} complete\n`);
    }
    const directStarted = performance.now();
    const direct = await decodeV22StructuredParts(name, encoded);
    const ordered = direct.metadata.streams.map((entry) => direct.streams.get(entry.name));
    const raw = Buffer.concat(ordered);
    directResults.push({
      name,
      prepareMilliseconds: performance.now() - directStarted,
      rawBytes: raw.length,
      partBytes: ordered.map((part) => part.length),
      candidates: [
        measure('deflate-raw-1', raw, (value) => deflateRawSync(value, { level: 1 }), inflateRawSync),
        measure('deflate-raw-6', raw, (value) => deflateRawSync(value, { level: 6 }), inflateRawSync),
        measure('deflate-raw-9', raw, (value) => deflateRawSync(value, { level: 9 }), inflateRawSync),
        ...[3, 9, 15, 19].map((level) => measure(
          `zstd-${level}`,
          raw,
          (value) => zstdCompressSync(value, { params: { [constants.ZSTD_c_compressionLevel]: level } }),
          zstdDecompressSync,
        )),
      ],
    });
  }
  console.log(JSON.stringify({ sourcePath, results, directResults }, null, 2));
}

await main();
