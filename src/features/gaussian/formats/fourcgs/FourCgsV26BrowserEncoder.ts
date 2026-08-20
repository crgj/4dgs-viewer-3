import { Buffer } from 'buffer';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { zlibSync } from 'fflate';
import { createFourCgsEditorBuild, FOUR_CGS_HEADER_BYTES, FOUR_CGS_MAGIC, readFourCgsManifest } from './FourCgsContainer';
import {
  fourCgsCanonicalRaw4DHeader,
  fourCgsCanonicalRaw4DPropertyNames,
  fourCgsDecodedPropertyNames,
} from './FourCgsRaw4D';
import { raw4DBundleOutputName, shuffle16WithPadding } from './FourCgsRaw4DBundle';
import type { FourCgsEncodeResult } from './FourCgsEncoderClient';
import type { FourCgsManifest, FourCgsProgress, FourCgsSegment, FourCgsStreamEntry } from './FourCgsTypes';
import { readRaw4DHeader } from '../raw4d/Raw4DParser';
import { raw4DSequenceFrameRangeFromName } from '../raw4d/Raw4DSequence';
import {
  RAW4D_TRACK_DEFINITIONS,
  raw4DBankCount,
  raw4DCanonicalKeyframes,
  raw4DTrackStride,
} from '../raw4d/Raw4DSchema';
import type { Raw4DAsset, Raw4DHeader, Raw4DMemorySnapshot, Raw4DTemporalLayout, Raw4DTrack } from '../raw4d/Raw4DTypes';

const SH_DIMENSIONS = 45;
const SH_CODEBOOK_SIZE = 256;
const SH_TARGET_RMSE = 0.013;
const SH_MAXIMUM_COEFFICIENT_ERROR = 0.05;
const POSITION_STEP = 0.00045;
const POSITION_MAXIMUM_ERROR = 0.0005;
const ROTATION_STEP_DEGREES = 0.05;
const ROTATION_MAXIMUM_DEGREES = 0.1;
const SCALE_STEP = 0.0078125;
const DC_STEP = 0.0078125;

interface BrowserSegment {
  readonly path: string;
  readonly count: number;
  readonly propertyNames: readonly string[];
  readonly propertyIndex: ReadonlyMap<string, number>;
  readonly comments: ReadonlyMap<string, string>;
  readonly rows: Uint16Array;
}

interface ShTemplate {
  readonly name: 'compact-5x9d' | 'balanced-10x4-5d' | 'quality-15x3d';
  readonly levels: number;
}

interface ShTreeNode {
  readonly left: Float32Array;
  readonly right: Float32Array;
}

interface ShProductLevel {
  readonly dimensions: readonly number[];
  readonly nodes: readonly ShTreeNode[];
  readonly centers: Float32Array;
}

interface TrainedSh {
  readonly template: ShTemplate;
  readonly base: Buffer;
  readonly labels: readonly Uint8Array[];
  readonly exceptionMask: Uint8Array;
  readonly exceptionValues: Uint8Array;
  readonly metrics: {
    readonly rmse: number;
    readonly maximumAbsoluteError: number;
    readonly exceptionCount: number;
    readonly exceptionRatio: number;
    readonly sampleRmse: number;
    readonly assignmentBackend: 'wasm-workers' | 'javascript';
    readonly assignmentWorkerCount: number;
    readonly assignmentElapsedMs: number;
    readonly attempts: readonly {
      readonly template: ShTemplate['name'];
      readonly sampleRmse: number;
      readonly estimatedExceptionRatio: number;
      readonly estimatedBytesPerInstance: number;
    }[];
  };
}

interface ShAssignmentResult {
  readonly labels: readonly Uint8Array[];
  readonly squaredErrors: readonly Float64Array[];
  readonly maximumErrors: readonly Float32Array[];
  readonly backend: 'wasm-workers' | 'javascript';
  readonly workerCount: number;
  readonly elapsedMs: number;
}

interface PackedShTrees {
  readonly levelDimensions: Uint32Array;
  readonly dimensionCounts: Uint32Array;
  readonly nodeSplits: Float32Array;
  readonly centers: Float32Array;
  readonly levelCount: number;
  readonly maximumDimensions: number;
}

interface SourceHeader {
  readonly fileIndex: number;
  readonly file: File;
  readonly header: Raw4DHeader;
  readonly range: { readonly firstFrame: number; readonly lastFrame: number };
}

interface IndexedMemorySource extends Raw4DMemorySnapshot {
  readonly sourceIndex: number;
  readonly range: { readonly firstFrame: number; readonly lastFrame: number };
}

interface PreparedV26Source {
  readonly name: string;
  readonly sourceEncoding: Raw4DAsset['sourceEncoding'];
  readonly sourceShBands: number;
  readonly descriptor: FourCgsSegment;
  readonly originalPointCount: number;
  readonly temporalLayout?: Raw4DTemporalLayout;
  readonly compacted: {
    readonly segment: BrowserSegment;
    readonly sourceSha256: string;
    readonly deleted: number;
    readonly compactedBytes: number;
  };
}

interface PermanentLayout {
  readonly slotCount: number;
  readonly maps: readonly Int32Array[];
  readonly slotToLocal: readonly Int32Array[];
  readonly continuedLocal: readonly Uint8Array[];
  readonly matches: readonly Record<string, unknown>[];
}

interface MortonLayout extends PermanentLayout {
  readonly activeSlots: readonly Int32Array[];
  readonly trackCount: number;
  readonly sourcePermanentTrackCount: number;
  readonly droppedTrackCount: number;
}

interface StoredStream {
  readonly entry: FourCgsStreamEntry;
  readonly bytes: Uint8Array;
}

interface ParallelAttributeResult {
  readonly task: 'position' | 'rotation' | 'scale0' | 'scale1' | 'scale2' | 'dc';
  readonly encoded: Uint8Array;
  readonly metrics: Record<string, any>;
  readonly elapsedMs: number;
}

export class FourCgsHighCompressionUnsupportedError extends Error {}

function hash(bytes: Uint8Array): string {
  return bytesToHex(nobleSha256(bytes));
}

function countDeleted(words: Uint32Array, pointCount: number): number {
  if (words.length !== Math.ceil(pointCount / 32)) {
    throw new Error(`RAW4D 删除位集长度不一致：${words.length}/${Math.ceil(pointCount / 32)}。`);
  }
  let total = 0;
  for (let stableId = 0; stableId < pointCount; stableId += 1) {
    if (words[stableId >>> 5] & (1 << (stableId & 31))) total += 1;
  }
  return total;
}

function allocateEncodingRows(length: number): Uint16Array {
  const useShared = globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
  return new Uint16Array(useShared
    ? new SharedArrayBuffer(length * Uint16Array.BYTES_PER_ELEMENT)
    : new ArrayBuffer(length * Uint16Array.BYTES_PER_ELEMENT));
}

function isDeleted(words: Uint32Array, stableId: number): boolean {
  return Boolean(words[stableId >>> 5] & (1 << (stableId & 31)));
}

function compactTemporalLayout(
  layout: Raw4DTemporalLayout | undefined,
  deletionWords: Uint32Array,
): Raw4DTemporalLayout | undefined {
  if (!layout) return undefined;
  let firstPoint = 0;
  const pointGroups = layout.pointGroups.map((group) => {
    let pointCount = 0;
    for (let local = 0; local < group.pointCount; local += 1) {
      if (!isDeleted(deletionWords, group.firstPoint + local)) pointCount += 1;
    }
    const compacted = { ...group, firstPoint, pointCount };
    firstPoint += pointCount;
    return compacted;
  }).filter((group) => group.pointCount > 0);
  return { ...layout, pointGroups };
}

function bankCount(segment: BrowserSegment, prefix: string): number {
  let maximum = -1;
  const expression = new RegExp(`^${prefix}_(\\d+)(?:_|$)`);
  for (const name of segment.propertyNames) {
    const match = expression.exec(name);
    if (match) maximum = Math.max(maximum, Number(match[1]));
  }
  return maximum + 1;
}

function exactBoundaryPositionKey(segment: BrowserSegment, local: number, bank: number): number {
  const source = local * segment.propertyNames.length;
  const x = segment.rows[source + segment.propertyIndex.get(`xyz_bank_${bank}_x`)!];
  const y = segment.rows[source + segment.propertyIndex.get(`xyz_bank_${bank}_y`)!];
  const z = segment.rows[source + segment.propertyIndex.get(`xyz_bank_${bank}_z`)!];
  return x * 4294967296 + y * 65536 + z;
}

function exactBoundaryTieScore(
  previous: BrowserSegment,
  previousLocal: number,
  current: BrowserSegment,
  currentLocal: number,
): number {
  const previousBase = previousLocal * previous.propertyNames.length;
  const currentBase = currentLocal * current.propertyNames.length;
  let score = 0;
  for (let component = 0; component < SH_DIMENSIONS; component += 1) {
    const name = `f_rest_${component}`;
    if (previous.rows[previousBase + previous.propertyIndex.get(name)!]
      === current.rows[currentBase + current.propertyIndex.get(name)!]) score += 4;
  }
  const previousDcBank = bankCount(previous, 'f_dc_bank') - 1;
  for (let component = 0; component < 3; component += 1) {
    if (previous.rows[previousBase + previous.propertyIndex.get(`f_dc_bank_${previousDcBank}_${component}`)!]
      === current.rows[currentBase + current.propertyIndex.get(`f_dc_bank_0_${component}`)!]) score += 2;
  }
  return score;
}

// #WDD-gpt 2026-08-16 - 删除后重新按相邻段精确边界 Position 建立永久 Track；重复坐标继续以 SH/DC 位模式消歧。
function buildExactBoundaryPermanentTrackMaps(segments: readonly BrowserSegment[]): PermanentLayout {
  const maps: Int32Array[] = [Int32Array.from({ length: segments[0].count }, (_, index) => index)];
  const continuedLocal: Uint8Array[] = [new Uint8Array(segments[0].count)];
  const matches: Record<string, unknown>[] = [];
  let trackCount = segments[0].count;
  for (let segmentIndex = 1; segmentIndex < segments.length; segmentIndex += 1) {
    const previous = segments[segmentIndex - 1];
    const current = segments[segmentIndex];
    const previousBank = bankCount(previous, 'xyz_bank') - 1;
    const buckets = new Map<number, number[]>();
    for (let previousLocal = 0; previousLocal < previous.count; previousLocal += 1) {
      const key = exactBoundaryPositionKey(previous, previousLocal, previousBank);
      const candidates = buckets.get(key) ?? [];
      candidates.push(previousLocal);
      buckets.set(key, candidates);
    }
    const currentMap = new Int32Array(current.count);
    const currentContinued = new Uint8Array(current.count);
    let matchedCount = 0;
    let duplicateCandidateCount = 0;
    for (let currentLocal = 0; currentLocal < current.count; currentLocal += 1) {
      const candidates = buckets.get(exactBoundaryPositionKey(current, currentLocal, 0));
      if (!candidates?.length) {
        currentMap[currentLocal] = trackCount++;
        continue;
      }
      let candidateIndex = candidates.length - 1;
      if (candidates.length > 1) {
        duplicateCandidateCount += 1;
        let bestScore = -1;
        for (let index = 0; index < candidates.length; index += 1) {
          const score = exactBoundaryTieScore(previous, candidates[index], current, currentLocal);
          if (score > bestScore) {
            bestScore = score;
            candidateIndex = index;
          }
        }
      }
      const previousLocal = candidates[candidateIndex];
      candidates[candidateIndex] = candidates[candidates.length - 1];
      candidates.pop();
      currentMap[currentLocal] = maps[segmentIndex - 1][previousLocal];
      currentContinued[currentLocal] = 1;
      matchedCount += 1;
    }
    maps.push(currentMap);
    continuedLocal.push(currentContinued);
    matches.push({
      previous: previous.path,
      current: current.path,
      matchedCount,
      matchedRatio: matchedCount / current.count,
      duplicateCandidateCount,
      method: 'exact_fp16_boundary_position_sh_dc_tie_break',
    });
  }
  const slotToLocal = maps.map((map) => {
    const inverse = new Int32Array(trackCount);
    inverse.fill(-1);
    for (let local = 0; local < map.length; local += 1) inverse[map[local]] = local;
    return inverse;
  });
  return { slotCount: trackCount, maps, slotToLocal, continuedLocal, matches };
}

