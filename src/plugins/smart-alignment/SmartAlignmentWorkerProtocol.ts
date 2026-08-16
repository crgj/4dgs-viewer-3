import type { SmartAlignmentFace, SmartAlignmentPose } from './SmartAlignmentTypes';

export interface SmartAlignmentWorkerInitializeRequest {
  readonly type: 'initialize';
  readonly requestId: number;
  readonly wasmRoot: string;
  readonly modelUrl: string;
  readonly faceModelUrl: string;
}

export interface SmartAlignmentWorkerDetectRequest {
  readonly type: 'detect';
  readonly requestId: number;
  readonly bitmap: ImageBitmap;
}

export interface SmartAlignmentWorkerDisposeRequest {
  readonly type: 'dispose';
}

export type SmartAlignmentWorkerRequest =
  | SmartAlignmentWorkerInitializeRequest
  | SmartAlignmentWorkerDetectRequest
  | SmartAlignmentWorkerDisposeRequest;

export interface SmartAlignmentWorkerReadyResponse {
  readonly type: 'ready';
  readonly requestId: number;
}

export interface SmartAlignmentWorkerDetectionResponse {
  readonly type: 'detection';
  readonly requestId: number;
  readonly poses: readonly SmartAlignmentPose[];
  readonly faces: readonly SmartAlignmentFace[];
}

export interface SmartAlignmentWorkerErrorResponse {
  readonly type: 'error';
  readonly requestId: number;
  readonly message: string;
}

export type SmartAlignmentWorkerResponse =
  | SmartAlignmentWorkerReadyResponse
  | SmartAlignmentWorkerDetectionResponse
  | SmartAlignmentWorkerErrorResponse;
