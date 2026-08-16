import type { GS2MeshGaussianFieldInput } from './GS2MeshTypes';

export type GS2MeshOpacityWorkerStage = 'matching' | 'fusing';

export interface GS2MeshOpacityWorkerReady {
  readonly type: 'ready';
}

export interface GS2MeshOpacityWorkerRequest {
  readonly type: 'reconstruct-opacity';
  readonly requestId: number;
  readonly input: GS2MeshGaussianFieldInput;
}

export interface GS2MeshOpacityWorkerProgress {
  readonly type: 'progress';
  readonly requestId: number;
  readonly stage: GS2MeshOpacityWorkerStage;
  readonly progress: number;
}

export interface GS2MeshOpacityWorkerResult {
  readonly type: 'result';
  readonly requestId: number;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly colors: Uint8Array;
  readonly indices: Uint32Array;
  readonly backend?: string;
}

export interface GS2MeshOpacityWorkerPreview {
  readonly type: 'preview';
  readonly requestId: number;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly colors: Uint8Array;
  readonly indices: Uint32Array;
  readonly backend: string;
  readonly elapsedMs: number;
}

export interface GS2MeshOpacityWorkerFailure {
  readonly type: 'error';
  readonly requestId: number;
  readonly message: string;
}

export type GS2MeshOpacityWorkerResponse =
  | GS2MeshOpacityWorkerReady
  | GS2MeshOpacityWorkerProgress
  | GS2MeshOpacityWorkerPreview
  | GS2MeshOpacityWorkerResult
  | GS2MeshOpacityWorkerFailure;
