// #WDD-gpt 2026-09-20 - 仅恢复可逐字节复现的旧 fflate 零历史位图错误，不宽容解码其他损坏数据。
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { inflateSync, inflateRawSync } from 'node:zlib';
import { Zlib, zlibSync, unzlibSync } from 'fflate';
const [input, output] = process.argv.slice(2);
if (!input || !output || resolve(input) === resolve(output)) throw new Error('Usage: node scripts/repair-fourcgs-sh-zlib.mjs INPUT OUTPUT (separate files required)');
const hash = (b) => createHash('sha256').update(b).digest('hex');
const original = await readFile(input);
if (original.subarray(0, 8).toString() !== '4CGSPRS2') throw new Error('Invalid container magic');
let offset = 12 + original.readUInt32LE(8);
const manifest = JSON.parse(original.subarray(12, offset));
const payloads = [];
let repaired = false;
let report;
for (const entry of manifest.streams) {
  let stored = original.subarray(offset, offset + entry.storedBytes); offset += entry.storedBytes;
  if (stored.length !== entry.storedBytes || hash(stored) !== entry.storedSha256) throw new Error(`Stored hash mismatch: ${entry.name}`);
  if (entry.name === 'coresh5r_shared') {
    if (entry.compression !== 'raw' || stored.subarray(0, 8).toString() !== 'C5T3SH01') throw new Error('Unsupported SH payload');
    const start = 40 + stored.readUInt32LE(20) + stored.readUInt32LE(24) + stored.readUInt32LE(28);
    const end = start + stored.readUInt32LE(32);
    const broken = stored.subarray(start, end);
    let error;
    try { inflateSync(broken); } catch (e) { error = e; }
    if (!error || !error.message.includes('invalid distance too far back')) throw new Error('Payload does not match the known failure');
    const restored = inflateRawSync(broken.subarray(2, -4), { dictionary: Buffer.alloc(32768) });
    let a = 1, b = 0, count = 0;
    for (const value of restored) { a = (a + value) % 65521; b = (b + a) % 65521; for (let bit = 0; bit < 8; bit++) count += (value >>> bit) & 1; }
    if (restored.length !== Math.ceil(stored.readUInt32LE(12) / 8) || (((b << 16) | a) >>> 0) !== broken.readUInt32BE(broken.length - 4)
      || count !== manifest.compressionV26.shPolicy.exceptionCount) throw new Error('Recovered bitmap failed length/checksum/count validation');
    const chunks = []; new Zlib({ level: 9 }, (chunk) => chunks.push(Buffer.from(chunk))).push(restored, true);
    if (!Buffer.concat(chunks).equals(broken)) throw new Error('Cannot reproduce original compressed bytes exactly');
    const fixed = Buffer.from(zlibSync(restored, { level: 9 }));
    if (!inflateSync(fixed).equals(restored) || !Buffer.from(unzlibSync(fixed)).equals(restored)) throw new Error('Strict decoder roundtrip failed');
    const header = Buffer.from(stored.subarray(0, 40)); header.writeUInt32LE(fixed.length, 32);
    stored = Buffer.concat([header, stored.subarray(40, start), fixed, stored.subarray(end)]);
    let cursor = 40 + stored.readUInt32LE(20);
    for (const at of [24, 28, 32, 36]) { const length = stored.readUInt32LE(at); inflateSync(stored.subarray(cursor, cursor + length)); cursor += length; }
    if (cursor !== stored.length) throw new Error('SH payload length mismatch');
    entry.rawBytes = entry.storedBytes = stored.length;
    entry.rawSha256 = entry.storedSha256 = hash(stored);
    report = { input: resolve(input), output: resolve(output), originalSha256: hash(original), recoveredBitmapSha256: hash(restored), bitmapBytes: restored.length, exceptionCount: count, legacyBytesExactlyReproduced: true, strictNodeAndBrowserRoundtrip: true, compressedBytesBefore: broken.length, compressedBytesAfter: fixed.length };
    repaired = true;
  }
  payloads.push(stored);
}
if (!repaired || offset !== original.length) throw new Error('Missing SH stream or trailing bytes');
const directory = Buffer.from(JSON.stringify(manifest)), header = Buffer.from(original.subarray(0, 12)); header.writeUInt32LE(directory.length, 8);
const result = Buffer.concat([header, directory, ...payloads]);
await writeFile(output, result, { flag: 'wx' });
report.outputSha256 = hash(result);
await writeFile(`${output}.repair.json`, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
