import type { Raw4DAsset, Raw4DScalarArray, Raw4DTrack } from './Raw4DTypes';
import type { Raw4DSource } from './Raw4DTypes';
import { readRaw4DHeader } from './Raw4DParser';

export interface Raw4DExportProgress {
  readonly ratio: number;
  readonly writtenPoints: number;
  readonly totalPoints: number;
}

export interface Raw4DExportOptions {
  readonly chunkRows?: number;
  readonly onProgress?: (progress: Raw4DExportProgress) => void;
}

interface Raw4DExportColumn {
  readonly name: string;
  readonly values: Raw4DScalarArray;
}

const TRACK_LAYOUTS = [
  ['position', 'xyz_bank', ['x', 'y', 'z'], 'xyz_bank_keyframe_stride'],
  ['rotation', 'rot_bank', ['w', 'x', 'y', 'z'], 'rot_bank_keyframe_stride'],
  ['colorDc', 'f_dc_bank', ['0', '1', '2'], 'features_dc_bank_keyframe_stride'],
  ['scale', 'scale_bank', ['0', '1', '2'], 'scaling_bank_keyframe_stride'],
  ['opacity', 'opacity_bank', [''], 'opacity_bank_keyframe_stride'],
] as const;

function isDeleted(words: Uint32Array, stableId: number): boolean {
  return Boolean(words[stableId >>> 5] & (1 << (stableId & 31)));
}

function keyframeStride(track: Raw4DTrack, totalFrames: number): number {
  const stride = track.keyframes.length > 1 ? track.keyframes[1] - track.keyframes[0] : Math.max(1, totalFrames);
  const expected: number[] = [];
  for (let frame = 0; frame < totalFrames; frame += stride) expected.push(frame);
  if (expected.at(-1) !== totalFrames - 1) expected.push(totalFrames - 1);
  if (expected.length !== track.keyframes.length
    || expected.some((frame, index) => frame !== track.keyframes[index])) {
    throw new Error('RAW4D export requires uniformly strided keyframe banks.');
  }
  return stride;
}

function appendTrackColumns(
  columns: Raw4DExportColumn[],
  track: Raw4DTrack,
  prefix: string,
  components: readonly string[],
): void {
  for (let bank = 0; bank < track.keyframes.length; bank += 1) {
    for (let component = 0; component < components.length; component += 1) {
      const suffix = components[component];
      columns.push({
        name: suffix ? `${prefix}_${bank}_${suffix}` : `${prefix}_${bank}`,
        values: track.values[bank * track.components + component],
      });
    }
  }
}

function createExportColumns(asset: Raw4DAsset): Raw4DExportColumn[] {
  const columns: Raw4DExportColumn[] = [
    { name: 'lifetime_mu', values: asset.lifetimeMu },
    { name: 'lifetime_w', values: asset.lifetimeW },
  ];
  for (const [key, prefix, components] of TRACK_LAYOUTS) {
    appendTrackColumns(columns, asset[key], prefix, components);
  }
  asset.shRest.forEach((values, index) => columns.push({ name: `f_rest_${index}`, values }));
  return columns;
}

function createHeader(asset: Raw4DAsset, columns: readonly Raw4DExportColumn[], keptCount: number): ArrayBuffer {
  const scalarType = asset.sourceEncoding === 'float16' ? 'ushort' : 'float';
  const lines = [
    'ply',
    'format binary_little_endian 1.0',
    `comment total_frames ${asset.totalFrames}`,
  ];
  for (const [key, , , comment] of TRACK_LAYOUTS) {
    lines.push(`comment ${comment} ${keyframeStride(asset[key], asset.totalFrames)}`);
  }
  if (asset.sourceEncoding === 'float16') {
    lines.push('comment fp16_quantized 1');
    columns.forEach((column) => lines.push(`comment fp16_property ${column.name}`));
  }
  lines.push(`element vertex ${keptCount}`);
  columns.forEach((column) => lines.push(`property ${scalarType} ${column.name}`));
  lines.push('end_header');
  const encoded = new TextEncoder().encode(`${lines.join('\n')}\n`);
  const copy = new Uint8Array(encoded.byteLength);
  copy.set(encoded);
  return copy.buffer;
}