function sourceFrameRange(name: string, totalFrames: number): { readonly firstFrame: number; readonly lastFrame: number } {
  const range = raw4DSequenceFrameRangeFromName(name);
  const firstFrame = range?.firstFrame ?? 0;
  const lastFrame = range?.lastFrame ?? firstFrame + totalFrames - 1;
  if (lastFrame - firstFrame + 1 !== totalFrames) {
    throw new Error(`${name} 的文件名帧范围与 total_frames=${totalFrames} 不一致。`);
  }
  return { firstFrame, lastFrame };
}

function orderedHeaders(headers: readonly SourceHeader[]): readonly SourceHeader[] {
  if (headers.every((source) => raw4DSequenceFrameRangeFromName(source.file.name))) {
    return [...headers].sort((left, right) => left.range.firstFrame - right.range.firstFrame || left.file.name.localeCompare(right.file.name));
  }
  let firstFrame = 0;
  // #WDD-gpt 2026-08-16 - 无帧号文件名时保留拖入顺序，并按相邻段共享首尾关键帧建立连续时间轴。
  return [...headers].sort((left, right) => left.fileIndex - right.fileIndex).map((source) => {
    const lastFrame = firstFrame + source.header.totalFrames - 1;
    const result = { ...source, range: { firstFrame, lastFrame } };
    firstFrame = lastFrame;
    return result;
  });
}

function segmentDescriptor(source: SourceHeader, gaussianCount: number): FourCgsSegment {
  return {
    name: source.file.name.replace(/\.(?:raw4d|ply4)$/i, ''),
    firstFrame: source.range.firstFrame,
    lastFrame: source.range.lastFrame,
    gaussianCount,
    totalFrames: source.header.totalFrames,
    bankCounts: {
      position: raw4DBankCount(source.header.propertyNames, RAW4D_TRACK_DEFINITIONS.position),
      rotation: raw4DBankCount(source.header.propertyNames, RAW4D_TRACK_DEFINITIONS.rotation),
      colorDc: raw4DBankCount(source.header.propertyNames, RAW4D_TRACK_DEFINITIONS.colorDc),
      scale: raw4DBankCount(source.header.propertyNames, RAW4D_TRACK_DEFINITIONS.scale),
      opacity: raw4DBankCount(source.header.propertyNames, RAW4D_TRACK_DEFINITIONS.opacity),
    },
    keyframeStrides: {
      position: raw4DTrackStride(source.header.comments, RAW4D_TRACK_DEFINITIONS.position),
      rotation: raw4DTrackStride(source.header.comments, RAW4D_TRACK_DEFINITIONS.rotation),
      colorDc: raw4DTrackStride(source.header.comments, RAW4D_TRACK_DEFINITIONS.colorDc),
      scale: raw4DTrackStride(source.header.comments, RAW4D_TRACK_DEFINITIONS.scale),
      opacity: raw4DTrackStride(source.header.comments, RAW4D_TRACK_DEFINITIONS.opacity),
    },
  };
}

async function compactSegment(
  source: SourceHeader,
  words: Uint32Array,
): Promise<{ readonly segment: BrowserSegment; readonly sourceSha256: string; readonly deleted: number; readonly compactedBytes: number }> {
  const deleted = countDeleted(words, source.header.vertexCount);
  if (deleted === source.header.vertexCount) throw new Error(`${source.file.name} 的高斯点已全部删除，无法导出空片段。`);
  const headerBytes = new Uint8Array(await source.file.slice(0, source.header.dataOffset).arrayBuffer());
  const payloadBytes = new Uint8Array(await source.file.slice(source.header.dataOffset).arrayBuffer());
  const sourceHasher = nobleSha256.create();
  sourceHasher.update(headerBytes);
  sourceHasher.update(payloadBytes);
  const sourceSha256 = bytesToHex(sourceHasher.digest());
  const sourceRows = new Uint16Array(payloadBytes.buffer, payloadBytes.byteOffset, payloadBytes.byteLength / 2);
  const descriptor = segmentDescriptor(source, source.header.vertexCount - deleted);
  const propertyNames = fourCgsDecodedPropertyNames(descriptor);
  const sourceIndices = new Map(source.header.propertyNames.map((name, index) => [name, index]));
  const indices = propertyNames.map((name) => {
    const index = sourceIndices.get(name);
    if (index === undefined) throw new Error(`${source.file.name} 缺少 V2.6 属性 ${name}。`);
    return index;
  });
  const rows = allocateEncodingRows(descriptor.gaussianCount * propertyNames.length);
  let destination = 0;
  for (let stableId = 0; stableId < source.header.vertexCount; stableId += 1) {
    if (isDeleted(words, stableId)) continue;
    const sourceOffset = stableId * source.header.propertyNames.length;
    const destinationOffset = destination * propertyNames.length;
    for (let property = 0; property < indices.length; property += 1) {
      rows[destinationOffset + property] = sourceRows[sourceOffset + indices[property]];
    }
    destination += 1;
  }
  if (destination !== descriptor.gaussianCount) throw new Error(`${source.file.name} 删除压实计数不一致。`);
  const sourceHeaderText = new TextDecoder('ascii').decode(headerBytes);
  const compactedHeaderBytes = new TextEncoder().encode(sourceHeaderText.replace(
    /(^element\s+vertex\s+)\d+(\s*$)/m,
    `$1${descriptor.gaussianCount}$2`,
  )).byteLength;
  return {
    segment: {
      path: source.file.name,
      count: descriptor.gaussianCount,
      propertyNames,
      propertyIndex: new Map(propertyNames.map((name, index) => [name, index])),
      comments: source.header.comments,
      rows,
    },
    sourceSha256,
    deleted,
    compactedBytes: compactedHeaderBytes + descriptor.gaussianCount * source.header.recordBytes,
  };
}

function memoryTrackStride(track: Raw4DTrack, totalFrames: number, sourceName: string): number {
  if (track.keyframes.length === 1) {
    if (track.keyframes[0] !== 0) {
      throw new FourCgsHighCompressionUnsupportedError(`${sourceName} 的静态内存轨迹必须从第 0 帧开始。`);
    }
    return Math.max(1, totalFrames - 1);
  }
  if (track.keyframes.length < 1) throw new FourCgsHighCompressionUnsupportedError(`${sourceName} 的内存轨迹为空。`);
  const stride = track.keyframes[1] - track.keyframes[0];
  const canonical = raw4DCanonicalKeyframes(totalFrames, stride, track.keyframes.length);
  if (canonical.some((frame, index) => frame !== track.keyframes[index])) {
    throw new FourCgsHighCompressionUnsupportedError(`${sourceName} 的内存关键帧不是 canonical 等步长序列。`);
  }
  return stride;
}

function memoryTrackBankCount(track: Raw4DTrack, totalFrames: number): number {
  return track.keyframes.length === 1 && totalFrames > 1 ? 2 : track.keyframes.length;
}

function memoryTrackColumns(track: Raw4DTrack, totalFrames: number): readonly Raw4DAsset['lifetimeMu'][] {
  // #WDD-gpt 2026-08-18 - 4CGS 清单需要首尾 canonical bank；静态回退轨迹复用同一 SoA 列，不复制 Canonical RAM。
  return track.keyframes.length === 1 && totalFrames > 1
    ? [...track.values, ...track.values]
    : track.values;
}

function memoryDescriptor(source: IndexedMemorySource, gaussianCount: number): FourCgsSegment {
  const { asset } = source;
  return {
    name: source.name.replace(/\.(?:raw4d|ply4|4gs)$/i, ''),
    firstFrame: source.range.firstFrame,
    lastFrame: source.range.lastFrame,
    gaussianCount,
    totalFrames: asset.totalFrames,
    frameRate: asset.frameRate,
    bankCounts: {
      position: memoryTrackBankCount(asset.position, asset.totalFrames),
      rotation: memoryTrackBankCount(asset.rotation, asset.totalFrames),
      colorDc: memoryTrackBankCount(asset.colorDc, asset.totalFrames),
      scale: memoryTrackBankCount(asset.scale, asset.totalFrames),
      opacity: memoryTrackBankCount(asset.opacity, asset.totalFrames),
    },
    keyframeStrides: {
      position: memoryTrackStride(asset.position, asset.totalFrames, source.name),
      rotation: memoryTrackStride(asset.rotation, asset.totalFrames, source.name),
      colorDc: memoryTrackStride(asset.colorDc, asset.totalFrames, source.name),
      scale: memoryTrackStride(asset.scale, asset.totalFrames, source.name),
      opacity: memoryTrackStride(asset.opacity, asset.totalFrames, source.name),
    },
    positionTiming: asset.positionTiming,
    opacityTiming: asset.opacityTiming,
  };
}

function orderedMemorySources(sources: readonly Raw4DMemorySnapshot[]): readonly IndexedMemorySource[] {
  const indexed = sources.map((source, sourceIndex): IndexedMemorySource => ({
    ...source,
    sourceIndex,
    range: sourceFrameRange(source.name, source.asset.totalFrames),
  }));
  if (indexed.every((source) => raw4DSequenceFrameRangeFromName(source.name))) {
    return [...indexed].sort((left, right) => (
      left.range.firstFrame - right.range.firstFrame || left.name.localeCompare(right.name)
    ));
  }
  let firstFrame = 0;
  // #WDD-gpt 2026-08-16 - 没有帧号的内存片段仍遵循拖入顺序，并继续复用首尾关键帧。
  return indexed.sort((left, right) => left.sourceIndex - right.sourceIndex).map((source) => {
    const lastFrame = firstFrame + source.asset.totalFrames - 1;
    const ordered = { ...source, range: { firstFrame, lastFrame } };
    firstFrame = lastFrame;
    return ordered;
  });
}

