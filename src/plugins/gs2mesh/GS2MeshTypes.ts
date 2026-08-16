export type GS2MeshVector3 = readonly [number, number, number];

export interface GS2MeshCamera {
  readonly position: GS2MeshVector3;
  readonly right: GS2MeshVector3;
  readonly up: GS2MeshVector3;
  readonly forward: GS2MeshVector3;
  readonly width: number;
  readonly height: number;
  readonly fx: number;
  readonly fy: number;
  readonly cx: number;
  readonly cy: number;
}

export interface GS2MeshCapturePair {
  readonly id: string;
  readonly left: Blob;
  readonly right: Blob;
  readonly leftCamera: GS2MeshCamera;
  readonly rightCamera: GS2MeshCamera;
  readonly baseline: number;
}

export interface GS2MeshCaptureResult {
  readonly frame: number;
  readonly focus: GS2MeshVector3;
  readonly sceneRadius: number;
  readonly boundsMin: GS2MeshVector3;
  readonly boundsMax: GS2MeshVector3;
  readonly surfacePoints: Float32Array;
  readonly pairs: readonly GS2MeshCapturePair[];
}

export interface GS2MeshOptions {
  readonly fieldResolution: number;
  readonly isoLevel: number;
  readonly maxGaussians: number;
  readonly viewCount: number;
  readonly sceneUnitMillimeters: number;
  readonly targetVoxelMillimeters: number;
  readonly smoothingIterations: number;
}

export interface GS2MeshCaptureOptions {
  readonly viewCount: number;
  readonly resolution: number;
  readonly baselinePercent: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (completed: number, total: number) => void;
}

export interface GS2MeshGaussianFieldInput {
  readonly frame: number;
  readonly focus: GS2MeshVector3;
  readonly boundsMin: GS2MeshVector3;
  readonly boundsMax: GS2MeshVector3;
  readonly positions: Float32Array;
  readonly rotations: Float32Array;
  readonly scales: Float32Array;
  readonly colors: Uint8Array;
  readonly opacities: Float32Array;
  readonly views: readonly GS2MeshFieldView[];
  readonly fieldResolution: number;
  readonly isoLevel: number;
  readonly sceneUnitMillimeters?: number;
  readonly targetVoxelMillimeters?: number;
  readonly targetVoxelSize?: number;
  readonly smoothingIterations?: number;
}

export interface GS2MeshFieldView {
  readonly position: GS2MeshVector3;
  readonly right: GS2MeshVector3;
  readonly up: GS2MeshVector3;
  readonly forward: GS2MeshVector3;
  readonly tanHalfFovX: number;
  readonly tanHalfFovY: number;
}

export interface GS2MeshGaussianCaptureOptions extends GS2MeshOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (completed: number, total: number) => void;
}

export interface GS2MeshData {
  readonly positions: Float32Array;
  readonly normals: Float32Array | null;
  readonly colors: Uint8Array;
  readonly indices: Uint32Array;
}

export interface GS2MeshSceneStats {
  readonly vertexCount: number;
  readonly triangleCount: number;
}

export interface GS2MeshHost {
  captureGS2MeshViews(options: GS2MeshCaptureOptions): Promise<GS2MeshCaptureResult>;
  captureGS2MeshGaussians(options: GS2MeshGaussianCaptureOptions): Promise<GS2MeshGaussianFieldInput>;
  installGS2Mesh(data: GS2MeshData): GS2MeshSceneStats;
  clearGS2Mesh(): void;
  setGS2MeshVisible(visible: boolean): void;
  setGaussianVisible(visible: boolean): void;
}

export type GS2MeshStage =
  | 'idle'
  | 'capturing'
  | 'matching'
  | 'fusing'
  | 'installing'
  | 'success'
  | 'cancelled'
  | 'error';

export interface GS2MeshState {
  readonly stage: GS2MeshStage;
  readonly progress: number;
  readonly frame?: number;
  readonly viewCount?: number;
  readonly gaussianCount?: number;
  readonly vertexCount?: number;
  readonly triangleCount?: number;
  readonly focus?: GS2MeshVector3;
  readonly backend?: string;
  readonly previewBackend?: string;
  readonly warning?: string;
  readonly error?: string;
}

export const INITIAL_GS2MESH_STATE: GS2MeshState = {
  stage: 'idle',
  progress: 0,
};
