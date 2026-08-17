import type { Raw4DMemorySnapshot } from './Raw4DTypes';

export interface Raw4DPlySequenceExportWorkerStats {
  readonly segmentCount: number;
  readonly frameCount: number;
  readonly deletedPointCount: number;
  readonly outputBytes: number;
}

export interface Raw4DPlySequenceExportWorkerResult {
  readonly directoryName: string;
  readonly stats: Raw4DPlySequenceExportWorkerStats;
}

export interface Raw4DPlySequenceExportWorkerProgress {
  readonly ratio: number;
  readonly frameIndex: number;
  readonly frameCount: number;
  readonly message: string;
}

export type Raw4DPlySequenceExportWorkerRequest = {
  readonly type: 'export';
  readonly requestId: number;
  readonly sources: readonly Raw4DMemorySnapshot[];
  readonly directory: FileSystemDirectoryHandle;
};

export type Raw4DPlySequenceExportWorkerResponse =
  | { readonly type: 'progress'; readonly progress: Raw4DPlySequenceExportWorkerProgress }
  | { readonly type: 'result'; readonly requestId: number; readonly result: Raw4DPlySequenceExportWorkerResult }
  | { readonly type: 'error'; readonly requestId: number; readonly message: string };
