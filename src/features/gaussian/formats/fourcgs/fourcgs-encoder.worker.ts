/// <reference lib="webworker" />

import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createFourCgsEditorBuild, FOUR_CGS_HEADER_BYTES, FOUR_CGS_MAGIC, readFourCgsManifest } from './FourCgsContainer';
import {
  RAW4D_BUNDLE_CODEC_NAME,
  RAW4D_BUNDLE_CHUNK_BYTES,
  paddedEvenLength,
  raw4DBundleOutputName,
  raw4DBundleStreamName,
  shuffle16WithPadding,
} from './FourCgsRaw4DBundle';
import type { FourCgsBankCounts, FourCgsKeyframeStrides, FourCgsManifest, FourCgsProgress, FourCgsSegment, FourCgsStreamEntry } from './FourCgsTypes';
import { readRaw4DHeader } from '../raw4d/Raw4DParser';
import {
  buildRaw4DSequenceSegments,
  raw4DSequenceFrameRangeFromName,
} from '../raw4d/Raw4DSequence';
import {
  RAW4D_TRACK_DEFINITIONS,
  raw4DBankCount,
  raw4DTrackStride,
} from '../raw4d/Raw4DSchema';
import type { Raw4DHeader } from '../raw4d/Raw4DTypes';
import { exportCompactedRaw4DSource } from '../raw4d/Raw4DExporter';
import {
  encodeRaw4DV26Browser,
  encodeRaw4DV26BrowserMemory,
} from './FourCgsV26BrowserEncoder';
import type { Raw4DMemorySnapshot } from '../raw4d/Raw4DTypes';

interface FileEncodeRequest {
  readonly type: 'files';
  readonly files: readonly File[];
  readonly deletionWords: readonly Uint32Array[];
}

interface MemoryEncodeRequest {
  readonly type: 'memory';
  readonly sources: readonly Raw4DMemorySnapshot[];
}

type EncodeRequest = FileEncodeRequest | MemoryEncodeRequest;

