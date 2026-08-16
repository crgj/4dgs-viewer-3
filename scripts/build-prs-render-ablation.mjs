import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildPermanentTrackMaps, readSegment } from './probe-fourcgs-lossless-rate.mjs';
import { buildCroppedMortonLayout, floatToHalf, halfToFloat } from './fourcgs-prs-codec.mjs';

const SEGMENT_PATTERN = /^segment_(\d+)_(\d+)\.raw4d$/;

function payloadOffset(bytes) {
  const marker = Buffer.from('end_header\n', 'ascii');
  const offset = bytes.indexOf(marker);
  if (offset < 0) throw new Error('Missing RAW4D end_header marker.');
  return offset + marker.length;
}

async function main() {
  const sourceDirectory = resolve(process.argv[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16');
  const decodedDirectory = resolve(process.argv[3] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16_prs_morton_decoded');
  const outputDirectory = resolve(process.argv[4] ?? 'artifacts/prs-render-ablation');
  const entries = (await readdir(sourceDirectory))
    .map((name) => ({ name, match: SEGMENT_PATTERN.exec(name) }))
    .filter((entry) => entry.match)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
  const sources = [];
  for (const entry of entries) sources.push(await readSegment(join(sourceDirectory, entry.name)));
  const permanent = buildPermanentTrackMaps(sources);
  const layout = buildCroppedMortonLayout(
    sources,
    permanent,
    [-0.00244140625, 0.2928466796875, -0.2431640625],
    2.5,
  );
  const segmentIndex = 0;
  const decodedPath = join(decodedDirectory, `${entries[segmentIndex].name.replace(/\.raw4d$/, '')}.decoded.raw4d`);
  const decoded = await readSegment(decodedPath);
  const decodedFile = await readFile(decodedPath);
  const header = decodedFile.subarray(0, payloadOffset(decodedFile));
  const source = sources[segmentIndex];
  const active = layout.activeSlots[segmentIndex];
  const inverse = layout.slotToLocal[segmentIndex];
  const variants = [
    { name: 'coresh_morton_order', prefixes: [] },
    { name: 'position_only', prefixes: ['xyz_bank_'] },
    { name: 'rotation_only', prefixes: ['rot_bank_'] },
    { name: 'scale_only', prefixes: ['scale_bank_'] },
    { name: 'dc_only', prefixes: ['f_dc_bank_'] },
    { name: 'opacity_only', prefixes: ['opacity_bank_'] },
    { name: 'dc_opacity', prefixes: ['f_dc_bank_', 'opacity_bank_'] },
    { name: 'prs_all', prefixes: ['xyz_bank_', 'rot_bank_', 'scale_bank_'] },
    { name: 'all_nonsh', prefixes: ['xyz_bank_', 'rot_bank_', 'scale_bank_', 'f_dc_bank_', 'opacity_bank_'] },
    { name: 'position_q001', prefixes: [], positionStep: 0.001 },
    { name: 'position_q00075', prefixes: [], positionStep: 0.00075 },
    { name: 'position_q0005', prefixes: [], positionStep: 0.0005 },
  ];
  await mkdir(outputDirectory, { recursive: true });
  const outputs = [];
  for (const variant of variants) {
    const rows = new Uint16Array(decoded.rows.length);
    for (let row = 0; row < active.length; row += 1) {
      const sourceLocal = inverse[active[row]];
      const sourceBase = sourceLocal * source.propertyNames.length;
      const destinationBase = row * decoded.propertyNames.length;
      for (let property = 0; property < decoded.propertyNames.length; property += 1) {
        const name = decoded.propertyNames[property];
        const useDecoded = name.startsWith('f_rest_') || variant.prefixes.some((prefix) => name.startsWith(prefix));
        const sourceBits = source.rows[sourceBase + source.propertyIndex.get(name)];
        if (variant.positionStep && name.startsWith('xyz_bank_')) {
          const axis = name.endsWith('_x') ? 0 : name.endsWith('_y') ? 1 : 2;
          const origin = [-2.50244140625, -2.2071533203125, -2.7431640625][axis];
          const quantized = Math.round((halfToFloat(sourceBits) - origin) / variant.positionStep);
          rows[destinationBase + property] = floatToHalf(origin + quantized * variant.positionStep);
        } else {
          rows[destinationBase + property] = useDecoded ? decoded.rows[destinationBase + property] : sourceBits;
        }
      }
    }
    const outputPath = join(outputDirectory, `${variant.name}.raw4d`);
    await writeFile(outputPath, Buffer.concat([header, Buffer.from(rows.buffer)]));
    outputs.push({ name: variant.name, outputPath, bytes: header.length + rows.byteLength });
  }
  console.log(JSON.stringify({ outputDirectory, outputs }));
}

// #WDD-gpt 2026-08-15 - 独立渲染消融保持同一 Morton 行序和 CoReSH，仅逐项切换 P/R/S，定位 PSNR 的真正主因。
// #WDD-gpt 2026-08-15 - 增加 DC/Opacity 及完整非 SH 消融，定位 Braindance 码表档首帧质量尾部。
await main();
