import type { Raw4DAsset, Raw4DScalarArray, Raw4DTrack } from './Raw4DTypes';
import type { Raw4DSource } from './Raw4DTypes';
import { readRaw4DHeader } from './Raw4DParser';
import { raw4DCanonicalKeyframes } from './Raw4DSchema';

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
  const expected = raw4DCanonicalKeyframes(totalFrames, stride);
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
  const zero = asset.sourceEncoding === 'float16'
    ? new Uint16Array(asset.splatCount)
    : new Float32Array(asset.splatCount);
  const columns: Raw4DExportColumn[] = [
    { name: 'x', values: asset.position.values[0] },
    { name: 'y', values: asset.position.values[1] },
    { name: 'z', values: asset.position.values[2] },
    { name: 'nx', values: zero },
    { name: 'ny', values: zero },
    { name: 'nz', values: zero },
    { name: 'f_dc_0', values: asset.colorDc.values[0] },
    { name: 'f_dc_1', values: asset.colorDc.values[1] },
    { name: 'f_dc_2', values: asset.colorDc.values[2] },
    ...asset.shRest.map((values, index) => ({ name: `f_rest_${index}`, values })),
    { name: 'opacity', values: asset.opacity.values[0] },
    { name: 'scale_0', values: asset.scale.values[0] },
    { name: 'scale_1', values: asset.scale.values[1] },
    { name: 'scale_2', values: asset.scale.values[2] },
    { name: 'lifetime_mu', values: asset.lifetimeMu },
    { name: 'lifetime_w', values: asset.lifetimeW },
  ];
  for (const [key, prefix, components] of TRACK_LAYOUTS) {
    appendTrackColumns(columns, asset[key], prefix, components);
  }
  return columns;
}

function createHeader(asset: Raw4DAsset, columns: readonly Raw4DExportColumn[], keptCount: number): ArrayBuffer {
  const scalarType = asset.sourceEncoding === 'float16' ? 'ushort' : 'float';
  const lines = [
    'ply',
    'format binary_little_endian 1.0',
    `comment total_frames ${asset.totalFrames}`,
  ];
  if (asset.positionTiming === 'per-point-lifetime-endpoints') lines.push('comment position_timing per-point-lifetime-endpoints');
  if (asset.opacityTiming === 'baked') lines.push('comment opacity_timing baked');
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
  const pointOffsets = new Map<string, number>([
    ['vertex', 0],
    ['vertex_static', header.vertexCount],
  ]);
  const keptByElement = new Map<string, number>();
  let keptCount = 0;
  for (const element of header.elements) {
    const pointOffset = pointOffsets.get(element.name)!;
    let elementKept = 0;
    for (let localId = 0; localId < element.count; localId += 1) {
      if (!isDeleted(deletionWords, pointOffset + localId)) elementKept += 1;
    }
    keptByElement.set(element.name, elementKept);
    keptCount += elementKept;
  }
  if (keptCount === 0) throw new Error('RAW4D export cannot create an empty asset.');

  const sourceHeaderBytes = new Uint8Array(await source.slice(0, header.dataOffset).arrayBuffer());
  const sourceHeader = new TextDecoder('ascii').decode(sourceHeaderBytes);
  let compactedHeader = sourceHeader;
  for (const element of header.elements) {
    const next = compactedHeader.replace(
      new RegExp(`(^element\\s+${element.name}\\s+)\\d+(\\s*$)`, 'm'),
      `$1${keptByElement.get(element.name)!}$2`,
    );
    if (next === compactedHeader && keptByElement.get(element.name) !== element.count) {
      throw new Error(`RAW4D export could not update the ${element.name} count.`);
    }
    compactedHeader = next;
  }
  const encodedHeader = new TextEncoder().encode(compactedHeader);
  const headerCopy = new Uint8Array(encodedHeader.byteLength);
  headerCopy.set(encodedHeader);
  const parts: BlobPart[] = [headerCopy.buffer];
  const chunkRows = Math.max(256, Math.floor(options.chunkRows ?? 4096));
  let writtenPoints = 0;
  // #WDD-gpt 2026-08-19 - 动态/静态 element 分别按原始记录宽度压实，删除位集继续使用“动态在前、静态在后”的统一稳定 ID。
  for (const element of header.elements) {
    const pointOffset = pointOffsets.get(element.name)!;
    for (let firstRow = 0; firstRow < element.count; firstRow += chunkRows) {
      const rowCount = Math.min(chunkRows, element.count - firstRow);
      const chunk = new Uint8Array(await source.slice(
        element.dataOffset + firstRow * element.recordBytes,
        element.dataOffset + (firstRow + rowCount) * element.recordBytes,
      ).arrayBuffer());
      const compacted = new Uint8Array(rowCount * element.recordBytes);
      let outputOffset = 0;
      for (let row = 0; row < rowCount; row += 1) {
        if (isDeleted(deletionWords, pointOffset + firstRow + row)) continue;
        const inputOffset = row * element.recordBytes;
        compacted.set(chunk.subarray(inputOffset, inputOffset + element.recordBytes), outputOffset);
        outputOffset += element.recordBytes;
        writtenPoints += 1;
      }
      if (outputOffset > 0) parts.push(compacted.buffer.slice(0, outputOffset));
      options.onProgress?.({ ratio: writtenPoints / keptCount, writtenPoints, totalPoints: keptCount });
      await yieldToBrowser();
    }
  }
  return new Blob(parts, { type: 'application/octet-stream' });
}
