export interface GaussianCylinderSelectionRegion {
  readonly centerX: number;
  readonly centerZ: number;
  readonly radius: number;
  readonly height: number;
  readonly groundPadding: number;
}

export interface GaussianCylinderPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

// #WDD-gpt 2026-08-16 - 圆柱选择参数在进入运行时前统一限值，避免负半径或非有限输入破坏跨帧扫描。
export function normalizeGaussianCylinderRegion(
  region: GaussianCylinderSelectionRegion,
): GaussianCylinderSelectionRegion {
  const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
  return {
    centerX: finite(region.centerX, 0),
    centerZ: finite(region.centerZ, 0),
    radius: Math.max(0.001, finite(region.radius, 1)),
    height: Math.max(0.001, finite(region.height, 2)),
    groundPadding: Math.max(0, finite(region.groundPadding, 0.08)),
  };
}

export function gaussianCylinderContains(
  region: GaussianCylinderSelectionRegion,
  point: GaussianCylinderPoint,
): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) return false;
  const normalized = normalizeGaussianCylinderRegion(region);
  const deltaX = point.x - normalized.centerX;
  const deltaZ = point.z - normalized.centerZ;
  return point.y >= -normalized.groundPadding
    && point.y <= normalized.height
    && deltaX * deltaX + deltaZ * deltaZ <= normalized.radius * normalized.radius;
}
