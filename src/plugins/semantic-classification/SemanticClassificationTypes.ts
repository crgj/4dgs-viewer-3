import type { SemanticClassificationBackend } from './SemanticClassificationBackend';

export type SemanticVector3 = readonly [number, number, number];

export interface SemanticTag {
  readonly id: number;
  readonly name: string;
  readonly prompt: string;
  readonly color: string;
}

export interface SemanticViewCapture {
  readonly id: string;
  readonly frame: number;
  readonly bitmap: ImageBitmap;
  readonly center: SemanticVector3;
  readonly right: SemanticVector3;
  readonly up: SemanticVector3;
  readonly forward: SemanticVector3;
  readonly horizontalSpan: number;
  readonly verticalSpan: number;
}

export interface SemanticViewMask extends Omit<SemanticViewCapture, 'bitmap'> {
  readonly width: number;
  readonly height: number;
  readonly probabilities: Float32Array;
}

export interface SemanticClassSummary {
  readonly id: number;
  readonly name: string;
  readonly prompt: string;
  readonly color: string;
  readonly count: number;
  readonly meanConfidence: number;
}

export interface SemanticClassificationResult {
  readonly pointCount: number;
  readonly activePointCount: number;
  readonly deletedPointCount: number;
  readonly classifiedCount: number;
  readonly unclassifiedCount: number;
  readonly directCount: number;
  readonly propagatedCount: number;
  readonly coverage: number;
  readonly meanConfidence: number;
  readonly viewCount: number;
  readonly frameCount: number;
  readonly seed: number;
  readonly classes: readonly SemanticClassSummary[];
}

export interface SemanticCaptureOptions {
  readonly viewCount: number;
  readonly seed: number;
  readonly onProgress?: (completed: number, total: number) => void;
}

export interface SemanticApplyOptions {
  readonly tags: readonly SemanticTag[];
  readonly masks: readonly SemanticViewMask[];
  readonly threshold: number;
  readonly seed: number;
}

export interface SemanticClassificationHost {
  captureSemanticClassificationViews(options: SemanticCaptureOptions): Promise<SemanticViewCapture[]>;
  applySemanticClassification(options: SemanticApplyOptions): SemanticClassificationResult;
  selectSemanticClass(classId: number): number;
}

export type SemanticClassificationStage =
  | 'idle'
  | 'loading-model'
  | 'capturing'
  | 'classifying'
  | 'projecting'
  | 'success'
  | 'cancelled'
  | 'error';

export interface SemanticClassificationState {
  readonly stage: SemanticClassificationStage;
  readonly progress: number;
  readonly backend?: SemanticClassificationBackend;
  readonly downloadedBytes?: number;
  readonly totalBytes?: number;
  readonly currentView?: number;
  readonly totalViews?: number;
  readonly result?: SemanticClassificationResult;
  readonly error?: string;
}

export const INITIAL_SEMANTIC_CLASSIFICATION_STATE: SemanticClassificationState = {
  stage: 'idle',
  progress: 0,
};
