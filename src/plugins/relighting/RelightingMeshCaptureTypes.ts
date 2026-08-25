// #WDD-gpt 2026-08-21 - 重光照逐帧代理改为流式提交每一帧的原始激活 Gaussian，避免整段复制与跨帧平均污染。
import type { GS2MeshGaussianFieldInput } from '../gs2mesh/GS2MeshTypes';

/** @deprecated 仅供旧采集实现保留类型兼容；运行路径已改用逐帧流式 visitor。 */
export interface RelightingFrameGaussians {
  readonly positions: Float32Array;
  readonly rotations: Float32Array;
  readonly scales: Float32Array;
  readonly opacities: Float32Array;
}

/** @deprecated 仅供旧采集实现保留类型兼容；运行路径已改用逐帧流式 visitor。 */
export interface RelightingMeshCaptureResult {
  readonly frameIndices: readonly number[];
  readonly frames: readonly RelightingFrameGaussians[];
  readonly uids: Float64Array;
  readonly colors: Uint8Array;
  readonly canonical: GS2MeshGaussianFieldInput;
}

export interface RelightingMeshCaptureOptions {
  /** 全局时间轴帧号，inclusive；跨片段时由 Runtime 映射到对应段的本地帧。 */
  readonly frameStart: number;
  readonly frameEnd: number;
  readonly frameIndexOffset?: number;
  readonly maxGaussians: number;
  readonly fieldResolution: number;
  readonly isoLevel: number;
  readonly viewCount: number;
  readonly sceneUnitMillimeters: number;
  readonly targetVoxelMillimeters: number;
  readonly smoothingIterations: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (frameIndex: number, totalFrames: number) => void;
}

export type RelightingMeshFrameVisitor = (
  input: GS2MeshGaussianFieldInput,
  completed: number,
  totalFrames: number,
) => Promise<void>;
