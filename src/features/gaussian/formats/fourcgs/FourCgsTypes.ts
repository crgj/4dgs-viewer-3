export interface FourCgsBankCounts {
  readonly position: number;
  readonly rotation: number;
  readonly colorDc: number;
  readonly scale: number;
  readonly opacity: number;
}

export interface FourCgsSegment {
  readonly name: string;
  readonly firstFrame: number;
  readonly lastFrame: number;
  readonly gaussianCount: number;
  readonly totalFrames: number;
  readonly bankCounts: FourCgsBankCounts;
}

export interface FourCgsStreamEntry {
  readonly name: string;
  readonly compression: 'raw' | 'deflate' | 'brotli' | 'brotli-shuffle16';
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

export interface FourCgsMetadata {
  readonly sceneTransform?: FourCgsSceneTransform;
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
  readonly crossOriginIsolated: boolean;
  readonly decodeTimings: FourCgsDecodeTimings;
}

export interface FourCgsDecodeTimings {
  readonly streamReadMs: number;
  readonly attributeDecodeMs: number;
  readonly totalMs: number;
  readonly workerCount: number;
  readonly hardwareConcurrency: number;
  readonly attributeTasksMs: Readonly<Record<string, number>>;
}

export interface FourCgsProgress {
  readonly ratio: number;
  readonly message: string;
}

export interface FourCgsFrameLocation {
  readonly segmentIndex: number;
  readonly localFrame: number;
  readonly sourceFrame: number;
}
