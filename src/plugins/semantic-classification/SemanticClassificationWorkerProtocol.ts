import type { SemanticClassificationBackend } from './SemanticClassificationBackend';

export interface SemanticWorkerInitializeRequest {
  readonly type: 'initialize';
  readonly requestId: number;
}

export interface SemanticWorkerClassifyRequest {
  readonly type: 'classify';
  readonly requestId: number;
  readonly bitmap: ImageBitmap;
  readonly prompts: readonly string[];
}

export interface SemanticWorkerDisposeRequest {
  readonly type: 'dispose';
}

export type SemanticWorkerRequest =
  | SemanticWorkerInitializeRequest
  | SemanticWorkerClassifyRequest
  | SemanticWorkerDisposeRequest;

export interface SemanticWorkerProgressResponse {
  readonly type: 'progress';
  readonly requestId: number;
  readonly status: string;
  readonly file?: string;
  readonly loaded?: number;
  readonly total?: number;
  readonly progress?: number;
}

export interface SemanticWorkerReadyResponse {
  readonly type: 'ready';
  readonly requestId: number;
  readonly backend: SemanticClassificationBackend;
}

export interface SemanticWorkerResultResponse {
  readonly type: 'result';
  readonly requestId: number;
  readonly width: number;
  readonly height: number;
  readonly probabilities: Float32Array;
}

export interface SemanticWorkerErrorResponse {
  readonly type: 'error';
  readonly requestId: number;
  readonly message: string;
}

export type SemanticWorkerResponse =
  | SemanticWorkerProgressResponse
  | SemanticWorkerReadyResponse
  | SemanticWorkerResultResponse
  | SemanticWorkerErrorResponse;