// #WDD-gpt 2026-08-18 - Float32 PLY4 保持场景 Canonical RAM 原样，只在 Worker 的 V2.6 编码工作副本中显式量化为 FP16。
async function compactMemorySegment(source: IndexedMemorySource): Promise<PreparedV26Source> {
  const { asset, deletionWords } = source;
  if (![0, 9, 24, SH_DIMENSIONS].includes(asset.shRest.length)) {
    throw new FourCgsHighCompressionUnsupportedError(`${source.name} 的非 DC SH 系数数量 ${asset.shRest.length} 不对应 SH0/SH1/SH2/SH3。`);
  }
  const deleted = countDeleted(deletionWords, asset.splatCount);
  if (deleted === asset.splatCount) throw new Error(`${source.name} 的高斯点已全部删除，无法导出空片段。`);
  const descriptor = memoryDescriptor(source, asset.splatCount - deleted);
  const propertyNames = fourCgsDecodedPropertyNames(descriptor);
  // #WDD-gpt 2026-08-20 - 4CGS V2.6 固定使用 SH3 载荷；低阶 4GS 仅在编码副本补零，不扩大或改写场景 Canonical RAM。
  const shZero = asset.sourceEncoding === 'float16'
    ? new Uint16Array(asset.splatCount)
    : new Float32Array(asset.splatCount);
  const paddedShRest = Array.from({ length: SH_DIMENSIONS }, (_, index) => asset.shRest[index] ?? shZero);
  const columns = [
    ...memoryTrackColumns(asset.position, asset.totalFrames),
    ...memoryTrackColumns(asset.rotation, asset.totalFrames),
    ...memoryTrackColumns(asset.colorDc, asset.totalFrames),
    ...memoryTrackColumns(asset.scale, asset.totalFrames),
    ...memoryTrackColumns(asset.opacity, asset.totalFrames),
    asset.lifetimeMu,
    asset.lifetimeW,
    ...paddedShRest,
  ];
  const sourceArrayType = asset.sourceEncoding === 'float16' ? Uint16Array : Float32Array;
  if (columns.length !== propertyNames.length || columns.some((column) => !(column instanceof sourceArrayType))) {
    throw new FourCgsHighCompressionUnsupportedError(`${source.name} 的 Canonical RAM 属性布局与 V2.6 不一致。`);
  }
  const floatToHalf = asset.sourceEncoding === 'float32'
    ? (await import('../../../../../scripts/fourcgs-prs-codec.mjs')).floatToHalf
    : null;
  const rows = allocateEncodingRows(descriptor.gaussianCount * propertyNames.length);
  let destination = 0;
  for (let stableId = 0; stableId < asset.splatCount; stableId += 1) {
    if (isDeleted(deletionWords, stableId)) continue;
    const destinationOffset = destination * propertyNames.length;
    for (let property = 0; property < columns.length; property += 1) {
      if (asset.sourceEncoding === 'float16') {
        rows[destinationOffset + property] = (columns[property] as Uint16Array)[stableId];
      } else {
        const value = (columns[property] as Float32Array)[stableId];
        if (!Number.isFinite(value) || Math.abs(value) > 65_504) {
          throw new FourCgsHighCompressionUnsupportedError(
            `${source.name} 的 ${propertyNames[property]}[${stableId}] 无法安全量化为 FP16：${value}。`,
          );
        }
        rows[destinationOffset + property] = floatToHalf!(value);
      }
    }
    destination += 1;
  }
  if (destination !== descriptor.gaussianCount) throw new Error(`${source.name} 的内存删除压实计数不一致。`);
  const sourceHasher = nobleSha256.create();
  sourceHasher.update(new TextEncoder().encode(JSON.stringify({
    name: source.name,
    totalFrames: asset.totalFrames,
    keyframeStrides: descriptor.keyframeStrides,
    propertyNames,
  })));
  sourceHasher.update(new Uint8Array(rows.buffer));
  const canonicalNames = fourCgsCanonicalRaw4DPropertyNames(descriptor);
  const sourceScalarBytes = asset.sourceEncoding === 'float16'
    ? Uint16Array.BYTES_PER_ELEMENT
    : Float32Array.BYTES_PER_ELEMENT;
  const compactedBytes = fourCgsCanonicalRaw4DHeader(descriptor, canonicalNames).byteLength
    + descriptor.gaussianCount * canonicalNames.length * sourceScalarBytes;
  return {
    name: source.name,
    sourceEncoding: asset.sourceEncoding,
    sourceShBands: asset.shBands,
    descriptor,
    originalPointCount: asset.splatCount,
    temporalLayout: compactTemporalLayout(asset.temporalLayout, deletionWords),
    compacted: {
      segment: {
        path: source.name,
        count: descriptor.gaussianCount,
        propertyNames,
        propertyIndex: new Map(propertyNames.map((name, index) => [name, index])),
        comments: new Map([
          ['total_frames', String(asset.totalFrames)],
          ['xyz_bank_keyframe_stride', String(descriptor.keyframeStrides!.position)],
          ['rot_bank_keyframe_stride', String(descriptor.keyframeStrides!.rotation)],
          ['features_dc_bank_keyframe_stride', String(descriptor.keyframeStrides!.colorDc)],
          ['scaling_bank_keyframe_stride', String(descriptor.keyframeStrides!.scale)],
          ['opacity_bank_keyframe_stride', String(descriptor.keyframeStrides!.opacity)],
        ]),
        rows,
      },
      sourceSha256: bytesToHex(sourceHasher.digest()),
      deleted,
      compactedBytes,
    },
  };
}

function computeInputCrop(
  segments: readonly BrowserSegment[],
  halfToFloat: (bits: number) => number,
): { readonly center: readonly [number, number, number]; readonly halfExtent: number } {
  const minimum = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const maximum = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const segment of segments) {
    const banks = bankCount(segment, 'xyz_bank');
    for (let bank = 0; bank < banks; bank += 1) {
      const propertyX = segment.propertyIndex.get(`xyz_bank_${bank}_x`)!;
      const propertyY = segment.propertyIndex.get(`xyz_bank_${bank}_y`)!;
      const propertyZ = segment.propertyIndex.get(`xyz_bank_${bank}_z`)!;
      const stride = segment.propertyNames.length;
      for (let local = 0; local < segment.count; local += 1) {
        const base = local * stride;
        const x = halfToFloat(segment.rows[base + propertyX]);
        const y = halfToFloat(segment.rows[base + propertyY]);
        const z = halfToFloat(segment.rows[base + propertyZ]);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
          throw new FourCgsHighCompressionUnsupportedError(`${segment.path} Position 含有非有限数。`);
        }
        if (x < minimum[0]) minimum[0] = x;
        if (y < minimum[1]) minimum[1] = y;
        if (z < minimum[2]) minimum[2] = z;
        if (x > maximum[0]) maximum[0] = x;
        if (y > maximum[1]) maximum[1] = y;
        if (z > maximum[2]) maximum[2] = z;
      }
    }
  }
  const center = minimum.map((value, axis) => (value + maximum[axis]) * 0.5) as [number, number, number];
  const radius = Math.max(...maximum.map((value, axis) => Math.max(value - center[axis], center[axis] - minimum[axis])));
  return { center, halfExtent: Math.max(POSITION_STEP * 4, radius + POSITION_STEP * 2) };
}

const SH_TEMPLATES: readonly ShTemplate[] = [
  { name: 'compact-5x9d', levels: 5 },
  { name: 'balanced-10x4-5d', levels: 10 },
  { name: 'quality-15x3d', levels: 15 },
];

function shLevelDimensions(level: number, levels: number): readonly number[] {
  const firstBasis = Math.floor(level * 15 / levels);
  const lastBasis = Math.floor((level + 1) * 15 / levels);
  const dimensions: number[] = [];
  for (let channel = 0; channel < 3; channel += 1) {
    for (let basis = firstBasis; basis < lastBasis; basis += 1) dimensions.push(channel * 15 + basis);
  }
  return dimensions;
}

function squaredDistance(values: Float32Array, offset: number, center: Float32Array): number {
  let result = 0;
  for (let dimension = 0; dimension < center.length; dimension += 1) {
    const difference = values[offset + dimension] - center[dimension];
    result += difference * difference;
  }
  return result;
}

function meanOf(values: Float32Array, indices: readonly number[], dimensions: number, fallback?: Float32Array): Float32Array {
  if (indices.length === 0) return fallback ? fallback.slice() : new Float32Array(dimensions);
  const mean = new Float32Array(dimensions);
  for (const index of indices) {
    const offset = index * dimensions;
    for (let dimension = 0; dimension < dimensions; dimension += 1) mean[dimension] += values[offset + dimension];
  }
  for (let dimension = 0; dimension < dimensions; dimension += 1) mean[dimension] /= indices.length;
  return mean;
}

function trainShTree(
  values: Float32Array,
  dimensions: readonly number[],
  floatToHalf: (value: number) => number,
  halfToFloat: (bits: number) => number,
): ShProductLevel {
  const vectorDimensions = dimensions.length;
  const nodes: ShTreeNode[] = new Array(SH_CODEBOOK_SIZE - 1);
  const centers = new Float32Array(SH_CODEBOOK_SIZE * SH_DIMENSIONS);
  const all = Array.from({ length: values.length / vectorDimensions }, (_, index) => index);

  const build = (indices: readonly number[], node: number, depth: number, fallback?: Float32Array): void => {
    const mean = meanOf(values, indices, vectorDimensions, fallback);
    if (depth === 8) {
      const label = node - (SH_CODEBOOK_SIZE - 1);
      for (let component = 0; component < vectorDimensions; component += 1) {
        centers[label * SH_DIMENSIONS + dimensions[component]] = halfToFloat(floatToHalf(mean[component]));
      }
      return;
    }
    let first: Float32Array<ArrayBufferLike> = mean.slice();
    let second: Float32Array<ArrayBufferLike> = mean.slice();
    if (indices.length > 1) {
      let farthest = indices[0];
      let farthestDistance = -1;
      for (const index of indices) {
        const distance = squaredDistance(values, index * vectorDimensions, mean);
        if (distance > farthestDistance) {
          farthest = index;
          farthestDistance = distance;
        }
      }
      first = values.slice(farthest * vectorDimensions, (farthest + 1) * vectorDimensions);
      farthestDistance = -1;
      for (const index of indices) {
        const distance = squaredDistance(values, index * vectorDimensions, first);
        if (distance > farthestDistance) {
          farthest = index;
          farthestDistance = distance;
        }
      }
      second = values.slice(farthest * vectorDimensions, (farthest + 1) * vectorDimensions);
    }
    let left: number[] = [];
    let right: number[] = [];
    for (let iteration = 0; iteration < 5; iteration += 1) {
      left = [];
      right = [];
      for (const index of indices) {
        const offset = index * vectorDimensions;
        (squaredDistance(values, offset, first) <= squaredDistance(values, offset, second) ? left : right).push(index);
      }
      if (left.length === 0 || right.length === 0) {
        const split = Math.ceil(indices.length / 2);
        left = [...indices.slice(0, split)];
        right = [...indices.slice(split)];
      }
      first = meanOf(values, left, vectorDimensions, mean);
      second = meanOf(values, right, vectorDimensions, mean);
    }
    nodes[node] = { left: first, right: second };
    build(left, node * 2 + 1, depth + 1, first);
    build(right, node * 2 + 2, depth + 1, second);
  };
  build(all, 0, 0);
  return { dimensions, nodes, centers };
}

function assignShTree(level: ShProductLevel, values: Float32Array): number {
  let node = 0;
  while (node < SH_CODEBOOK_SIZE - 1) {
    const split = level.nodes[node];
    node = squaredDistance(values, 0, split.left) <= squaredDistance(values, 0, split.right)
      ? node * 2 + 1
      : node * 2 + 2;
  }
  return node - (SH_CODEBOOK_SIZE - 1);
}

function sampleReferences(segments: readonly BrowserSegment[], maximum = 32768): readonly [number, number][] {
  const total = segments.reduce((sum, segment) => sum + segment.count, 0);
  const count = Math.min(total, maximum);
  const prefix: number[] = [];
  let running = 0;
  for (const segment of segments) {
    prefix.push(running);
    running += segment.count;
  }
  return Array.from({ length: count }, (_, sample): [number, number] => {
    const global = Math.min(total - 1, Math.floor((sample + 0.5) * total / count));
    let segmentIndex = prefix.length - 1;
    while (segmentIndex > 0 && global < prefix[segmentIndex]) segmentIndex -= 1;
    return [segmentIndex, global - prefix[segmentIndex]];
  });
}

