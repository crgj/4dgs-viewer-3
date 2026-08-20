export interface FourCgsBankCounts {
  readonly position: number;
  readonly rotation: number;
  readonly colorDc: number;
  readonly scale: number;
  readonly opacity: number;
}

export type FourCgsKeyframeStrides = FourCgsBankCounts;

export interface FourCgsSegment {
  readonly name: string;
  readonly firstFrame: number;
  readonly lastFrame: number;
  readonly gaussianCount: number;
  readonly totalFrames: number;
  readonly frameRate?: number;
  readonly bankCounts: FourCgsBankCounts;
  readonly keyframeStrides?: FourCgsKeyframeStrides;
  readonly positionTiming?: 'shared-keyframes' | 'per-point-lifetime-endpoints';
  readonly opacityTiming?: 'lifetime-gated' | 'baked';
}

export interface FourCgsStreamEntry {
  readonly name: string;
  readonly compression: 'raw' | 'deflate' | 'deflate-shuffle16' | 'brotli' | 'brotli-shuffle16';
  readonly rawBytes: number;
  readonly storedBytes: number;
  readonly rawSha256: string;
  readonly storedSha256: string;
  readonly v21DecodedBytes?: number;
  readonly v21DecodedSha256?: string;
}

export interface FourCgsSceneTransform {
  readonly schemaVersion: 1;
  readonly coordinateSystem: 'playcanvas-y-up';
  readonly units: 'meter';
  readonly position: readonly [number, number, number];
  readonly rotationEulerDegrees: readonly [number, number, number];
  readonly scale: readonly [number, number, number];
}

export interface FourCgsCameraBookmark {
  readonly distance: number;
  readonly pitch: number;
  readonly target: readonly [number, number, number];
  readonly yaw: number;
}

export interface FourCgsCameraBookmarks {
  readonly schemaVersion: 1;
  readonly coordinateSystem: 'playcanvas-y-up';
  readonly bookmarks: readonly [
    FourCgsCameraBookmark | null,
    FourCgsCameraBookmark | null,
    FourCgsCameraBookmark | null,
  ];
}

// #WDD-gpt 2026-08-20 - 4CGS 文件记录实际写入它的 Dong Editor 构建版本，便于格式问题追溯。
export interface FourCgsEditorBuild {
  readonly schemaVersion: 1;
  readonly product: 'Dong Editor 3';
  readonly version: string;
}

export interface FourCgsMetadata {
  readonly editorBuild?: FourCgsEditorBuild;
  readonly sceneTransform?: FourCgsSceneTransform;
  readonly cameraBookmarks?: FourCgsCameraBookmarks;
  readonly raw4dBundle?: {
    readonly version: 1;
    readonly chunkBytes: number;
    readonly segmentChunkCounts: readonly number[];
    readonly sourceNames: readonly string[];
    readonly sourceByteLengths: readonly number[];
    readonly sourceSha256: readonly string[];
    readonly exactSourceBytes: true;
    readonly originalPointCount?: number;
    readonly encodedPointCount?: number;
    readonly deletedPointCount?: number;
  };
  readonly [key: string]: unknown;
}

export interface FourCgsManifest {
  readonly format: '4CGS';
  readonly version: number;
  readonly codecName: string;
  readonly slotCount: number;
  readonly firstFrame: number;
  readonly lastFrame: number;
  readonly uniqueFrameCount: number;
  readonly segments: readonly FourCgsSegment[];
  readonly streams: readonly FourCgsStreamEntry[];
  readonly crop: {
    readonly center: readonly [number, number, number];
    readonly halfExtent: number;
  };
  readonly prs: Record<string, unknown>;
  readonly losslessEntropy?: {
    readonly temporalModes?: Readonly<Record<string, 'xor' | 'delta' | 'zigzag'>>;
  };
  readonly mintMixRq?: Record<string, unknown>;
  readonly mesongsTemporal?: Record<string, unknown>;
  readonly temporalAttributes?: Record<string, unknown>;
  readonly metadata?: FourCgsMetadata;
  readonly [key: string]: unknown;
}

export interface FourCgsDescriptor {
  readonly sourceName: string;
  readonly sourceBytes: number;
  readonly codecName: string;
  readonly firstFrame: number;
  readonly lastFrame: number;
  readonly totalFrames: number;
  readonly slotCount: number;
  readonly segments: readonly FourCgsSegment[];
  readonly sceneTransform?: FourCgsSceneTransform;
  readonly cameraBookmarks?: FourCgsCameraBookmarks;
  readonly crossOriginIsolated: boolean;
  readonly decodeTimings: FourCgsDecodeTimings;
}

export interface FourCgsDecodeTimings {
  readonly streamReadMs: number;
  readonly streamWorkerCount?: number;
  readonly attributeDecodeMs: number;
  readonly totalMs: number;
  readonly workerCount: number;
  readonly hardwareConcurrency: number;
  readonly attributeTasksMs: Readonly<Record<string, number>>;
}

export interface FourCgsProgress {
  readonly ratio: number;
  readonly message: string;
  readonly stage?: string;
  readonly stageRatio?: number;
  readonly workerCount?: number;
  readonly completedTasks?: number;
  readonly totalTasks?: number;
  readonly elapsedMs?: number;
}

export interface FourCgsFrameLocation {
  readonly segmentIndex: number;
  readonly localFrame: number;
  readonly sourceFrame: number;
}
