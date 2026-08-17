export type SmartAlignmentVector3 = readonly [number, number, number];

export type SmartAlignmentViewId =
  | 'positive-x'
  | 'negative-x'
  | 'positive-z'
  | 'negative-z'
  | 'positive-x-positive-z'
  | 'positive-x-negative-z'
  | 'negative-x-positive-z'
  | 'negative-x-negative-z'
  | `sphere-${number}`
  | `azimuth-${
    | '0000' | '0225' | '0450' | '0675'
    | '0900' | '1125' | '1350' | '1575'
    | '1800' | '2025' | '2250' | '2475'
    | '2700' | '2925' | '3150' | '3375'
  }`;

export interface SmartAlignmentTransform {
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number];
  readonly scale: readonly [number, number, number];
}

export interface SmartAlignmentCapture {
  readonly id: SmartAlignmentViewId;
  readonly bitmap: ImageBitmap;
  readonly center: SmartAlignmentVector3;
  readonly right: SmartAlignmentVector3;
  readonly up: SmartAlignmentVector3;
  readonly forward: SmartAlignmentVector3;
  readonly horizontalSpan: number;
  readonly verticalSpan: number;
}

export interface SmartAlignmentViewAnalysis extends Omit<SmartAlignmentCapture, 'bitmap'> {
  readonly poses: readonly SmartAlignmentPose[];
  readonly faces: readonly SmartAlignmentFace[];
}

export interface SmartAlignmentLandmark {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly visibility: number;
}

export interface SmartAlignmentPose {
  readonly landmarks: readonly SmartAlignmentLandmark[];
}

export interface SmartAlignmentFace {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly confidence: number;
}

export interface SmartAlignmentDetection {
  readonly poses: readonly SmartAlignmentPose[];
  readonly faces: readonly SmartAlignmentFace[];
}

export interface SmartAlignmentCaptureOptions {
  readonly useCurrentCameraAsFirstView?: boolean;
}

export interface SmartAlignmentHost {
  captureSmartAlignmentViews(
    viewIds: readonly SmartAlignmentViewId[],
    options?: SmartAlignmentCaptureOptions,
  ): Promise<SmartAlignmentCapture[]>;
  getSmartAlignmentTransform(): SmartAlignmentTransform;
  restoreSmartAlignmentTransform(transform: SmartAlignmentTransform): void;
  commitSmartAlignmentTransform?(): void;
  applySmartAlignmentSolution(
    worldUp: SmartAlignmentVector3,
    standingCenter: SmartAlignmentVector3,
  ): SmartAlignmentVector3;
}

export type SmartAlignmentStage =
  | 'idle'
  | 'loading-model'
  | 'capturing-orientation'
  | 'analyzing-orientation'
  | 'analyzing-ground'
  | 'applying'
  | 'verifying'
  | 'refining'
  | 'success'
  | 'error';

export interface SmartAlignmentState {
  readonly stage: SmartAlignmentStage;
  readonly progress: number;
  readonly peopleCount?: number;
  readonly viewsUsed?: number;
  readonly confidence?: number;
  readonly standingCenter?: SmartAlignmentVector3;
  readonly verificationStatus?: 'confirmed' | 'inconclusive';
  readonly error?: string;
}

export const INITIAL_SMART_ALIGNMENT_STATE: SmartAlignmentState = {
  stage: 'idle',
  progress: 0,
};