function shValue(
  segment: BrowserSegment,
  local: number,
  dimension: number,
  halfToFloat: (bits: number) => number,
): number {
  return halfToFloat(segment.rows[local * segment.propertyNames.length + segment.propertyIndex.get(`f_rest_${dimension}`)!]);
}

function trainShTemplate(
  segments: readonly BrowserSegment[],
  template: ShTemplate,
  samples: readonly [number, number][],
  floatToHalf: (value: number) => number,
  halfToFloat: (bits: number) => number,
): {
  readonly levels: readonly ShProductLevel[];
  readonly sampleRmse: number;
  readonly estimatedExceptionRatio: number;
  readonly estimatedBytesPerInstance: number;
} {
  const levels: ShProductLevel[] = [];
  let squaredError = 0;
  const vectorSquaredErrors = new Float32Array(samples.length);
  const vectorMaximumErrors = new Float32Array(samples.length);
  const sampleLabels = new Uint8Array(samples.length * template.levels);
  for (let levelIndex = 0; levelIndex < template.levels; levelIndex += 1) {
    const dimensions = shLevelDimensions(levelIndex, template.levels);
    const values = new Float32Array(samples.length * dimensions.length);
    for (let sample = 0; sample < samples.length; sample += 1) {
      const [segmentIndex, local] = samples[sample];
      for (let component = 0; component < dimensions.length; component += 1) {
        values[sample * dimensions.length + component] = shValue(segments[segmentIndex], local, dimensions[component], halfToFloat);
      }
    }
    const trained = trainShTree(values, dimensions, floatToHalf, halfToFloat);
    levels.push(trained);
    const vector = new Float32Array(dimensions.length);
    for (let sample = 0; sample < samples.length; sample += 1) {
      vector.set(values.subarray(sample * dimensions.length, (sample + 1) * dimensions.length));
      const label = assignShTree(trained, vector);
      sampleLabels[sample * template.levels + levelIndex] = label;
      for (let component = 0; component < dimensions.length; component += 1) {
        const difference = vector[component] - trained.centers[label * SH_DIMENSIONS + dimensions[component]];
        squaredError += difference * difference;
        vectorSquaredErrors[sample] += difference * difference;
        vectorMaximumErrors[sample] = Math.max(vectorMaximumErrors[sample], Math.abs(difference));
      }
    }
  }
  let retainedSquaredError = squaredError;
  let exceptionCount = 0;
  const exceptions = new Uint8Array(samples.length);
  for (let sample = 0; sample < samples.length; sample += 1) {
    if (vectorMaximumErrors[sample] <= SH_MAXIMUM_COEFFICIENT_ERROR) continue;
    exceptions[sample] = 1;
    retainedSquaredError -= vectorSquaredErrors[sample];
    exceptionCount += 1;
  }
  const targetSquaredError = SH_TARGET_RMSE * SH_TARGET_RMSE * samples.length * SH_DIMENSIONS;
  if (retainedSquaredError > targetSquaredError) {
    const remaining = Array.from({ length: samples.length }, (_, index) => index)
      .filter((index) => !exceptions[index])
      .sort((left, right) => vectorSquaredErrors[right] - vectorSquaredErrors[left]);
    for (const sample of remaining) {
      if (retainedSquaredError <= targetSquaredError) break;
      retainedSquaredError -= vectorSquaredErrors[sample];
      exceptions[sample] = 1;
      exceptionCount += 1;
    }
  }
  const estimatedExceptionRatio = exceptionCount / samples.length;
  const sampleExceptionMask = new Uint8Array(Math.ceil(samples.length / 8));
  const sampleExceptionValues = new Uint8Array(exceptionCount * SH_DIMENSIONS * 2);
  const sampleExceptionView = new DataView(sampleExceptionValues.buffer);
  let exception = 0;
  for (let sample = 0; sample < samples.length; sample += 1) {
    if (!exceptions[sample]) continue;
    sampleExceptionMask[sample >>> 3] |= 1 << (sample & 7);
    const [segmentIndex, local] = samples[sample];
    const segment = segments[segmentIndex];
    const base = local * segment.propertyNames.length;
    for (let dimension = 0; dimension < SH_DIMENSIONS; dimension += 1) {
      sampleExceptionView.setUint16(
        (exception * SH_DIMENSIONS + dimension) * 2,
        segment.rows[base + segment.propertyIndex.get(`f_rest_${dimension}`)!],
        true,
      );
    }
    exception += 1;
  }
  const totalInstances = segments.reduce((sum, segment) => sum + segment.count, 0);
  const estimatedStoredBytes = zlibSync(sampleLabels, { level: 9 }).byteLength
    + zlibSync(sampleExceptionMask, { level: 9 }).byteLength
    + zlibSync(sampleExceptionValues, { level: 9 }).byteLength;
  const codebookBytesPerInstance = (SH_DIMENSIONS * 2 + template.levels * SH_CODEBOOK_SIZE * SH_DIMENSIONS * 2) / totalInstances;
  return {
    levels,
    sampleRmse: Math.sqrt(squaredError / (samples.length * SH_DIMENSIONS)),
    estimatedExceptionRatio,
    estimatedBytesPerInstance: estimatedStoredBytes / samples.length + codebookBytesPerInstance,
  };
}

function packShTrees(levels: readonly ShProductLevel[]): PackedShTrees {
  const maximumDimensions = Math.max(...levels.map((level) => level.dimensions.length));
  const levelDimensions = new Uint32Array(levels.length * maximumDimensions);
  const dimensionCounts = new Uint32Array(levels.length);
  const nodeSplits = new Float32Array(levels.length * (SH_CODEBOOK_SIZE - 1) * 2 * maximumDimensions);
  const centers = new Float32Array(levels.length * SH_CODEBOOK_SIZE * maximumDimensions);
  for (let levelIndex = 0; levelIndex < levels.length; levelIndex += 1) {
    const level = levels[levelIndex];
    dimensionCounts[levelIndex] = level.dimensions.length;
    for (let component = 0; component < level.dimensions.length; component += 1) {
      levelDimensions[levelIndex * maximumDimensions + component] = level.dimensions[component];
    }
    for (let node = 0; node < level.nodes.length; node += 1) {
      const split = level.nodes[node];
      for (let component = 0; component < level.dimensions.length; component += 1) {
        const base = ((levelIndex * (SH_CODEBOOK_SIZE - 1) + node) * 2) * maximumDimensions + component;
        nodeSplits[base] = split.left[component];
        nodeSplits[base + maximumDimensions] = split.right[component];
      }
    }
    for (let label = 0; label < SH_CODEBOOK_SIZE; label += 1) {
      for (let component = 0; component < level.dimensions.length; component += 1) {
        centers[(levelIndex * SH_CODEBOOK_SIZE + label) * maximumDimensions + component]
          = level.centers[label * SH_DIMENSIONS + level.dimensions[component]];
      }
    }
  }
  return { levelDimensions, dimensionCounts, nodeSplits, centers, levelCount: levels.length, maximumDimensions };
}

function assignShCpu(
  segments: readonly BrowserSegment[],
  levels: readonly ShProductLevel[],
  halfToFloat: (bits: number) => number,
): ShAssignmentResult {
  const startedAt = performance.now();
  const labels = segments.map((segment) => new Uint8Array(segment.count * levels.length));
  const squaredErrors = segments.map((segment) => new Float64Array(segment.count));
  const maximumErrors = segments.map((segment) => new Float32Array(segment.count));
  const vector = new Float32Array(Math.max(...levels.map((level) => level.dimensions.length)));
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    for (let local = 0; local < segment.count; local += 1) {
      let vectorSquaredError = 0;
      let vectorMaximumError = 0;
      for (let levelIndex = 0; levelIndex < levels.length; levelIndex += 1) {
        const level = levels[levelIndex];
        for (let component = 0; component < level.dimensions.length; component += 1) {
          vector[component] = shValue(segment, local, level.dimensions[component], halfToFloat);
        }
        const label = assignShTree(level, vector.subarray(0, level.dimensions.length));
        labels[segmentIndex][local * levels.length + levelIndex] = label;
        for (let component = 0; component < level.dimensions.length; component += 1) {
          const difference = vector[component] - level.centers[label * SH_DIMENSIONS + level.dimensions[component]];
          const absolute = Math.abs(difference);
          vectorSquaredError += difference * difference;
          vectorMaximumError = Math.max(vectorMaximumError, absolute);
        }
      }
      squaredErrors[segmentIndex][local] = vectorSquaredError;
      maximumErrors[segmentIndex][local] = vectorMaximumError;
    }
  }
  return {
    labels,
    squaredErrors,
    maximumErrors,
    backend: 'javascript',
    workerCount: 1,
    elapsedMs: performance.now() - startedAt,
  };
}

interface ShWorkerResult {
  readonly labels: Uint8Array;
  readonly squaredErrors: Float64Array;
  readonly maximumErrors: Float32Array;
}

function runShAssignmentWorker(
  worker: Worker,
  requestId: number,
  segment: BrowserSegment,
  packed: PackedShTrees,
): Promise<ShWorkerResult> {
  const shIndices = Uint32Array.from({ length: SH_DIMENSIONS }, (_, dimension) => {
    const index = segment.propertyIndex.get(`f_rest_${dimension}`);
    if (index === undefined) throw new Error(`${segment.path} 缺少 f_rest_${dimension}。`);
    return index;
  });
  return new Promise<ShWorkerResult>((resolve, reject) => {
    const cleanup = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    };
    const onMessage = (event: MessageEvent<{
      readonly type: 'started' | 'result' | 'error';
      readonly requestId: number;
      readonly labels?: ArrayBuffer;
      readonly squaredErrors?: ArrayBuffer;
      readonly maximumErrors?: ArrayBuffer;
      readonly message?: string;
    }>) => {
      if (event.data.requestId !== requestId || event.data.type === 'started') return;
      cleanup();
      if (event.data.type === 'error' || !event.data.labels || !event.data.squaredErrors || !event.data.maximumErrors) {
        reject(new Error(event.data.message ?? `SH WASM Worker ${requestId} 失败。`));
        return;
      }
      resolve({
        labels: new Uint8Array(event.data.labels),
        squaredErrors: new Float64Array(event.data.squaredErrors),
        maximumErrors: new Float32Array(event.data.maximumErrors),
      });
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      reject(new Error(event.message || `SH WASM Worker ${requestId} 崩溃。`));
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage({
      requestId,
      rows: segment.rows,
      count: segment.count,
      stride: segment.propertyNames.length,
      shIndices,
      ...packed,
    });
  });
}

function shWasmWorkerCount(segmentCount: number): number {
  const hardwareConcurrency = navigator.hardwareConcurrency || 4;
  if (hardwareConcurrency >= 24) return Math.min(segmentCount, 6);
  if (hardwareConcurrency >= 12) return Math.min(segmentCount, 4);
  return Math.min(segmentCount, 2);
}