interface SourceInfo {
  readonly fileIndex: number;
  readonly name: string;
  readonly file: Blob;
  readonly header: Raw4DHeader;
  readonly originalVertexCount: number;
  readonly deletedPointCount: number;
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

let encoderStartedAt = performance.now();
let encoderPeakWorkerCount = 1;

function workerProgress(ratio: number, message: string, detail: Partial<FourCgsProgress> = {}): void {
  // #WDD-gpt 2026-08-16 - SH 主线程进度不得覆盖仍在工作的属性池，监督窗口持续显示本次任务的峰值 Worker 数。
  encoderPeakWorkerCount = Math.max(encoderPeakWorkerCount, detail.workerCount ?? 1);
  self.postMessage({
    type: 'progress',
    progress: { ratio, message, elapsedMs: performance.now() - encoderStartedAt, ...detail, workerCount: encoderPeakWorkerCount },
  });
}

async function webSha256(source: Uint8Array): Promise<string> {
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function bankCounts(header: Raw4DHeader): FourCgsBankCounts {
  return {
    position: raw4DBankCount(header.propertyNames, RAW4D_TRACK_DEFINITIONS.position),
    rotation: raw4DBankCount(header.propertyNames, RAW4D_TRACK_DEFINITIONS.rotation),
    colorDc: raw4DBankCount(header.propertyNames, RAW4D_TRACK_DEFINITIONS.colorDc),
    scale: raw4DBankCount(header.propertyNames, RAW4D_TRACK_DEFINITIONS.scale),
    opacity: raw4DBankCount(header.propertyNames, RAW4D_TRACK_DEFINITIONS.opacity),
  };
}

function keyframeStrides(header: Raw4DHeader): FourCgsKeyframeStrides {
  return {
    position: raw4DTrackStride(header.comments, RAW4D_TRACK_DEFINITIONS.position),
    rotation: raw4DTrackStride(header.comments, RAW4D_TRACK_DEFINITIONS.rotation),
    colorDc: raw4DTrackStride(header.comments, RAW4D_TRACK_DEFINITIONS.colorDc),
    scale: raw4DTrackStride(header.comments, RAW4D_TRACK_DEFINITIONS.scale),
    opacity: raw4DTrackStride(header.comments, RAW4D_TRACK_DEFINITIONS.opacity),
  };
}

function singleSegment(source: SourceInfo): FourCgsSegment {
  const range = raw4DSequenceFrameRangeFromName(source.name);
  const firstFrame = range?.firstFrame ?? 0;
  const lastFrame = range?.lastFrame ?? firstFrame + source.header.totalFrames - 1;
  if (lastFrame - firstFrame + 1 !== source.header.totalFrames) {
    throw new Error(`${source.name} 的文件名帧范围与 total_frames=${source.header.totalFrames} 不一致。`);
  }
  return {
    name: source.name.replace(/\.(?:raw4d|ply4)$/i, ''),
    firstFrame,
    lastFrame,
    gaussianCount: source.header.pointCount,
    totalFrames: source.header.totalFrames,
    bankCounts: bankCounts(source.header),
    keyframeStrides: keyframeStrides(source.header),
  };
}

function orderedSegments(sources: readonly SourceInfo[]): { sources: readonly SourceInfo[]; segments: readonly FourCgsSegment[] } {
  if (sources.length === 1) return { sources, segments: [singleSegment(sources[0])] };
  const sequence = buildRaw4DSequenceSegments(sources);
  const orderedSources = sequence.map((segment) => sources.find((source) => source.fileIndex === segment.fileIndex)!);
  return {
    sources: orderedSources,
    segments: sequence.map((segment, index) => ({
      name: segment.name.replace(/\.(?:raw4d|ply4)$/i, ''),
      firstFrame: segment.firstFrame,
      lastFrame: segment.lastFrame,
      gaussianCount: segment.splatCount,
      totalFrames: segment.totalFrames,
      bankCounts: bankCounts(orderedSources[index].header),
      keyframeStrides: keyframeStrides(orderedSources[index].header),
    })),
  };
}

function containerBytes(manifest: FourCgsManifest, streams: readonly Uint8Array[]): Blob {
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const header = new Uint8Array(FOUR_CGS_HEADER_BYTES);
  header.set(new TextEncoder().encode(FOUR_CGS_MAGIC));
  new DataView(header.buffer).setUint32(8, manifestBytes.byteLength, true);
  const storedParts = streams.map((stream) => (
    stream.byteOffset === 0 && stream.byteLength === stream.buffer.byteLength
      ? stream.buffer as ArrayBuffer
      : stream.slice().buffer as ArrayBuffer
  ));
  return new Blob([header.buffer as ArrayBuffer, manifestBytes.buffer as ArrayBuffer, ...storedParts], { type: 'application/x-4cgs' });
}

async function deflate(source: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持 CompressionStream，无法执行纯前端 RAW4D 压缩。');
  }
  const part = source.byteOffset === 0 && source.byteLength === source.buffer.byteLength
    ? source.buffer as ArrayBuffer
    : source.slice().buffer as ArrayBuffer;
  const compressed = new Blob([part]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

export async function encodeRaw4DBundle(
  files: readonly File[],
  deletionWords: readonly Uint32Array[] = files.map(() => new Uint32Array(0)),
  onProgress?: (ratio: number, message: string) => void,
) {
  if (files.length === 0) throw new Error('没有可编码的 RAW4D 文件。');
  if (deletionWords.length !== files.length) {
    throw new Error(`RAW4D 删除位集数量不一致：${deletionWords.length}/${files.length}。`);
  }
  onProgress?.(0.01, `正在读取本次拖入的 RAW4D 头 0/${files.length}`);
  const sourceInfos = await Promise.all(files.map(async (file, fileIndex): Promise<SourceInfo> => {
    if (!/\.(?:raw4d|ply4)$/i.test(file.name)) throw new Error(`${file.name} 不是 RAW4D/PLY4 文件。`);
    const header = await readRaw4DHeader(file);
    if (header.scalarEncoding !== 'float16') throw new Error(`${file.name} 不是已量化 FP16 RAW4D，当前稳定编码档拒绝隐式降精度。`);
    if (file.size !== header.dataOffset + header.payloadBytes) throw new Error(`${file.name} 的 RAW4D 载荷长度不一致。`);
    const words = deletionWords[fileIndex].length === 0
      ? new Uint32Array(Math.ceil(header.pointCount / 32))
      : deletionWords[fileIndex];
    const deletedPointCount = countDeleted(words, header.pointCount);
    if (deletedPointCount === header.pointCount) throw new Error(`${file.name} 的高斯点已全部删除，无法导出空片段。`);
    if (deletedPointCount === 0) {
      return { fileIndex, name: file.name, file, header, originalVertexCount: header.pointCount, deletedPointCount };
    }
    onProgress?.(0.015, `正在压实 ${file.name}：去掉 ${deletedPointCount.toLocaleString()} 个已删除高斯`);
    const compacted = await exportCompactedRaw4DSource(file, words);
    const compactedHeader = await readRaw4DHeader(compacted);
    return {
      fileIndex,
      name: file.name,
      file: compacted,
      header: compactedHeader,
      originalVertexCount: header.pointCount,
      deletedPointCount,
    };
  }));
  const ordered = orderedSegments(sourceInfos);
  const storedStreams: Uint8Array[] = [];
  const entries: FourCgsStreamEntry[] = [];
  const sourceSha256: string[] = [];
  const segmentChunkCounts = ordered.sources.map((source) => Math.ceil(source.file.size / RAW4D_BUNDLE_CHUNK_BYTES));
  const totalChunks = segmentChunkCounts.reduce((sum, count) => sum + count, 0);
  let completedChunks = 0;
  for (let index = 0; index < ordered.sources.length; index += 1) {
    const source = ordered.sources[index];
    const sourceHasher = nobleSha256.create();
    for (let chunkIndex = 0; chunkIndex < segmentChunkCounts[index]; chunkIndex += 1) {
      const firstByte = chunkIndex * RAW4D_BUNDLE_CHUNK_BYTES;
      const lastByte = Math.min(source.file.size, firstByte + RAW4D_BUNDLE_CHUNK_BYTES);
      onProgress?.(
        0.04 + 0.84 * completedChunks / totalChunks,
        `正在编码本次拖入数据 ${index + 1}/${ordered.sources.length} · 块 ${chunkIndex + 1}/${segmentChunkCounts[index]}：${source.name}`,
      );
      const bytes = new Uint8Array(await source.file.slice(firstByte, lastByte).arrayBuffer());
      sourceHasher.update(bytes);
      const shuffled = shuffle16WithPadding(bytes);
      // #WDD-gpt 2026-08-16 - 16MiB 分块交给浏览器原生 Deflate，避开两分钟级 Brotli WASM；只影响码率，不改变恢复后的源字节。
      const stored = await deflate(shuffled);
      const raw = new Uint8Array(paddedEvenLength(bytes.byteLength));
      raw.set(bytes);
      const [rawDigest, storedDigest] = await Promise.all([webSha256(raw), webSha256(stored)]);
      storedStreams.push(stored);
      entries.push({
        name: raw4DBundleStreamName(index, chunkIndex),
        compression: 'deflate-shuffle16',
        rawBytes: raw.byteLength,
        storedBytes: stored.byteLength,
        rawSha256: rawDigest,
        storedSha256: storedDigest,
      });
      completedChunks += 1;
    }
    sourceSha256.push(bytesToHex(sourceHasher.digest()));
  }
  const firstFrame = ordered.segments[0].firstFrame;
  const lastFrame = ordered.segments.at(-1)!.lastFrame;
  const sourceBytes = ordered.sources.reduce((sum, source) => sum + source.file.size, 0);
  const originalPointCount = ordered.sources.reduce((sum, source) => sum + source.originalVertexCount, 0);
  const deletedPointCount = ordered.sources.reduce((sum, source) => sum + source.deletedPointCount, 0);
  const encodedPointCount = originalPointCount - deletedPointCount;
  const manifest: FourCgsManifest = {
    format: '4CGS',
    version: 2,
    codecName: RAW4D_BUNDLE_CODEC_NAME,
    slotCount: Math.max(...ordered.segments.map((segment) => segment.gaussianCount)),
    firstFrame,
    lastFrame,
    uniqueFrameCount: lastFrame - firstFrame + 1,
    segments: ordered.segments,
    streams: entries,
    crop: { center: [0, 0, 0], halfExtent: 1 },
    prs: { mode: 'raw4d-lossless-bundle' },
    sourceBytes,
    metadata: {
      editorBuild: createFourCgsEditorBuild(),
      raw4dBundle: {
        version: 1,
        chunkBytes: RAW4D_BUNDLE_CHUNK_BYTES,
        segmentChunkCounts,
        sourceNames: ordered.sources.map((source) => source.name),
        sourceByteLengths: ordered.sources.map((source) => source.file.size),
        sourceSha256,
        exactSourceBytes: true,
        originalPointCount,
        encodedPointCount,
        deletedPointCount,
      },
    },
  };
  onProgress?.(0.91, '正在写入并回读校验动态 4CGS 清单');
  const blob = containerBytes(manifest, storedStreams);
  const reopened = await readFourCgsManifest(blob);
  if (reopened.manifest.codecName !== RAW4D_BUNDLE_CODEC_NAME) throw new Error('动态 4CGS 写后清单校验失败。');
  const filename = raw4DBundleOutputName(ordered.sources.map((source) => source.name), firstFrame, lastFrame);
  onProgress?.(1, `已从本次拖入的 ${files.length} 个 RAW4D 生成 ${filename}`);
  return {
    blob,
    filename,
    sourceBytes,
    outputBytes: blob.size,
    compressionRatio: sourceBytes / blob.size,
    sourceSha256,
    originalPointCount,
    encodedPointCount,
    deletedPointCount,
  };
}

async function encodeRaw4DExport(
  files: readonly File[],
  deletionWords: readonly Uint32Array[],
) {
  // #WDD-gpt 2026-08-16 - 正式导出只走通用自适应压缩；质量不够自动升档，禁止静默退回 233MB 级无损 Bundle。
  return encodeRaw4DV26Browser(files, deletionWords, workerProgress);
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.addEventListener('message', (event: MessageEvent<EncodeRequest>) => {
    encoderStartedAt = performance.now();
    encoderPeakWorkerCount = 1;
    const encoding = event.data.type === 'memory'
      ? encodeRaw4DV26BrowserMemory(event.data.sources, workerProgress)
      : encodeRaw4DExport(event.data.files, event.data.deletionWords);
    void encoding.then(
      (result) => self.postMessage({ type: 'result', result }),
      (error: unknown) => self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }),
    );
  });
}

export {};
