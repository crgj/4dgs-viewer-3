// #WDD-gpt 2026-09-20 - 真实文件位置解码新旧路径逐字节核对，单独报告核心循环时间。
import { readFile, writeFile } from 'node:fs/promises';
import { brotliDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { decodeV21PositionContexts } from './fourcgs-v21-lossless-codec.mjs';
import { decodePositionContextStreams } from './fourcgs-prs-codec.mjs';
import { fourCgsDecodedPropertyNames } from '../src/features/gaussian/formats/fourcgs/FourCgsRaw4D.ts';
const [referenceFile, reportFile, ...inputs] = process.argv.slice(2);
const reference = await import(pathToFileURL(referenceFile).href);
const reports = [];
for (const input of inputs) {
  const bytes = await readFile(input); let offset = 12 + bytes.readUInt32LE(8);
  const manifest = JSON.parse(bytes.subarray(12, offset)); let stream, mask;
  for (const entry of manifest.streams) { const stored = bytes.subarray(offset, offset + entry.storedBytes); offset += entry.storedBytes;
    if (entry.name === 'active_masks') mask = brotliDecompressSync(stored);
    if (entry.name === 'prs_position') stream = stored;
  }
  const active = manifest.segments.map((s, i) => { const slots = new Int32Array(s.gaussianCount); let row = 0;
    for (let slot = 0; slot < manifest.slotCount; slot++) { const bit = i * manifest.slotCount + slot; if (mask[bit >>> 3] & (1 << (bit & 7))) slots[row++] = slot; }
    if (row !== slots.length) throw new Error('mask mismatch'); return slots;
  });
  const names = manifest.segments.map(fourCgsDecodedPropertyNames), indices = names.map(n => new Map(n.map((k,i)=>[k,i])));
  const { contexts } = await decodeV21PositionContexts(stream);
  const results = [];
  for (const decode of [reference.decodePositionContextStreams, decodePositionContextStreams]) {
    const rows = manifest.segments.map((s,i)=>new Uint16Array(s.gaussianCount*names[i].length));
    const start=performance.now(); const metrics=decode(contexts,manifest,active,rows,indices); const ms=performance.now()-start;
    const hash=createHash('sha256');for(const row of rows) hash.update(new Uint8Array(row.buffer));
    results.push({ms,...metrics,sha256:hash.digest('hex')});
  }
  if(results[0].sha256!==results[1].sha256)throw new Error('Position output differs');
  reports.push({input,bitExact:true,reference:results[0],optimized:results[1]});
}
await writeFile(reportFile,JSON.stringify(reports,null,2)+'\n');console.log(JSON.stringify(reports));