async function assignShWasmWorkers(
  segments: readonly BrowserSegment[],
  levels: readonly ShProductLevel[],
  onProgress?: (ratio: number, message: string, detail?: Partial<FourCgsProgress>) => void,
): Promise<ShAssignmentResult> {
  const startedAt = performance.now();
  const workerCount = shWasmWorkerCount(segments.length);
  const packed = packShTrees(levels);
  const labels = new Array<Uint8Array>(segments.length);
  const squaredErrors = new Array<Float64Array>(segments.length);
  const maximumErrors = new Array<Float32Array>(segments.length);
  let nextSegment = 0;
  let completed = 0;
  const runLane = async (): Promise<void> => {
    const worker = new Worker(new URL('./fourcgs-sh-assign.worker.ts', import.meta.url), { type: 'module' });
    try {
      for (;;) {
        const segmentIndex = nextSegment++;
        if (segmentIndex >= segments.length) return;
        const result = await runShAssignmentWorker(worker, segmentIndex, segments[segmentIndex], packed);
        labels[segmentIndex] = result.labels;
        squaredErrors[segmentIndex] = result.squaredErrors;
        maximumErrors[segmentIndex] = result.maximumErrors;
        completed += 1;
        onProgress?.(0.36 + 0.015 * completed / segments.length,
          `SH WASM ${workerCount}W · ${completed}/${segments.length} 个片段完成`, {
            stage: 'SH WASM 并行标签', stageRatio: completed / segments.length, workerCount,
            completedTasks: completed, totalTasks: segments.length, elapsedMs: performance.now() - startedAt,
          });
      }
    } finally {
      worker.terminate();
    }
  };
  // #WDD-gpt 2026-08-16 - 每个片段共享原始 SAB，仅在各 Worker 的 WASM 线性内存中复制一次并行扫描，保持 JS f64 运算顺序与码流确定性。
  await Promise.all(Array.from({ length: workerCount }, () => runLane()));
  return {
    labels,
    squaredErrors,
    maximumErrors,
    backend: 'wasm-workers',
    workerCount,
    elapsedMs: performance.now() - startedAt,
  };
}

async function assignSh(
  segments: readonly BrowserSegment[],
  levels: readonly ShProductLevel[],
  halfToFloat: (bits: number) => number,
  onProgress?: (ratio: number, message: string, detail?: Partial<FourCgsProgress>) => void,
): Promise<ShAssignmentResult> {
  const wasmSupported = globalThis.crossOriginIsolated
    && typeof SharedArrayBuffer !== 'undefined'
    && typeof WebAssembly !== 'undefined'
    && typeof Worker !== 'undefined'
    && segments.every((segment) => segment.rows.buffer instanceof SharedArrayBuffer);
  if (wasmSupported) {
    try {
      onProgress?.(0.36, `正在以 ${shWasmWorkerCount(segments.length)} 个 WASM Worker 扫描全部 SH`, {
        stage: 'SH WASM 并行标签', stageRatio: 0, workerCount: shWasmWorkerCount(segments.length),
        completedTasks: 0, totalTasks: segments.length,
      });
      return await assignShWasmWorkers(segments, levels, onProgress);
    } catch (error) {
      onProgress?.(0.36, `SH WASM 不可用，安全回退 JavaScript：${error instanceof Error ? error.message : String(error)}`, {
        stage: 'SH JavaScript 回退', stageRatio: 0, workerCount: 1,
      });
    }
  }
  return assignShCpu(segments, levels, halfToFloat);
}

// #WDD-gpt 2026-08-16 - 通用 SH 编码从当前输入训练 5/10/15 字节产品码本，并以固定数值门限自动升档；超限向量仅保存稀疏 FP16 修正。
async function trainAdaptiveSh(
  segments: readonly BrowserSegment[],
  layout: MortonLayout,
  floatToHalf: (value: number) => number,
  halfToFloat: (bits: number) => number,
  onProgress?: (ratio: number, message: string, detail?: Partial<FourCgsProgress>) => void,
): Promise<TrainedSh> {
  const samples = sampleReferences(segments);
  let selected: ReturnType<typeof trainShTemplate> | undefined;
  let selectedTemplate = SH_TEMPLATES[SH_TEMPLATES.length - 1];
  let selectedRate = Number.POSITIVE_INFINITY;
  const attempts: TrainedSh['metrics']['attempts'][number][] = [];
  for (let index = 0; index < SH_TEMPLATES.length; index += 1) {
    const template = SH_TEMPLATES[index];
    onProgress?.(0.29 + index * 0.025, `正在训练通用 SH ${template.name} 档`);
    const trained = trainShTemplate(segments, template, samples, floatToHalf, halfToFloat);
    attempts.push({
      template: template.name,
      sampleRmse: trained.sampleRmse,
      estimatedExceptionRatio: trained.estimatedExceptionRatio,
      estimatedBytesPerInstance: trained.estimatedBytesPerInstance,
    });
    if (trained.estimatedBytesPerInstance < selectedRate) {
      selected = trained;
      selectedTemplate = template;
      selectedRate = trained.estimatedBytesPerInstance;
    }
  }
  if (!selected) throw new Error('SH 自适应训练未产生结果。');
  const assignment = await assignSh(segments, selected.levels, halfToFloat, onProgress);
  const labels = assignment.labels;
  const localSquaredErrors = assignment.squaredErrors;
  const localMaximumErrors = assignment.maximumErrors;

  const instanceCount = layout.activeSlots.reduce((sum, active) => sum + active.length, 0);
  const vectorSquaredErrors = new Float32Array(instanceCount);
  const vectorMaximumErrors = new Float32Array(instanceCount);
  let instance = 0;
  let totalSquaredError = 0;
  let maximumAbsoluteError = 0;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const inverse = layout.slotToLocal[segmentIndex];
    for (const slot of layout.activeSlots[segmentIndex]) {
      const local = inverse[slot];
      // #WDD-gpt 2026-08-16 - 标签阶段已取得同一 45D 向量和中心，复用误差结果避免对全部 SH 再扫描一次。
      const vectorSquaredError = localSquaredErrors[segmentIndex][local];
      const vectorMaximumError = localMaximumErrors[segmentIndex][local];
      vectorSquaredErrors[instance] = vectorSquaredError;
      vectorMaximumErrors[instance] = vectorMaximumError;
      totalSquaredError += vectorSquaredError;
      maximumAbsoluteError = Math.max(maximumAbsoluteError, vectorMaximumError);
      instance += 1;
    }
  }

  const exceptionMask = new Uint8Array(Math.ceil(instanceCount / 8));
  let retainedSquaredError = totalSquaredError;
  let exceptionCount = 0;
  let maximumVectorSquaredError = 0;
  const markException = (index: number): void => {
    if (exceptionMask[index >>> 3] & (1 << (index & 7))) return;
    exceptionMask[index >>> 3] |= 1 << (index & 7);
    retainedSquaredError -= vectorSquaredErrors[index];
    exceptionCount += 1;
  };
  for (let index = 0; index < instanceCount; index += 1) {
    maximumVectorSquaredError = Math.max(maximumVectorSquaredError, vectorSquaredErrors[index]);
    if (vectorMaximumErrors[index] > SH_MAXIMUM_COEFFICIENT_ERROR) markException(index);
  }
  const targetSquaredError = SH_TARGET_RMSE * SH_TARGET_RMSE * instanceCount * SH_DIMENSIONS;
  if (retainedSquaredError > targetSquaredError && maximumVectorSquaredError > 0) {
    const histogram = new Uint32Array(4096);
    const histogramError = new Float64Array(4096);
    for (let index = 0; index < instanceCount; index += 1) {
      if (exceptionMask[index >>> 3] & (1 << (index & 7))) continue;
      const bin = Math.min(4095, Math.floor(vectorSquaredErrors[index] / maximumVectorSquaredError * 4095));
      histogram[bin] += 1;
      histogramError[bin] += vectorSquaredErrors[index];
    }
    let boundary = 4095;
    for (; boundary >= 0 && retainedSquaredError > targetSquaredError; boundary -= 1) {
      if (retainedSquaredError - histogramError[boundary] < targetSquaredError) break;
      retainedSquaredError -= histogramError[boundary];
      exceptionCount += histogram[boundary];
      for (let index = 0; index < instanceCount; index += 1) {
        if (exceptionMask[index >>> 3] & (1 << (index & 7))) continue;
        const bin = Math.min(4095, Math.floor(vectorSquaredErrors[index] / maximumVectorSquaredError * 4095));
        if (bin === boundary) exceptionMask[index >>> 3] |= 1 << (index & 7);
      }
    }
    if (retainedSquaredError > targetSquaredError && boundary >= 0) {
      for (let index = 0; index < instanceCount && retainedSquaredError > targetSquaredError; index += 1) {
        if (exceptionMask[index >>> 3] & (1 << (index & 7))) continue;
        const bin = Math.min(4095, Math.floor(vectorSquaredErrors[index] / maximumVectorSquaredError * 4095));
        if (bin === boundary) markException(index);
      }
    }
  }

  const exceptionValues = new Uint8Array(exceptionCount * SH_DIMENSIONS * 2);
  const exceptionView = new DataView(exceptionValues.buffer);
  instance = 0;
  let exception = 0;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const inverse = layout.slotToLocal[segmentIndex];
    for (const slot of layout.activeSlots[segmentIndex]) {
      const local = inverse[slot];
      if (exceptionMask[instance >>> 3] & (1 << (instance & 7))) {
        const base = local * segment.propertyNames.length;
        for (let dimension = 0; dimension < SH_DIMENSIONS; dimension += 1) {
          exceptionView.setUint16(
            (exception * SH_DIMENSIONS + dimension) * 2,
            segment.rows[base + segment.propertyIndex.get(`f_rest_${dimension}`)!],
            true,
          );
        }
        exception += 1;
      }
      instance += 1;
    }
  }
  if (exception !== exceptionCount) throw new Error('SH 稀疏修正计数不一致。');

  const base = Buffer.alloc(SH_DIMENSIONS * 2 + selectedTemplate.levels * SH_CODEBOOK_SIZE * SH_DIMENSIONS * 2);
  let baseOffset = SH_DIMENSIONS * 2;
  for (const level of selected.levels) {
    for (let index = 0; index < level.centers.length; index += 1) {
      base.writeUInt16LE(floatToHalf(level.centers[index]), baseOffset);
      baseOffset += 2;
    }
  }
  return {
    template: selectedTemplate,
    base,
    labels,
    exceptionMask,
    exceptionValues,
    metrics: {
      rmse: Math.sqrt(Math.max(0, retainedSquaredError) / (instanceCount * SH_DIMENSIONS)),
      maximumAbsoluteError: exceptionCount > 0 ? SH_MAXIMUM_COEFFICIENT_ERROR : maximumAbsoluteError,
      exceptionCount,
      exceptionRatio: exceptionCount / instanceCount,
      sampleRmse: selected.sampleRmse,
      assignmentBackend: assignment.backend,
      assignmentWorkerCount: assignment.workerCount,
      assignmentElapsedMs: assignment.elapsedMs,
      attempts,
    },
  };
}

function activeMask(layout: MortonLayout, segmentCount: number): Buffer {
  const bytes = Buffer.alloc(Math.ceil(layout.slotCount * segmentCount / 8));
  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
    for (const slot of layout.activeSlots[segmentIndex]) {
      const bit = segmentIndex * layout.slotCount + slot;
      bytes[bit >>> 3] |= 1 << (bit & 7);
    }
  }
  return bytes;
}

