import type { Raw4DAsset, Raw4DSource } from './Raw4DTypes';
import { exportCompactedRaw4D, exportCompactedRaw4DSource, type Raw4DExportProgress } from './Raw4DExporter';

export interface Raw4DSegmentExportInput {
  readonly asset: Raw4DAsset;
  readonly deletionWords: Uint32Array;
  readonly filename: string;
  readonly source?: Raw4DSource | null;
  readonly sourcePreserved: boolean;
}

export interface Raw4DSegmentBatchProgress {
  readonly completedSegments: number;
  readonly filename: string;
  readonly ratio: number;
  readonly segmentCount: number;
  readonly segmentIndex: number;
  readonly segmentRatio: number;
  readonly sourceName: string;
  readonly stage: 'encoding' | 'writing' | 'complete';
  readonly totalPoints: number;
  readonly writtenPoints: number;
}

export interface Raw4DSegmentBatchFile {
  readonly blob: Blob;
  readonly filename: string;
  readonly pointCount: number;
  readonly segmentCount: number;
  readonly segmentIndex: number;
  readonly sourceName: string;
  readonly sourcePreserved: boolean;
}

export interface Raw4DSegmentBatchResult {
  readonly fileCount: number;
  readonly outputBytes: number;
  readonly pointCount: number;
  readonly sourcePreservedCount: number;
}

export interface Raw4DSegmentBatchOptions {
  readonly onProgress?: (progress: Raw4DSegmentBatchProgress) => void;
  readonly signal?: AbortSignal;
  readonly writeSegment: (file: Raw4DSegmentBatchFile) => Promise<void>;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('RAW4D export was cancelled.', 'AbortError');
}

// #WDD-gpt 2026-09-07 - 多段 RAW4D 按输入顺序逐段压实、提交和释放，禁止合并片段或累计全部输出 Blob。
export async function exportRaw4DSegmentBatch(
  inputs: readonly Raw4DSegmentExportInput[],
  options: Raw4DSegmentBatchOptions,
): Promise<Raw4DSegmentBatchResult> {
  if (inputs.length === 0) throw new Error('RAW4D export requires at least one segment.');
  const totalSourcePoints = inputs.reduce((sum, input) => sum + input.asset.splatCount, 0);
  let completedSourcePoints = 0;
  let outputBytes = 0;
  let pointCount = 0;
  let sourcePreservedCount = 0;
  for (let segmentIndex = 0; segmentIndex < inputs.length; segmentIndex += 1) {
    throwIfAborted(options.signal);
    const input = inputs[segmentIndex];
    const sourceName = input.asset.sourceName;
    const sourcePreserved = input.sourcePreserved && Boolean(input.source);
    let writtenPoints = 0;
    const onProgress = (progress: Raw4DExportProgress) => {
      writtenPoints = progress.totalPoints;
      options.onProgress?.({
        completedSegments: segmentIndex,
        filename: input.filename,
        ratio: totalSourcePoints > 0
          ? (completedSourcePoints + input.asset.splatCount * progress.ratio * 0.9) / totalSourcePoints
          : 0,
        segmentCount: inputs.length,
        segmentIndex,
        segmentRatio: progress.ratio * 0.9,
        sourceName,
        stage: 'encoding',
        totalPoints: progress.totalPoints,
        writtenPoints: progress.writtenPoints,
      });
    };
    const blob = sourcePreserved && input.source
      ? await exportCompactedRaw4DSource(input.source, input.deletionWords, { onProgress, signal: options.signal })
      : await exportCompactedRaw4D(input.asset, input.deletionWords, { onProgress, signal: options.signal });
    throwIfAborted(options.signal);
    options.onProgress?.({
      completedSegments: segmentIndex,
      filename: input.filename,
      ratio: totalSourcePoints > 0
        ? (completedSourcePoints + input.asset.splatCount * 0.95) / totalSourcePoints
        : 0.95,
      segmentCount: inputs.length,
      segmentIndex,
      segmentRatio: 0.95,
      sourceName,
      stage: 'writing',
      totalPoints: writtenPoints,
      writtenPoints,
    });
    await options.writeSegment({
      blob,
      filename: input.filename,
      pointCount: writtenPoints,
      segmentCount: inputs.length,
      segmentIndex,
      sourceName,
      sourcePreserved,
    });
    completedSourcePoints += input.asset.splatCount;
    outputBytes += blob.size;
    pointCount += writtenPoints;
    if (sourcePreserved) sourcePreservedCount += 1;
    options.onProgress?.({
      completedSegments: segmentIndex + 1,
      filename: input.filename,
      ratio: totalSourcePoints > 0 ? completedSourcePoints / totalSourcePoints : 1,
      segmentCount: inputs.length,
      segmentIndex,
      segmentRatio: 1,
      sourceName,
      stage: 'complete',
      totalPoints: writtenPoints,
      writtenPoints,
    });
  }
  return { fileCount: inputs.length, outputBytes, pointCount, sourcePreservedCount };
}
