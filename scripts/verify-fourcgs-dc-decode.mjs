// #WDD-gpt 2026-09-20 - 真实文件 DC 解码新旧路径逐字节核对，包含 Rice/YCoCg 恢复时间。
import { readFile, writeFile } from 'node:fs/promises';
import { brotliDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { decodeV22StructuredParts, decodeV22DcReaders } from './fourcgs-v21-lossless-codec.mjs';
import { decodeTemporalAttributeReaders, decodeTemporalAttributeStreams } from './fourcgs-temporal-attribute-codec.mjs';
import { fourCgsDecodedPropertyNames } from '../src/features/gaussian/formats/fourcgs/FourCgsRaw4D.ts';
const [reportFile, ...inputs] = process.argv.slice(2);

const reports = [];
for (const input of inputs) {
  const bytes = await readFile(input); let offset = 12 + bytes.readUInt32LE(8);
  const manifest = JSON.parse(bytes.subarray(12, offset)); let stream, mask;
  for (const entry of manifest.streams) { const stored = bytes.subarray(offset, offset + entry.storedBytes); offset += entry.storedBytes;
    if (entry.name === 'active_masks') mask = brotliDecompressSync(stored);
    if (entry.name === 'tattr_dc') stream = stored;
  }
  const active = manifest.segments.map((s, i) => { const slots = new Int32Array(s.gaussianCount); let row = 0;
    for (let slot = 0; slot < manifest.slotCount; slot++) { const bit = i * manifest.slotCount + slot; if (mask[bit >>> 3] & (1 << (bit & 7))) slots[row++] = slot; }
    if (row !== slots.length) throw new Error('mask mismatch'); return slots;
  });
  const names = manifest.segments.map(fourCgsDecodedPropertyNames), indices = names.map(n => new Map(n.map((k,i)=>[k,i])));

  const results = [];
  for (const direct of [false, true]) {
    const rows = manifest.segments.map((s,i)=>new Uint16Array(s.gaussianCount*names[i].length));
    const start=performance.now(); const decoded = direct ? await decodeV22DcReaders(stream) : await decodeV22StructuredParts('tattr_dc', stream); const metrics = direct ? decodeTemporalAttributeReaders(decoded.metadata, decoded.readers, manifest, active, rows, indices) : decodeTemporalAttributeStreams(decoded.metadata, decoded.streams, manifest, active, rows, indices); const ms=performance.now()-start;
    const hash=createHash('sha256');for(const row of rows) hash.update(new Uint8Array(row.buffer));
    results.push({ms,...metrics,sha256:hash.digest('hex')});
  }
  if(results[0].sha256!==results[1].sha256)throw new Error('DC output differs');
  reports.push({input,bitExact:true,reference:results[0],optimized:results[1]});
}
await writeFile(reportFile,JSON.stringify(reports,null,2)+'\n');console.log(JSON.stringify(reports));
