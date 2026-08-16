import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { readSegment } from './probe-fourcgs-lossless-rate.mjs';

function payloadOffset(bytes) {
  const marker = Buffer.from('end_header\n', 'ascii');
  const offset = bytes.indexOf(marker);
  if (offset < 0) throw new Error('Missing RAW4D end_header marker.');
  return offset + marker.length;
}

const ATTRIBUTES = {
  rotation: ['rot_bank_'],
  scale: ['scale_bank_'],
  dc: ['f_dc_bank_'],
  opacity: ['opacity_bank_'],
};

// #WDD-gpt 2026-08-16 - 只在独立评测资产中逐项替换 V2.3 属性，定位 54 视图尾部误差而不改正式 Viewer 或候选码流。
async function main() {
  const sourcePath = resolve(process.argv[2]);
  const candidatePath = resolve(process.argv[3]);
  const outputDirectory = resolve(process.argv[4] ?? 'artifacts/compression_v2_20260816/v23_attribute_ablation');
  const source = await readSegment(sourcePath);
  const candidate = await readSegment(candidatePath);
  if (source.count !== candidate.count || source.propertyNames.join('\0') !== candidate.propertyNames.join('\0')) {
    throw new Error('V2.2/V2.3 RAW4D layout mismatch.');
  }
  const sourceFile = await readFile(sourcePath);
  const header = sourceFile.subarray(0, payloadOffset(sourceFile));
  await mkdir(outputDirectory, { recursive: true });
  const outputs = [];
  for (const [attribute, prefixes] of Object.entries(ATTRIBUTES)) {
    const rows = new Uint16Array(source.rows);
    for (let property = 0; property < source.propertyNames.length; property += 1) {
      if (!prefixes.some((prefix) => source.propertyNames[property].startsWith(prefix))) continue;
      for (let row = 0; row < source.count; row += 1) {
        const offset = row * source.propertyNames.length + property;
        rows[offset] = candidate.rows[offset];
      }
    }
    const outputPath = join(outputDirectory, `${basename(sourcePath, '.decoded.raw4d')}.${attribute}.raw4d`);
    await writeFile(outputPath, Buffer.concat([header, Buffer.from(rows.buffer)]));
    outputs.push({ attribute, outputPath });
  }
  for (const [attribute, prefixes] of Object.entries(ATTRIBUTES)) {
    const rows = new Uint16Array(candidate.rows);
    for (let property = 0; property < source.propertyNames.length; property += 1) {
      if (!prefixes.some((prefix) => source.propertyNames[property].startsWith(prefix))) continue;
      for (let row = 0; row < source.count; row += 1) {
        const offset = row * source.propertyNames.length + property;
        rows[offset] = source.rows[offset];
      }
    }
    const outputPath = join(outputDirectory, `${basename(sourcePath, '.decoded.raw4d')}.revert-${attribute}.raw4d`);
    await writeFile(outputPath, Buffer.concat([header, Buffer.from(rows.buffer)]));
    outputs.push({ attribute: `revert-${attribute}`, outputPath });
  }
  console.log(JSON.stringify({ sourcePath, candidatePath, outputs }));
}

await main();