async function yieldToBrowser(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// #WDD-gpt  2026-08-16 - 保存时才根据软删除位集流式压实 RAW4D，编辑期间不改写原始 SoA 属性。
export async function exportCompactedRaw4D(
  asset: Raw4DAsset,
  deletionWords: Uint32Array,
  options: Raw4DExportOptions = {},
): Promise<Blob> {
  let keptCount = 0;
  for (let stableId = 0; stableId < asset.splatCount; stableId += 1) {
    if (!isDeleted(deletionWords, stableId)) keptCount += 1;
  }
  if (keptCount === 0) throw new Error('RAW4D export cannot create an empty asset.');

  const columns = createExportColumns(asset);
  const scalarBytes = asset.sourceEncoding === 'float16' ? 2 : 4;
  const chunkRows = Math.max(256, Math.floor(options.chunkRows ?? 4096));
  const parts: BlobPart[] = [createHeader(asset, columns, keptCount)];
  let stableId = 0;
  let writtenPoints = 0;
  while (stableId < asset.splatCount) {
    const keptIds: number[] = [];
    while (stableId < asset.splatCount && keptIds.length < chunkRows) {
      if (!isDeleted(deletionWords, stableId)) keptIds.push(stableId);
      stableId += 1;
    }
    if (keptIds.length > 0) {
      const buffer = new ArrayBuffer(keptIds.length * columns.length * scalarBytes);
      const view = new DataView(buffer);
      let byteOffset = 0;
      for (const sourceId of keptIds) {
        for (const column of columns) {
          if (asset.sourceEncoding === 'float16') {
            view.setUint16(byteOffset, (column.values as Uint16Array)[sourceId], true);
          } else {
            view.setFloat32(byteOffset, (column.values as Float32Array)[sourceId], true);
          }
          byteOffset += scalarBytes;
        }
      }
      parts.push(buffer);
      writtenPoints += keptIds.length;
      options.onProgress?.({ ratio: writtenPoints / keptCount, writtenPoints, totalPoints: keptCount });
    }
    await yieldToBrowser();
  }
  return new Blob(parts, { type: 'application/octet-stream' });
}

// #WDD-gpt  2026-08-16 - 对已导入源文件直接按记录压实，保留未知属性、原始位宽和所有头部注释。
export async function exportCompactedRaw4DSource(
  source: Raw4DSource,
  deletionWords: Uint32Array,
  options: Raw4DExportOptions = {},
): Promise<Blob> {
  const header = await readRaw4DHeader(source);
  let keptCount = 0;
  for (let stableId = 0; stableId < header.vertexCount; stableId += 1) {
    if (!isDeleted(deletionWords, stableId)) keptCount += 1;
  }
  if (keptCount === 0) throw new Error('RAW4D export cannot create an empty asset.');

  const sourceHeaderBytes = new Uint8Array(await source.slice(0, header.dataOffset).arrayBuffer());
  const sourceHeader = new TextDecoder('ascii').decode(sourceHeaderBytes);
  const compactedHeader = sourceHeader.replace(
    /(^element\s+vertex\s+)\d+(\s*$)/m,
    `$1${keptCount}$2`,
  );
  if (compactedHeader === sourceHeader && keptCount !== header.vertexCount) {
    throw new Error('RAW4D export could not update the vertex count.');
  }
  const encodedHeader = new TextEncoder().encode(compactedHeader);
  const headerCopy = new Uint8Array(encodedHeader.byteLength);
  headerCopy.set(encodedHeader);
  const parts: BlobPart[] = [headerCopy.buffer];
  const chunkRows = Math.max(256, Math.floor(options.chunkRows ?? 4096));
  let writtenPoints = 0;
  for (let firstRow = 0; firstRow < header.vertexCount; firstRow += chunkRows) {
    const rowCount = Math.min(chunkRows, header.vertexCount - firstRow);
    const chunk = new Uint8Array(await source.slice(
      header.dataOffset + firstRow * header.recordBytes,
      header.dataOffset + (firstRow + rowCount) * header.recordBytes,
    ).arrayBuffer());
    const compacted = new Uint8Array(rowCount * header.recordBytes);
    let outputOffset = 0;
    for (let row = 0; row < rowCount; row += 1) {
      if (isDeleted(deletionWords, firstRow + row)) continue;
      const inputOffset = row * header.recordBytes;
      compacted.set(chunk.subarray(inputOffset, inputOffset + header.recordBytes), outputOffset);
      outputOffset += header.recordBytes;
      writtenPoints += 1;
    }
    if (outputOffset > 0) parts.push(compacted.buffer.slice(0, outputOffset));
    options.onProgress?.({ ratio: writtenPoints / keptCount, writtenPoints, totalPoints: keptCount });
    await yieldToBrowser();
  }
  return new Blob(parts, { type: 'application/octet-stream' });
}
