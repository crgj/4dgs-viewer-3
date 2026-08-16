import type { Raw4DAsset, Raw4DParseProgress } from './Raw4DTypes';

export interface Raw4DLoaderWorkerLoadRequest {
  readonly type: 'load';
  readonly requestId: number;
  readonly file: File;
  readonly cpuBudgetBytes: number;
  readonly preferSharedMemory: boolean;
}

export interface Raw4DLoaderWorkerCancelRequest {
  readonly type: 'cancel';
  readonly requestId: number;
}

export interface Raw4DLoaderWorkerReleaseRequest {
  readonly type: 'release';
  readonly bufferId: string;
}

export type Raw4DLoaderWorkerRequest =
  | Raw4DLoaderWorkerLoadRequest
  | Raw4DLoaderWorkerCancelRequest
  | Raw4DLoaderWorkerReleaseRequest;

export interface Raw4DLoaderWorkerProgressResponse {
  readonly type: 'progress';
  readonly requestId: number;
  readonly progress: Raw4DParseProgress;
}

export interface Raw4DLoaderWorkerLoadedResponse {
  readonly type: 'loaded';
  readonly requestId: number;
  readonly bufferId: string;
  readonly asset: Raw4DAsset;
  readonly cpuResidentBytes: number;
  readonly transport: 'shared-array-buffer' | 'transferable';
  readonly decodeBackend: 'wasm' | 'fp16-bits' | 'typed-array';
}

export interface Raw4DLoaderWorkerErrorResponse {
  readonly type: 'error';
  readonly requestId: number;
  readonly name: string;
  readonly message: string;
}

export type Raw4DLoaderWorkerResponse =
  | Raw4DLoaderWorkerProgressResponse
  | Raw4DLoaderWorkerLoadedResponse
  | Raw4DLoaderWorkerErrorResponse;
