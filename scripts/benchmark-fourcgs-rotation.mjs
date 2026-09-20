// #WDD-gpt 2026-09-20 - 真实旋转码流基准同时记录全输出哈希，禁止用速度收益掩盖 FP16 输出差异。
import { readFile, writeFile } from 'node:fs/promises';
import { brotliDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { decodeV22StructuredParts, decodeV22RotationReaders } from './fourcgs-v21-lossless-codec.mjs';
import { prepareSo3RotationStreams, decodeSo3RotationPartition } from './fourcgs-so3-temporal-codec.mjs';
import { fourCgsDecodedPropertyNames } from '../src/features/gaussian/formats/fourcgs/FourCgsRaw4D.ts';
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: INPUT.4cgs REPORT.json');
const bytes = await readFile(input); let offset = 12 + bytes.readUInt32LE(8);
const manifest = JSON.parse(bytes.subarray(12, offset)); let rotation, mask;
for (const entry of manifest.streams) { const stored = bytes.subarray(offset, offset + entry.storedBytes); offset += entry.storedBytes;
  if (entry.name === 'active_masks') mask = brotliDecompressSync(stored);
  if (entry.name === 'so3_rotation') rotation = stored;
}
const active = manifest.segments.map((s, i) => { const slots = new Int32Array(s.gaussianCount); let row = 0;
  for (let slot = 0; slot < manifest.slotCount; slot++) { const bit = i * manifest.slotCount + slot; if (mask[bit >>> 3] & (1 << (bit & 7))) slots[row++] = slot; }
  if (row !== slots.length) throw new Error('mask mismatch'); return slots;
});
const names = manifest.segments.map(fourCgsDecodedPropertyNames), indices = names.map(n => new Map(n.map((k,i)=>[k,i])));
const rows = manifest.segments.map((s,i)=>new Uint16Array(s.gaussianCount*names[i].length));
const start = performance.now(); const direct = (process.argv.includes('--direct') ? await decodeV22RotationReaders(rotation) : await decodeV22StructuredParts('so3_rotation', rotation));
const structuredMs = performance.now()-start; const prep = performance.now(); const prepared = prepareSo3RotationStreams(direct.metadata,direct.streams,manifest,active,false,direct.readers);
const prepareMs = performance.now()-prep;
const runs = [];for(let i=0;i<3;i++){ const start=performance.now(); const result=decodeSo3RotationPartition(prepared,manifest,active,rows,indices);runs.push({ms:performance.now()-start,...result}); }
const hash=createHash('sha256');for(const row of rows) hash.update(new Uint8Array(row.buffer));
const report={input,structuredMs,prepareMs,exceptionCount:prepared.exceptionCount,observations:prepared.instanceCount+prepared.intraCount,runs,outputSha256:hash.digest('hex')};
await writeFile(output,JSON.stringify(report,null,2)+'\n'); console.log(JSON.stringify(report));
