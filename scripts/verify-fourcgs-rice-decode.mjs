// #WDD-gpt 2026-09-20 - 与原逐 bit Rice 实现逐字节核对真实流，覆盖位置、旋转、三轴缩放与 DC。
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as fast from './fourcgs-v21-lossless-codec.mjs';
const path = new URL('./fourcgs-v21-lossless-codec.mjs', import.meta.url);
const source = await readFile(path, 'utf8');
const legacySource = source.replace(/class PackedBitReader \{[\s\S]*?\n\}\n\nclass PredictiveRiceSignedReader/, `class PackedBitReader {
  constructor(bytes,totalBits){this.bytes=bytes;this.totalBits=totalBits;this.bitOffset=0;}
  bit(){if(this.bitOffset>=this.totalBits)throw new Error('Unexpected Rice bitstream end.');const value=(this.bytes[this.bitOffset>>>3]>>>(this.bitOffset&7))&1;this.bitOffset++;return value;}
  unary(){let zeros=0;while(this.bit()===0)zeros++;return zeros;}
  read(bits){let value=0;for(let bit=0;bit<bits;bit++)value+=this.bit()*(2**bit);return value;}
  done(){if(this.bitOffset!==this.totalBits)throw new Error('Unused Rice bits');}
}

class PredictiveRiceSignedReader`);
if (legacySource === source) throw new Error('Reference substitution failed');
const reference = legacySource.replaceAll('import.meta.url', JSON.stringify(path.href)).replace("'./fourcgs-prs-codec.mjs'", JSON.stringify(new URL('./fourcgs-prs-codec.mjs', import.meta.url).href));
const slow = await import('data:text/javascript;base64,' + Buffer.from(reference).toString('base64'));
const [output, ...inputs] = process.argv.slice(2); if(!output || !inputs.length) throw new Error('Usage: REPORT.json FILE.4cgs...');
const report=[];
for(const input of inputs){const bytes=await readFile(input);let offset=12+bytes.readUInt32LE(8);const manifest=JSON.parse(bytes.subarray(12,offset));
  for(const entry of manifest.streams){const stored=bytes.subarray(offset,offset+entry.storedBytes);offset+=entry.storedBytes;
    if(!['prs_position','so3_rotation','tattr_scale_0','tattr_scale_1','tattr_scale_2','tattr_dc'].includes(entry.name))continue;
    const decode=async module=>entry.name==='prs_position'?(await module.decodeV21PositionContexts(stored)).contexts:(await module.decodeV22StructuredParts(entry.name,stored)).streams;
    let start=performance.now();const before=await decode(slow),beforeMs=performance.now()-start;start=performance.now();const after=await decode(fast),afterMs=performance.now()-start;
    if(before.size!==after.size)throw new Error('Context count mismatch');let comparedBytes=0;const hash=createHash('sha256');
    for(const [name,data] of before){if(!after.has(name)||!Buffer.from(data).equals(Buffer.from(after.get(name))))throw new Error(`${input} ${entry.name} ${name} differs`);comparedBytes+=data.length;hash.update(data);}
    report.push({input,stream:entry.name,comparedBytes,sha256:hash.digest('hex'),beforeMs,afterMs,bitExact:true});
  }
}
await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
