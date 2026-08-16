import type { GS2MeshCaptureResult } from './GS2MeshTypes';

export type GS2MeshWorkerStage = 'matching' | 'fusing';

export interface GS2MeshWorkerRequest {
  readonly type: 'reconstruct';
  readonly requestId: number;
  readonly capture: GS2MeshCaptureResult;
}

export interface GS2MeshWorkerProgress {
  readonly type: 'progress';
  readonly requestId: number;
  readonly stage: GS2MeshWorkerStage;
  readonly progress: number;
}

export interface GS2MeshWorkerResult {
  readonly type: 'result';
  readonly requestId: number;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly colors: Uint8Array;
  readonly indices: Uint32Array;
}

export interface GS2MeshWorkerFailure {
  readonly type: 'error';
  readonly requestId: number;
  readonly message: string;
}

export type GS2MeshWorkerResponse = GS2MeshWorkerProgress | GS2MeshWorkerResult | GS2MeshWorkerFailure;