function temporalComponent(
  segments: readonly BrowserSegment[],
  layout: MortonLayout,
  namesBySegment: readonly (readonly string[])[],
): Buffer {
  const valueCount = namesBySegment.reduce((sum, names, index) => sum + names.length * layout.activeSlots[index].length, 0);
  const values = new Uint16Array(valueCount);
  const state = new Uint16Array(layout.slotCount);
  const initialized = new Uint8Array(layout.slotCount);
  let destination = 0;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const inverse = layout.slotToLocal[segmentIndex];
    for (const name of namesBySegment[segmentIndex]) {
      const property = segment.propertyIndex.get(name);
      if (property === undefined) throw new Error(`${segment.path} 缺少 ${name}。`);
      for (const slot of layout.activeSlots[segmentIndex]) {
        const local = inverse[slot];
        const value = segment.rows[local * segment.propertyNames.length + property];
        values[destination++] = initialized[slot] ? value ^ state[slot] : value;
        state[slot] = value;
        initialized[slot] = 1;
      }
    }
  }
  if (destination !== values.length) throw new Error('V2.6 时间属性长度不一致。');
  return Buffer.from(values.buffer);
}

function opacityVectors(segments: readonly BrowserSegment[], layout: MortonLayout): Uint16Array {
  const bankCounts = segments.map((segment) => bankCount(segment, 'opacity_bank'));
  if (!bankCounts.every((count) => count === bankCounts[0])) throw new Error('V2.6 Opacity bank 数量必须一致。');
  const observations = layout.activeSlots.reduce((sum, active) => sum + active.length, 0);
  const values = new Uint16Array(observations * bankCounts[0]);
  let observation = 0;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const inverse = layout.slotToLocal[segmentIndex];
    const properties = Array.from({ length: bankCounts[segmentIndex] }, (_, bank) => segment.propertyIndex.get(`opacity_bank_${bank}`)!);
    for (const slot of layout.activeSlots[segmentIndex]) {
      const source = inverse[slot] * segment.propertyNames.length;
      for (let bank = 0; bank < properties.length; bank += 1) values[observation * properties.length + bank] = segment.rows[source + properties[bank]];
      observation += 1;
    }
  }
  return values;
}

function sharedShStream(trained: TrainedSh, layout: MortonLayout): Buffer {
  const { labels } = trained;
  const levels = trained.template.levels;
  const instanceCount = layout.activeSlots.reduce((sum, active) => sum + active.length, 0);
  const mask = new Uint8Array(Math.ceil(instanceCount / 8));
  const updates = new Uint8Array(instanceCount * levels);
  const state = new Uint8Array(layout.slotCount * levels);
  const initialized = new Uint8Array(layout.slotCount);
  let instance = 0;
  let updateCount = 0;
  for (let segmentIndex = 0; segmentIndex < labels.length; segmentIndex += 1) {
    const inverse = layout.slotToLocal[segmentIndex];
    for (const slot of layout.activeSlots[segmentIndex]) {
      const local = inverse[slot];
      const current = labels[segmentIndex].subarray(local * levels, local * levels + levels);
      const stateOffset = slot * levels;
      let changed = !initialized[slot];
      for (let level = 0; level < levels && !changed; level += 1) changed = state[stateOffset + level] !== current[level];
      if (changed) {
        mask[instance >>> 3] |= 1 << (instance & 7);
        updates.set(current, updateCount * levels);
        state.set(current, stateOffset);
        initialized[slot] = 1;
        updateCount += 1;
      }
      instance += 1;
    }
  }
  const storedMask = zlibSync(mask, { level: 9 });
  const storedUpdates = zlibSync(updates.subarray(0, updateCount * levels), { level: 9 });
  const storedExceptions = zlibSync(trained.exceptionMask, { level: 9 });
  const storedExceptionValues = zlibSync(trained.exceptionValues, { level: 9 });
  const header = Buffer.alloc(40);
  header.write('C5T2SH01', 0, 'ascii');
  header.writeUInt32LE(layout.slotCount, 8);
  header.writeUInt32LE(instanceCount, 12);
  header.writeUInt16LE(labels.length, 16);
  header.writeUInt8(SH_DIMENSIONS, 18);
  header.writeUInt8(levels, 19);
  header.writeUInt32LE(trained.base.length, 20);
  header.writeUInt32LE(storedMask.length, 24);
  header.writeUInt32LE(storedUpdates.length, 28);
  header.writeUInt32LE(storedExceptions.length, 32);
  header.writeUInt32LE(storedExceptionValues.length, 36);
  return Buffer.concat([header, trained.base, storedMask, storedUpdates, storedExceptions, storedExceptionValues]);
}

async function storedStream(
  name: string,
  raw: Uint8Array,
  compression: FourCgsStreamEntry['compression'] = 'raw',
): Promise<StoredStream> {
  let stored = raw;
  if (compression === 'brotli' || compression === 'brotli-shuffle16') {
    const imported = await import('brotli-wasm');
    const brotli = await imported.default;
    const source = compression === 'brotli-shuffle16' ? shuffle16WithPadding(raw) : raw;
    stored = brotli.compress(source, { quality: 9 });
  }
  const bytes = new Uint8Array(stored.byteLength);
  bytes.set(stored);
  return {
    entry: {
      name,
      compression,
      rawBytes: raw.byteLength,
      storedBytes: bytes.byteLength,
      rawSha256: hash(raw),
      storedSha256: hash(bytes),
    },
    bytes,
  };
}

function container(manifest: FourCgsManifest, streams: readonly StoredStream[]): Blob {
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const header = new Uint8Array(FOUR_CGS_HEADER_BYTES);
  header.set(new TextEncoder().encode(FOUR_CGS_MAGIC));
  new DataView(header.buffer).setUint32(8, manifestBytes.byteLength, true);
  return new Blob([
    header.buffer as ArrayBuffer,
    manifestBytes.buffer as ArrayBuffer,
    ...streams.map((stream) => stream.bytes.slice().buffer as ArrayBuffer),
  ], { type: 'application/x-4cgs' });
}

function sharedInt32(values: Int32Array): Int32Array {
  if (values.buffer instanceof SharedArrayBuffer) return values;
  const shared = new Int32Array(new SharedArrayBuffer(values.byteLength));
  shared.set(values);
  return shared;
}

function shareEncoderLayout(layout: MortonLayout): MortonLayout {
  // #WDD-gpt 2026-08-16 - 属性编码只读取 slotCount/activeSlots/slotToLocal；禁止把近百万项 Morton order 与匹配诊断重复克隆给每个 Worker。
  return {
    slotCount: layout.slotCount,
    trackCount: layout.trackCount,
    sourcePermanentTrackCount: layout.sourcePermanentTrackCount,
    droppedTrackCount: layout.droppedTrackCount,
    maps: [],
    slotToLocal: layout.slotToLocal.map(sharedInt32),
    continuedLocal: [],
    activeSlots: layout.activeSlots.map(sharedInt32),
    matches: [],
  };
}

function runEncodeAttributeWorker(
  task: ParallelAttributeResult['task'],
  segments: readonly BrowserSegment[],
  layout: MortonLayout,
  descriptors: readonly FourCgsSegment[],
  crop: { readonly center: readonly [number, number, number]; readonly halfExtent: number },
  onStarted: () => void,
): Promise<ParallelAttributeResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./fourcgs-encode-attribute.worker.ts', import.meta.url), { type: 'module' });
    const finish = () => worker.terminate();
    worker.addEventListener('message', (event: MessageEvent<{
      readonly type: 'started' | 'result' | 'error';
      readonly task: ParallelAttributeResult['task'];
      readonly encoded?: ArrayBuffer;
      readonly metrics?: Record<string, any>;
      readonly elapsedMs?: number;
      readonly message?: string;
    }>) => {
      if (event.data.type === 'started') {
        onStarted();
        return;
      }
      finish();
      if (event.data.type === 'error' || !event.data.encoded) {
        reject(new Error(event.data.message ?? `4CGS ${task} 编码 Worker 失败。`));
        return;
      }
      resolve({
        task,
        encoded: new Uint8Array(event.data.encoded),
        metrics: event.data.metrics ?? {},
        elapsedMs: event.data.elapsedMs ?? 0,
      });
    });
    worker.addEventListener('error', (event) => {
      finish();
      reject(new Error(event.message || `4CGS ${task} 编码 Worker 崩溃。`));
    }, { once: true });
    worker.postMessage({
      task,
      segments,
      layout,
      descriptors,
      options: task === 'position'
        ? { center: crop.center, halfExtent: crop.halfExtent, step: POSITION_STEP, maximumError: POSITION_MAXIMUM_ERROR, cellSize: 0.5 }
        : task === 'rotation'
          ? { bits: 12, stepDegrees: ROTATION_STEP_DEGREES, maximumAngleDegrees: ROTATION_MAXIMUM_DEGREES }
          : { step: task.startsWith('scale') ? SCALE_STEP : DC_STEP },
    });
  });
}

