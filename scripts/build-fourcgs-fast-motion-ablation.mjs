import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bankCount, buildExactBoundaryPermanentTrackMaps, readSegment } from './probe-fourcgs-lossless-rate.mjs';
import { buildCroppedMortonLayout } from './fourcgs-prs-codec.mjs';

const SEGMENT_PATTERN = /^segment_(\d+)_(\d+)\.raw4d$/;

function manifestFromContainer(bytes) {
  if (bytes.subarray(0, 8).toString('ascii') !== '4CGSPRS2') throw new Error('Unsupported 4CGS container.');
  const length = bytes.readUInt32LE(8);
  return JSON.parse(bytes.subarray(12, 12 + length).toString('utf8'));
}

function payloadOffset(bytes) {
  const marker = Buffer.from('end_header\n', 'ascii');
  const offset = bytes.indexOf(marker);
  if (offset < 0) throw new Error('RAW4D header is missing end_header.');
  return offset + marker.length;
}

function matchesSelection(name, variant) {
  return variant.prefixes.some((prefix) => name.startsWith(prefix)) || variant.properties?.includes(name);
}

// #WDD-gpt 2026-08-16 - 生成同一 Morton 行序的快速运动属性消融，隔离 Position、Scale、SH 与渲染排序误差。
async function main() {
  const sourceDirectory = resolve(process.argv[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16');
  const decodedDirectory = resolve(process.argv[3] ?? 'artifacts/compression_v2_20260816/v23_final_decoded');
  const containerPath = resolve(process.argv[4] ?? 'artifacts/compression_v2_20260816/collected_master_ply4_cleaned_fp16_v2_4.4cgs');
  const segmentName = process.argv[5] ?? 'segment_210_240';
  const outputDirectory = resolve(process.argv[6] ?? 'artifacts/compression_v2_20260816/v24_fast_motion_ablation');
  const sourceNames = (await readdir(sourceDirectory))
    .filter((name) => SEGMENT_PATTERN.test(name))
    .sort((left, right) => Number(SEGMENT_PATTERN.exec(left)[1]) - Number(SEGMENT_PATTERN.exec(right)[1]));
  const segmentIndex = sourceNames.findIndex((name) => name === `${segmentName}.raw4d`);
  if (segmentIndex < 0) throw new Error(`Unknown source segment ${segmentName}.`);
  const sources = [];
  for (const name of sourceNames) sources.push(await readSegment(join(sourceDirectory, name)));
  const decodedPath = join(decodedDirectory, `${segmentName}.decoded.raw4d`);
  const decoded = await readSegment(decodedPath);
  const decodedFile = await readFile(decodedPath);
  // #WDD-gpt 2026-08-16 - 保留解码 RAW4D 的帧数、步长与 FP16 注释，避免消融资产被前端误判为普通 PLY。
  const header = decodedFile.subarray(0, payloadOffset(decodedFile));
  const manifest = manifestFromContainer(await readFile(containerPath));
  const permanent = buildExactBoundaryPermanentTrackMaps(sources);
  const layout = buildCroppedMortonLayout(sources, permanent, manifest.crop.center, manifest.crop.halfExtent);
  const source = sources[segmentIndex];
  const activeSlots = layout.activeSlots[segmentIndex];
  if (decoded.count !== activeSlots.length) throw new Error('Decoded rows do not match active Track IDs.');
  const sourceRows = Int32Array.from(activeSlots, (slot) => layout.slotToLocal[segmentIndex][slot]);
  const variants = [
    { name: 'source_morton', mode: 'source', prefixes: [] },
    { name: 'position_only', mode: 'source', prefixes: ['xyz_bank_'] },
    { name: 'rotation_only', mode: 'source', prefixes: ['rot_bank_'] },
    { name: 'scale_only', mode: 'source', prefixes: ['scale_bank_'] },
    { name: 'dc_only', mode: 'source', prefixes: ['f_dc_bank_'] },
    { name: 'opacity_only', mode: 'source', prefixes: ['opacity_bank_'] },
    { name: 'coresh_only', mode: 'source', prefixes: ['f_rest_'] },
    { name: 'nonsh_only', mode: 'source', prefixes: ['xyz_bank_', 'rot_bank_', 'scale_bank_', 'f_dc_bank_', 'opacity_bank_'] },
    { name: 'revert_position', mode: 'decoded', prefixes: ['xyz_bank_'] },
    { name: 'revert_rotation', mode: 'decoded', prefixes: ['rot_bank_'] },
    { name: 'revert_scale', mode: 'decoded', prefixes: ['scale_bank_'] },
    { name: 'revert_dc', mode: 'decoded', prefixes: ['f_dc_bank_'] },
    { name: 'revert_opacity', mode: 'decoded', prefixes: ['opacity_bank_'] },
    { name: 'revert_opacity0', mode: 'decoded', prefixes: [], properties: ['opacity_bank_0'] },
    { name: 'revert_opacity_residuals', mode: 'decoded', prefixes: [], properties: ['opacity_bank_1', 'opacity_bank_2', 'opacity_bank_3'] },
    { name: 'revert_sh', mode: 'decoded', prefixes: ['f_rest_'] },
  ];
  await mkdir(outputDirectory, { recursive: true });
  const outputs = [];
  const selectedVariants = process.argv.includes('--source-only')
    ? variants.filter((variant) => variant.name === 'source_morton')
    : variants;
  // #WDD-gpt 2026-08-16 - 全帧门禁低谷只生成原始 Morton 行序基线，避免为六段重复写出无关的完整消融集。
  for (const variant of selectedVariants) {
    const rows = new Uint16Array(decoded.rows.length);
    for (let row = 0; row < decoded.count; row += 1) {
      const sourceBase = sourceRows[row] * source.propertyNames.length;
      const decodedBase = row * decoded.propertyNames.length;
      for (let property = 0; property < decoded.propertyNames.length; property += 1) {
        const name = decoded.propertyNames[property];
        // #WDD-gpt 2026-08-16 - 将透明度首关键帧与后三个残差关键帧分离消融，定位快速运动重影的码率来源。
        const selected = matchesSelection(name, variant);
        const useDecoded = variant.mode === 'source' ? selected : !selected;
        rows[decodedBase + property] = useDecoded
          ? decoded.rows[decodedBase + property]
          : source.rows[sourceBase + source.propertyIndex.get(name)];
      }
    }
    const outputPath = join(outputDirectory, `${segmentName}.${variant.name}.raw4d`);
    await writeFile(outputPath, Buffer.concat([header, Buffer.from(rows.buffer)]));
    outputs.push({ ...variant, outputPath });
  }
  const reportPath = join(outputDirectory, `${segmentName}.json`);
  await writeFile(reportPath, `${JSON.stringify({
    sourceDirectory,
    decodedDirectory,
    containerPath,
    segmentName,
    segmentIndex,
    gaussianCount: decoded.count,
    sourcePositionBanks: bankCount(source, 'xyz_bank'),
    outputs,
  }, null, 2)}\n`);
  console.log(JSON.stringify({ reportPath, outputs }));
}

await main();
