import type { Raw4DSequenceDescriptor, Raw4DSequenceProgress } from './Raw4DSequenceTypes';

export interface Raw4DSequenceWorkerOpenRequest {
  readonly type: 'open';
  readonly requestId: number;
  readonly files: readonly File[];
}

export interface Raw4DSequenceWorkerCancelRequest {
  readonly type: 'cancel';
  readonly requestId: number;
}

export type Raw4DSequenceWorkerRequest = Raw4DSequenceWorkerOpenRequest | Raw4DSequenceWorkerCancelRequest;

export interface Raw4DSequenceWorkerProgressResponse {
  readonly type: 'progress';
  readonly requestId: number;
  readonly progress: Raw4DSequenceProgress;
}

export interface Raw4DSequenceWorkerOpenedResponse {
  readonly type: 'opened';
  readonly requestId: number;
  readonly descriptor: Raw4DSequenceDescriptor;
}

export interface Raw4DSequenceWorkerErrorResponse {
  readonly type: 'error';
  readonly requestId: number;
  readonly name: string;
  readonly message: string;
}

export type Raw4DSequenceWorkerResponse =
  | Raw4DSequenceWorkerProgressResponse
  | Raw4DSequenceWorkerOpenedResponse
  | Raw4DSequenceWorkerErrorResponse;