function encodeAttributesInWorkerPool(
  segments: readonly BrowserSegment[],
  layout: MortonLayout,
  descriptors: readonly FourCgsSegment[],
  crop: { readonly center: readonly [number, number, number]; readonly halfExtent: number },
  onProgress?: (ratio: number, message: string, detail?: Partial<FourCgsProgress>) => void,
): {
  readonly ready: Promise<void>;
  readonly done: Promise<{ readonly results: ReadonlyMap<ParallelAttributeResult['task'], ParallelAttributeResult>; readonly workerCount: number }>;
} {
  const tasks: ParallelAttributeResult['task'][] = ['position', 'rotation', 'scale0', 'scale1', 'scale2', 'dc'];
  const hardwareConcurrency = navigator.hardwareConcurrency || 4;
  const workerCount = Math.min(tasks.length, Math.max(2, Math.floor((hardwareConcurrency - 2) / 2)));
  const positionEnvelopeWorkers = hardwareConcurrency >= 12 ? 4 : hardwareConcurrency >= 8 ? 3 : 2;
  const peakWorkerCount = workerCount + 1 + positionEnvelopeWorkers;
  const sharedLayout = shareEncoderLayout(layout);
  let nextTask = 0;
  let completed = 0;
  let started = 0;
  let resolveReady!: () => void;
  let rejectReady!: (reason?: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const initialWorkerCount = Math.min(workerCount, tasks.length);
  const results = new Map<ParallelAttributeResult['task'], ParallelAttributeResult>();
  const startedAt = performance.now();
  const runLane = async () => {
    while (nextTask < tasks.length) {
      const task = tasks[nextTask++];
      const result = await runEncodeAttributeWorker(task, segments, sharedLayout, descriptors, crop, () => {
        started += 1;
        if (started === initialWorkerCount) resolveReady();
      });
      results.set(task, result);
      completed += 1;
      const timingLabel = task === 'position'
        ? `POSITION ${(result.elapsedMs / 1000).toFixed(2)} 秒 · 核心 ${(Number(result.metrics.codecMs ?? 0) / 1000).toFixed(2)} 秒 · Brotli ${(Number(result.metrics.envelopeMs ?? 0) / 1000).toFixed(2)} 秒/${Number(result.metrics.envelopeWorkerCount ?? positionEnvelopeWorkers)}W`
        : `${task.toUpperCase()} ${(result.elapsedMs / 1000).toFixed(2)} 秒`;
      onProgress?.(
        0.40 + 0.32 * completed / tasks.length,
        `${workerCount} 个属性 Worker · ${completed}/${tasks.length} 项完成 · ${timingLabel}`,
        {
          stage: '属性并行编码', stageRatio: completed / tasks.length,
          workerCount: peakWorkerCount, completedTasks: completed, totalTasks: tasks.length,
          elapsedMs: performance.now() - startedAt,
        },
      );
    }
  };
  onProgress?.(0.40, `正在启动 ${workerCount} 个属性编码 Worker`, {
    stage: '属性并行编码', stageRatio: 0, workerCount: peakWorkerCount,
    completedTasks: 0, totalTasks: tasks.length,
  });
  const done = Promise.all(Array.from({ length: workerCount }, () => runLane()))
    .then(() => ({ results, workerCount: peakWorkerCount }))
    .catch((error: unknown) => {
      rejectReady(error);
      throw error;
    });
  void done.catch(() => undefined);
  return { ready, done };
}

// #WDD-gpt 2026-08-16 - V2.6 浏览器导出完全从当前 RAW4D 自训练，不再依赖文件名、哈希或某组数据的预置码本。
export async function encodeRaw4DV26Browser(
  files: readonly File[],
  deletionWords: readonly Uint32Array[],
  onProgress?: (ratio: number, message: string, detail?: Partial<FourCgsProgress>) => void,
): Promise<FourCgsEncodeResult> {
  if (files.length === 0) throw new Error('没有可编码的 RAW4D 文件。');
  if (deletionWords.length !== files.length) throw new Error(`RAW4D 删除位集数量不一致：${deletionWords.length}/${files.length}。`);
  onProgress?.(0.01, '正在读取当前 RAW4D 头');
  const headers = await Promise.all(files.map(async (file, fileIndex): Promise<SourceHeader> => {
      if (!/\.(?:raw4d|ply4)$/i.test(file.name)) throw new FourCgsHighCompressionUnsupportedError(`${file.name} 不是 RAW4D/PLY4 文件。`);
      const header = await readRaw4DHeader(file);
      if (header.scalarEncoding !== 'float16') throw new FourCgsHighCompressionUnsupportedError(`${file.name} 不是 FP16 RAW4D；当前高压缩编码器不会隐式改变源精度。`);
      // #WDD-gpt 2026-08-19 - split RAW4D 必须先经统一 Canonical 内存适配，禁止旧单行宽 File 快径误读 vertex_static。
      if (header.elements.length > 1) {
        throw new FourCgsHighCompressionUnsupportedError(`${file.name} 包含动态/静态分区；请使用已载入场景的 Canonical 内存导出 4CGS。`);
      }
      if (file.size !== header.dataOffset + header.payloadBytes) {
        throw new FourCgsHighCompressionUnsupportedError(`${file.name} 的 RAW4D 载荷长度与头不一致。`);
      }
      return { fileIndex, file, header, range: sourceFrameRange(file.name, header.totalFrames) };
    }));
  const ordered = orderedHeaders(headers);
  const prepared: PreparedV26Source[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const source = ordered[index];
    onProgress?.(0.03 + index * 0.18 / ordered.length, `正在读取并去掉删除点 ${index + 1}/${ordered.length}：${source.file.name}`);
    const compacted = await compactSegment(source, deletionWords[source.fileIndex]);
    prepared.push({
      name: source.file.name,
      sourceEncoding: source.header.scalarEncoding,
      sourceShBands: 3,
      descriptor: segmentDescriptor(source, compacted.segment.count),
      originalPointCount: source.header.vertexCount,
      compacted,
    });
  }
  return encodePreparedRaw4DV26(prepared, onProgress);
}

// #WDD-gpt 2026-08-16 - 内存保存绕过 File 解析，直接从当前 SoA 位模式建立压缩工作集。
export async function encodeRaw4DV26BrowserMemory(
  sources: readonly Raw4DMemorySnapshot[],
  onProgress?: (ratio: number, message: string, detail?: Partial<FourCgsProgress>) => void,
): Promise<FourCgsEncodeResult> {
  if (sources.length === 0) throw new Error('没有可编码的 RAW4D 内存快照。');
  const ordered = orderedMemorySources(sources);
  const prepared: PreparedV26Source[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const precision = ordered[index].asset.sourceEncoding === 'float32' ? '（Float32 → FP16 编码工作副本）' : '';
    onProgress?.(0.03 + index * 0.18 / ordered.length, `正在从 Canonical RAM 压实 ${index + 1}/${ordered.length}：${ordered[index].name}${precision}`);
    prepared.push(await compactMemorySegment(ordered[index]));
  }
  return encodePreparedRaw4DV26(prepared, onProgress);
}

async function encodePreparedRaw4DV26(
  prepared: readonly PreparedV26Source[],
  onProgress?: (ratio: number, message: string, detail?: Partial<FourCgsProgress>) => void,
): Promise<FourCgsEncodeResult> {
  const totalStartedAt = performance.now();
  const stageMs: Record<string, number> = {};
  (globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;
  const compacted = prepared.map((source) => source.compacted);
  const segments = compacted.map((value) => value.segment);
  const descriptors = prepared.map((source) => source.descriptor);
  const permanent = buildExactBoundaryPermanentTrackMaps(segments);
  const prsCodec = await import('../../../../../scripts/fourcgs-prs-codec.mjs');
  const crop = computeInputCrop(segments, prsCodec.halfToFloat);
  const layout = prsCodec.buildCroppedMortonLayout(
    segments,
    permanent,
    crop.center,
    crop.halfExtent,
    // #WDD-gpt 2026-08-16 - crop 刚由全部 Position 关键帧的有限 min/max 生成并增加余量，无需在 Morton 阶段重复扫描验证。
    { positionsAlreadyInside: true },
  ) as MortonLayout;
  if (layout.droppedTrackCount !== 0) throw new Error(`输入自适应包围盒意外丢弃 ${layout.droppedTrackCount} 条轨迹。`);
  stageMs.layout = performance.now() - totalStartedAt;
  const parallelSupported = globalThis.crossOriginIsolated
    && typeof SharedArrayBuffer !== 'undefined'
    && segments.every((segment) => segment.rows.buffer instanceof SharedArrayBuffer)
    && (navigator.hardwareConcurrency || 4) >= 6;
  const parallelAttributeWorkerCount = parallelSupported
    ? Math.min(6, Math.max(2, Math.floor(((navigator.hardwareConcurrency || 4) - 2) / 2)))
    : 0;
  const parallelPositionEnvelopeWorkerCount = parallelSupported
    ? (navigator.hardwareConcurrency || 4) >= 12 ? 4 : (navigator.hardwareConcurrency || 4) >= 8 ? 3 : 2
    : 0;
  const attributePool = parallelSupported
    ? encodeAttributesInWorkerPool(segments, layout, descriptors, crop, onProgress)
    : null;
  if (attributePool) {
    // #WDD-gpt 2026-08-16 - 先让嵌套 Worker 完成模块/WASM 启动并真正进入编码，再同步训练 SH，防止启动消息被 17 秒计算段饿死。
    await attributePool.ready;
    onProgress?.(0.27, '属性 Worker 已全部启动；现在与 SH 训练并行', {
      stage: 'Worker 启动屏障', stageRatio: 1,
      workerCount: parallelAttributeWorkerCount + 1 + parallelPositionEnvelopeWorkerCount,
      completedTasks: 0, totalTasks: 6,
    });
  }
  const shStartedAt = performance.now();
  onProgress?.(0.28, parallelSupported
    ? '正在训练自适应 SH；Position / Rotation / Scale / DC 已在子 Worker 并行编码'
    : '正在训练自适应 SH', {
    stage: 'SH 质量训练', stageRatio: 0,
    workerCount: parallelSupported ? parallelAttributeWorkerCount + 1 + parallelPositionEnvelopeWorkerCount : 1,
    completedTasks: 0, totalTasks: parallelSupported ? 6 : 1,
  });
  const trainedSh = await trainAdaptiveSh(segments, layout, prsCodec.floatToHalf, prsCodec.halfToFloat, onProgress);
  stageMs.shTraining = performance.now() - shStartedAt;

  // #WDD-gpt 2026-08-16 - SH 完成后立刻在控制 Worker 生成辅助流，让 Opacity/Lifetime/SH 的 3~4 秒隐藏在 Position 子 Worker 等待期内。
  const auxiliaryPromise = (async () => {
    const auxiliaryStartedAt = performance.now();
    onProgress?.(0.38, '正在并行封装 Opacity、生命周期与共享 SH', {
      stage: '辅助流并行封装', stageRatio: 0,
      workerCount: parallelSupported ? parallelAttributeWorkerCount + 1 + parallelPositionEnvelopeWorkerCount : 1,
      completedTasks: 0, totalTasks: 4,
    });
    const opacityCodec = await import('../../../../../scripts/fourcgs-opacity-hybrid-codec.mjs');
    const opacityBits = opacityVectors(segments, layout);
    const observationCount = opacityBits.length / descriptors[0].bankCounts.opacity;
    const opacity = opacityCodec.encodeOpacityHybrid(opacityBits, observationCount, {
      baseExact: true,
      residualCompression: 'zlib',
    });
    const lifetimeMu = temporalComponent(segments, layout, segments.map(() => ['lifetime_mu']));
    const lifetimeW = temporalComponent(segments, layout, segments.map(() => ['lifetime_w']));
    const sh = sharedShStream(trainedSh, layout);
    const streams = await Promise.all([
      storedStream('active_masks', activeMask(layout, segments.length), 'brotli'),
      storedStream('mixsc_opacity', opacity.encoded),
      storedStream('lifetime_mu', lifetimeMu, 'brotli-shuffle16'),
      storedStream('lifetime_w', lifetimeW, 'brotli-shuffle16'),
      storedStream('coresh5r_shared', sh),
    ]);
    return { streams, elapsedMs: performance.now() - auxiliaryStartedAt };
  })();

  let position: { metrics: Record<string, any> };
  let rotation: { metrics: Record<string, any> };
  let scale: { metrics: Record<string, any> };
  let dc: { metrics: Record<string, any> };
  let positionStored: { encoded: Uint8Array };
  let rotationStored: { encoded: Uint8Array };
  let scaleStoredStreams: Array<{ readonly name: string; readonly encoded: Uint8Array }>;
  let dcStored: { encoded: Uint8Array };
  let encoderWorkerCount = 1;
  if (attributePool) {
    const parallelStartedAt = performance.now();
    const parallel = await attributePool.done;
    stageMs.attributeWait = performance.now() - parallelStartedAt;
    // #WDD-gpt 2026-08-16 - 最终监督值记录 SH WASM 阶段与 Position Brotli 阶段二者中的真实峰值，而非仅报告属性池。
    encoderWorkerCount = Math.max(
      parallel.workerCount,
      parallelAttributeWorkerCount + 1 + trainedSh.metrics.assignmentWorkerCount,
    );
    const requireResult = (task: ParallelAttributeResult['task']) => {
      const result = parallel.results.get(task);
      if (!result) throw new Error(`4CGS 并行编码缺少 ${task} 结果。`);
      stageMs[task] = result.elapsedMs;
      return result;
    };
    const positionResult = requireResult('position');
    const rotationResult = requireResult('rotation');
    const scaleResults = [requireResult('scale0'), requireResult('scale1'), requireResult('scale2')];
    const dcResult = requireResult('dc');
    position = { metrics: positionResult.metrics };
    stageMs.positionCore = Number(positionResult.metrics.codecMs ?? 0);
    stageMs.positionEnvelope = Number(positionResult.metrics.envelopeMs ?? 0);
    rotation = { metrics: rotationResult.metrics };
    scale = { metrics: {
      ...scaleResults[0].metrics,
      measuredRmse: Math.sqrt(scaleResults.reduce(
        (sum, result) => sum + Number(result.metrics.measuredRmse ?? 0) ** 2, 0,
      ) / scaleResults.length),
      measuredMaximumError: Math.max(...scaleResults.map((result) => Number(result.metrics.measuredMaximumError ?? 0))),
      streams: scaleResults.flatMap((result) => result.metrics.streams ?? []),
      partitions: 3,
    } };
    dc = { metrics: dcResult.metrics };
    positionStored = { encoded: positionResult.encoded };
    rotationStored = { encoded: rotationResult.encoded };
    scaleStoredStreams = scaleResults.map((result, component) => ({
      name: `tattr_scale_${component}`,
      encoded: result.encoded,
    }));
    dcStored = { encoded: dcResult.encoded };
  } else {
    const structuredCodec = await import('../../../../../scripts/fourcgs-v21-lossless-codec.mjs');
    onProgress?.(0.40, '正在编码 Position（兼容单 Worker）', { stage: 'Position', stageRatio: 0, workerCount: 1 });
    let startedAt = performance.now();
    const encodedPosition = prsCodec.encodePositions(
      segments, layout, descriptors.map((segment) => segment.bankCounts.position),
      { center: crop.center, halfExtent: crop.halfExtent, step: POSITION_STEP, maximumError: POSITION_MAXIMUM_ERROR, cellSize: 0.5 },
    );
    positionStored = await structuredCodec.encodeV21StructuredStream(
      'prs_position', encodedPosition.encoded, { segments: descriptors }, { blockCompression: 'brotli', brotliQuality: 9 },
    );
    position = encodedPosition;
    stageMs.position = performance.now() - startedAt;
    onProgress?.(0.55, '正在编码 Rotation（兼容单 Worker）', { stage: 'Rotation', stageRatio: 0, workerCount: 1 });
    startedAt = performance.now();
    const rotationCodec = await import('../../../../../scripts/fourcgs-so3-temporal-codec.mjs');
    const encodedRotation = rotationCodec.encodeSo3Rotations(
      segments, layout, descriptors.map((segment) => segment.bankCounts.rotation),
      { bits: 12, stepDegrees: ROTATION_STEP_DEGREES, maximumAngleDegrees: ROTATION_MAXIMUM_DEGREES },
    );
    rotationStored = await structuredCodec.encodeV22StructuredStream(
      'so3_rotation', encodedRotation.encoded, { blockCompression: 'brotli', brotliQuality: 9 },
    );
    rotation = encodedRotation;
    stageMs.rotation = performance.now() - startedAt;
    const attributeCodec = await import('../../../../../scripts/fourcgs-temporal-attribute-codec.mjs');
    onProgress?.(0.65, '正在编码 Scale（兼容单 Worker）', { stage: 'Scale', stageRatio: 0, workerCount: 1 });
    startedAt = performance.now();
    const encodedScale = attributeCodec.encodeTemporalAttribute(segments, layout, {
      prefix: 'scale_bank', components: ['0', '1', '2'],
      bankCounts: descriptors.map((segment) => segment.bankCounts.scale), exactHalf: false, step: SCALE_STEP,
    });
    const scaleStored = await structuredCodec.encodeV22StructuredStream(
      'tattr_scale', encodedScale.encoded, { blockCompression: 'brotli', brotliQuality: 9 },
    );
    scaleStoredStreams = [{ name: 'tattr_scale', encoded: scaleStored.encoded }];
    scale = encodedScale;
    stageMs.scale = performance.now() - startedAt;
    onProgress?.(0.74, '正在编码 DC（兼容单 Worker）', { stage: 'DC', stageRatio: 0, workerCount: 1 });
    startedAt = performance.now();
    const encodedDc = attributeCodec.encodeTemporalAttribute(segments, layout, {
      prefix: 'f_dc_bank', components: ['0', '1', '2'],
      bankCounts: descriptors.map((segment) => segment.bankCounts.colorDc), exactHalf: false, step: DC_STEP,
    });
    dcStored = await structuredCodec.encodeV22StructuredStream(
      'tattr_dc', encodedDc.encoded, { blockCompression: 'brotli', brotliQuality: 9 },
    );
    dc = encodedDc;
    stageMs.dc = performance.now() - startedAt;
  }

  const auxiliary = await auxiliaryPromise;
  const [activeMaskStream, opacityStream, lifetimeMuStream, lifetimeWStream, sharedShStoredStream] = auxiliary.streams;
  const attributeStreams = await Promise.all([
    storedStream('prs_position', positionStored.encoded),
    storedStream('so3_rotation', rotationStored.encoded),
    ...scaleStoredStreams.map((stream) => storedStream(stream.name, stream.encoded)),
    storedStream('tattr_dc', dcStored.encoded),
  ]);
  const streams = [
    activeMaskStream,
    ...attributeStreams,
    opacityStream,
    lifetimeMuStream,
    lifetimeWStream,
    sharedShStoredStream,
  ];
  stageMs.auxiliaryStreams = auxiliary.elapsedMs;
  const originalPointCount = prepared.reduce((sum, source) => sum + source.originalPointCount, 0);
  const deletedPointCount = compacted.reduce((sum, value) => sum + value.deleted, 0);
  const encodedPointCount = originalPointCount - deletedPointCount;
  const sourceBytes = compacted.reduce((sum, value) => sum + value.compactedBytes, 0);
  const firstFrame = descriptors[0].firstFrame;
  const lastFrame = descriptors.at(-1)!.lastFrame;
  const manifest: FourCgsManifest = {
    format: '4CGS',
    version: 2,
    codecName: parallelSupported
      ? 'CoRe4D-V2.6-AdaptivePQ-Brotli9-BoundedTemporal-Scale3Way'
      : 'CoRe4D-V2.6-AdaptivePQ-Brotli9-BoundedTemporal',
    sourceBytes,
    slotCount: layout.slotCount,
    firstFrame,
    lastFrame,
    uniqueFrameCount: lastFrame - firstFrame + 1,
    crop,
    prs: {
      position: {
        center: crop.center, halfExtent: crop.halfExtent, cellSize: 0.5,
        step: POSITION_STEP, maximumEuclideanError: POSITION_MAXIMUM_ERROR,
        measuredRmse: position.metrics.measuredRmse,
        measuredMaximumEuclideanError: position.metrics.measuredMaximumEuclideanError,
      },
      rotation: {
        bits: 12, mode: 'smallest-three-birth-so3-temporal-residual-rans',
        stepDegrees: ROTATION_STEP_DEGREES, maximumAngleDegrees: ROTATION_MAXIMUM_DEGREES,
        measuredAngularRmseDegrees: rotation.metrics.measuredAngularRmseDegrees,
        measuredMaximumAngleDegrees: rotation.metrics.measuredMaximumAngleDegrees,
      },
      scale: {
        mode: parallelSupported
          ? 'v26-bounded-temporal-linear-residual-rans-3way'
          : 'v26-bounded-temporal-linear-residual-rans', step: SCALE_STEP,
        maximumLogError: scale.metrics.measuredMaximumError,
      },
    },
    temporalAttributes: { scale: scale.metrics, colorDc: dc.metrics },
    losslessEntropy: { temporalModes: { lifetime_mu: 'xor', lifetime_w: 'xor' } },
    compressionV26: {
      version: '2.6-browser-export',
      pruning: false,
      deletionCompaction: true,
      originalPointCount,
      encodedPointCount,
      deletedPointCount,
      generalizationPolicy: 'input-trained adaptive templates; fixed numeric gates; no filename/hash/source-profile dependency',
      positionPolicy: { step: POSITION_STEP, maximumAllowedEuclideanErrorMeters: POSITION_MAXIMUM_ERROR },
      rotationPolicy: { stepDegrees: ROTATION_STEP_DEGREES, maximumAllowedAngleDegrees: ROTATION_MAXIMUM_DEGREES },
      scalePolicy: { step: SCALE_STEP, maximumLogError: SCALE_STEP / 2 },
      dcPolicy: { step: DC_STEP, maximumCoefficientError: DC_STEP / 2 },
      opacityPolicy: 'all declared banks bit-exact FP16; multi-segment inputs require a consistent bank layout',
      shPolicy: {
        template: trainedSh.template.name,
        labelBytesPerInstance: trainedSh.template.levels,
        sampleRmse: trainedSh.metrics.sampleRmse,
        measuredRmse: trainedSh.metrics.rmse,
        maximumCoefficientError: trainedSh.metrics.maximumAbsoluteError,
        exceptionCount: trainedSh.metrics.exceptionCount,
        exceptionRatio: trainedSh.metrics.exceptionRatio,
        assignmentBackend: trainedSh.metrics.assignmentBackend,
        assignmentWorkerCount: trainedSh.metrics.assignmentWorkerCount,
        assignmentElapsedMs: trainedSh.metrics.assignmentElapsedMs,
        attempts: trainedSh.metrics.attempts,
      },
      qualityGate: {
        status: 'numeric-passed',
        shTargetRmse: SH_TARGET_RMSE,
        shMaximumCoefficientError: SH_MAXIMUM_COEFFICIENT_ERROR,
        renderedPsnrRerun: false,
      },
    },
    shPolicy: 'input-trained adaptive 5/10/15-level product VQ with sparse exact FP16 exception vectors',
    segments: descriptors,
    matches: layout.matches,
    streams: streams.map((stream) => stream.entry),
    metadata: {
      editorBuild: createFourCgsEditorBuild(),
      raw4dExport: {
        version: 1,
        sourceNames: prepared.map((source) => source.name),
        sourceScalarEncodings: prepared.map((source) => source.sourceEncoding),
        sourceShBands: prepared.map((source) => source.sourceShBands),
        encodedScalarEncoding: 'float16',
        precisionPolicy: prepared.some((source) => source.sourceEncoding === 'float32')
          ? 'explicit-float32-to-float16-worker-copy-before-v2.6'
          : 'preserve-source-float16-bits',
        sourceSha256: compacted.map((value) => value.sourceSha256),
        sourceKind: 'canonical-memory-or-file-snapshot',
        // #WDD-gpt 2026-08-19 - 4CGS V2 容器保留统一 K=2 静态端点/动态关键帧布局，后续只需替换输入读取适配器。
        temporalLayouts: prepared.map((source) => source.temporalLayout ?? null),
        originalPointCount,
        encodedPointCount,
        deletedPointCount,
      },
    },
  };
  const containerStartedAt = performance.now();
  onProgress?.(0.96, '正在写入并回读校验 V2.6 4CGS', {
    stage: '容器写入校验', stageRatio: 0, workerCount: encoderWorkerCount,
    completedTasks: 7, totalTasks: 8,
  });
  const blob = container(manifest, streams);
  const reopened = await readFourCgsManifest(blob);
  if (reopened.manifest.slotCount !== layout.slotCount) throw new Error('V2.6 浏览器导出写后校验失败。');
  const filename = raw4DBundleOutputName(prepared.map((source) => source.name), firstFrame, lastFrame);
  stageMs.container = performance.now() - containerStartedAt;
  const totalMs = performance.now() - totalStartedAt;
  onProgress?.(1, `V2.6 编码完成：${(blob.size / 1_000_000).toFixed(3)}M`, {
    stage: '完成', stageRatio: 1, workerCount: encoderWorkerCount,
    completedTasks: 8, totalTasks: 8, elapsedMs: totalMs,
  });
  return {
    blob,
    filename,
    sourceBytes,
    outputBytes: blob.size,
    compressionRatio: sourceBytes / blob.size,
    sourceSha256: compacted.map((value) => value.sourceSha256),
    originalPointCount,
    encodedPointCount,
    deletedPointCount,
    encodeTimings: { totalMs, workerCount: encoderWorkerCount, stageMs },
  };
}
