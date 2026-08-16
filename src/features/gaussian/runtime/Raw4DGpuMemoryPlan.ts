import type { Raw4DAsset } from '../formats/raw4d/Raw4DTypes';

export interface Raw4DGpuMemoryPlan {
  readonly half: boolean;
  readonly vectorBytes: number;
  readonly scalarBytes: number;
  readonly scalarStride: number;
  readonly positionSlotCount: number;
  readonly rotationSlotCount: number;
  readonly colorSlotCount: number;
  readonly scaleSlotCount: number;
  readonly opacitySlotCount: number;
  readonly rotationOffset: number;
  readonly colorOffset: number;
  readonly scaleOffset: number;
  readonly opacityOffset: number;
  readonly lifetimeMuOffset: number;
  readonly lifetimeWOffset: number;
  readonly positionBytes: number;
  readonly vectorBytesTotal: number;
  readonly scalarBytesTotal: number;
  readonly totalBytes: number;
}

export function createRaw4DGpuMemoryPlan(asset: Raw4DAsset): Raw4DGpuMemoryPlan {
  const half = asset.sourceEncoding === 'float16';
  const vectorBytes = half ? 8 : 16;
  const scalarBytes = half ? 2 : 4;
  const scalarStride = half && asset.splatCount % 2 ? asset.splatCount + 1 : asset.splatCount;
  const positionSlotCount = Math.min(3, asset.position.keyframes.length);
  const rotationSlotCount = Math.min(3, asset.rotation.keyframes.length);
  const colorSlotCount = Math.min(4, asset.colorDc.keyframes.length);
  const scaleSlotCount = Math.min(3, asset.scale.keyframes.length);
  const opacitySlotCount = Math.min(3, asset.opacity.keyframes.length);
  const rotationOffset = 0;
  const colorOffset = rotationOffset + rotationSlotCount * asset.splatCount;
  const scaleOffset = colorOffset + colorSlotCount * asset.splatCount;
  const vectorCount = scaleOffset + scaleSlotCount * asset.splatCount;
  const opacityOffset = 0;
  const lifetimeMuOffset = opacitySlotCount * scalarStride;
  const lifetimeWOffset = lifetimeMuOffset + scalarStride;
  const scalarCount = lifetimeWOffset + scalarStride;
  const positionBytes = positionSlotCount * asset.splatCount * vectorBytes;
  const vectorBytesTotal = vectorCount * vectorBytes;
  const scalarBytesTotal = scalarCount * scalarBytes;
  // #WDD-gpt 2026-08-16 - 显式内存计划供运行时、监控和测试共用，避免关键帧数增加时显存悄然线性膨胀。
  return {
    half,
    vectorBytes,
    scalarBytes,
    scalarStride,
    positionSlotCount,
    rotationSlotCount,
    colorSlotCount,
    scaleSlotCount,
    opacitySlotCount,
    rotationOffset,
    colorOffset,
    scaleOffset,
    opacityOffset,
    lifetimeMuOffset,
    lifetimeWOffset,
    positionBytes,
    vectorBytesTotal,
    scalarBytesTotal,
    totalBytes: positionBytes + vectorBytesTotal + scalarBytesTotal,
  };
}
