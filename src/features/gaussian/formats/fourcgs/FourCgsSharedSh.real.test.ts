// #WDD-gpt 2026-09-20 - 真实片段 SH 输出与优化前整行 SHA-256 比较，避免分区破坏跨段状态或例外顺序。
import { expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { prepareSharedSh, decodeSharedShPartition } from './FourCgsSharedSh';
import { fourCgsDecodedPropertyNames } from './FourCgsRaw4D';
import { halfToFloat, floatToHalf } from '../../../../../scripts/fourcgs-prs-codec.mjs';
const inputs = [1, 5].map(i => `public/4cgs_show/dance/lili_1352xxxx.part-${String(i).padStart(2, '0')}-of-12.4cgs`);
const report = 'artifacts/show-decode-20260920/target90/sh-reference.json';
it.skipIf(!inputs.every(existsSync) || (!process.env.FOURCGS_CAPTURE_SH && !existsSync(report)))('preserves real SH outputs from the previous sequential decoder', async () => {
  vi.stubGlobal('self', { addEventListener() {} });
  try {
    const { decodeSharedSh } = await import('./fourcgs-auxiliary.worker');
    const results = [];
    for (const input of inputs) {
      const bytes = readFileSync(input); let offset = 12 + bytes.readUInt32LE(8);
      const manifest = JSON.parse(bytes.subarray(12, offset).toString()); let stream!: Buffer, mask!: Buffer;
      for (const entry of manifest.streams) { const stored = bytes.subarray(offset, offset + entry.storedBytes); offset += entry.storedBytes;
        if (entry.name === 'active_masks') mask = brotliDecompressSync(stored);
        if (entry.name === 'coresh5r_shared') stream = stored;
      }
      const active = manifest.segments.map((s: any, i: number) => { const slots = new Int32Array(s.gaussianCount); let row = 0;
        for (let slot = 0; slot < manifest.slotCount; slot++) { const bit = i * manifest.slotCount + slot; if (mask[bit >>> 3] & (1 << (bit & 7))) slots[row++] = slot; } return slots;
      });
      const names: string[][] = manifest.segments.map(fourCgsDecodedPropertyNames), indices = names.map(n => new Map(n.map((k,i)=>[k,i])));
      const rows = manifest.segments.map((s: any,i: number)=>new Uint16Array(s.gaussianCount*names[i].length));
      const started = performance.now(); decodeSharedSh(stream, manifest, active, rows, indices, halfToFloat, floatToHalf);
      const ms = performance.now() - started, hash = createHash('sha256');
      for (const row of rows) hash.update(new Uint8Array(row.buffer));
      const sha256 = hash.digest('hex');
      rows.forEach((row: Uint16Array) => row.fill(0));
      const prepared = prepareSharedSh(stream, manifest, halfToFloat, true);
      for (let partition = 0; partition < 3; partition++) decodeSharedShPartition(prepared, manifest, active, rows, indices, floatToHalf, partition, 3);
      const partitionHash = createHash('sha256'); for (const row of rows) partitionHash.update(new Uint8Array(row.buffer));
      expect(partitionHash.digest('hex')).toBe(sha256);
      results.push({input, sha256, ms});
    }
    if (process.env.FOURCGS_CAPTURE_SH) writeFileSync(report, JSON.stringify(results,null,2)+'\n');
    else expect(results.map(r=>r.sha256)).toEqual(JSON.parse(readFileSync(report,'utf8')).map((r: any)=>r.sha256));
    console.log(JSON.stringify(results));
  } finally { vi.unstubAllGlobals(); }
}, 60000);
