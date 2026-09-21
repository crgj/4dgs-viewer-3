import type { GaussianScreenEllipse, GaussianScreenPoint } from './GaussianScreenSelection';
import { GSPLAT_KERNEL_EXTENT } from '../../../gaussian/runtime/GaussianRenderMode';

export interface GaussianProjectionPoint3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface GaussianScreenProjectionViewport {
  readonly height: number;
  readonly width: number;
  readonly rectHeight?: number;
  readonly rectWidth?: number;
}

// #WDD-gpt 2026-09-20 - 使用投影矩阵解析导数把世界协方差轴映射到 CSS 屏幕坐标，避免为每个高斯额外调用六次 worldToScreen。
export function projectGaussianAxisToScreen(
  projection: ArrayLike<number>,
  viewCenter: GaussianProjectionPoint3,
  viewAxis: GaussianProjectionPoint3,
  viewport: GaussianScreenProjectionViewport,
  result: { x: number; y: number } = { x: 0, y: 0 },
): GaussianScreenPoint | null {
  const clipX = viewCenter.x * projection[0] + viewCenter.y * projection[4]
    + viewCenter.z * projection[8] + projection[12];
  const clipY = viewCenter.x * projection[1] + viewCenter.y * projection[5]
    + viewCenter.z * projection[9] + projection[13];
  const clipW = viewCenter.x * projection[3] + viewCenter.y * projection[7]
    + viewCenter.z * projection[11] + projection[15];
  if (!Number.isFinite(clipW) || Math.abs(clipW) < 1e-8) return null;
  const axisClipX = viewAxis.x * projection[0] + viewAxis.y * projection[4] + viewAxis.z * projection[8];
  const axisClipY = viewAxis.x * projection[1] + viewAxis.y * projection[5] + viewAxis.z * projection[9];
  const axisClipW = viewAxis.x * projection[3] + viewAxis.y * projection[7] + viewAxis.z * projection[11];
  const inverseW2 = 1 / (clipW * clipW);
  const rectWidth = viewport.rectWidth ?? 1;
  const rectHeight = viewport.rectHeight ?? 1;
  const x = (axisClipX * clipW - clipX * axisClipW) * inverseW2 * viewport.width * rectWidth * 0.5;
  const y = -(axisClipY * clipW - clipY * axisClipW) * inverseW2 * viewport.height * rectHeight * 0.5;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  result.x = x;
  result.y = y;
  return result;
}

// #WDD-gpt 2026-09-20 - 复现当前 gsplat 核的协方差特征轴与椭圆显示外缘，供椭圆渲染模式执行投影足迹相交选择。
export function gaussianProjectedEllipse(
  centerX: number,
  centerY: number,
  projectedAxes: readonly GaussianScreenPoint[],
  maximumAxis: number,
  antialiasVariance = 0.3,
  result: {
    centerX: number; centerY: number;
    axis1X: number; axis1Y: number; axis2X: number; axis2Y: number;
  } = { centerX: 0, centerY: 0, axis1X: 0, axis1Y: 0, axis2X: 0, axis2Y: 0 },
): GaussianScreenEllipse | null {
  if (projectedAxes.length !== 3) return null;
  let covarianceXX = antialiasVariance;
  let covarianceXY = 0;
  let covarianceYY = antialiasVariance;
  for (const axis of projectedAxes) {
    covarianceXX += axis.x * axis.x;
    covarianceXY += axis.x * axis.y;
    covarianceYY += axis.y * axis.y;
  }
  if (![centerX, centerY, covarianceXX, covarianceXY, covarianceYY].every(Number.isFinite)) return null;
  const midpoint = 0.5 * (covarianceXX + covarianceYY);
  const radius = Math.hypot((covarianceXX - covarianceYY) * 0.5, covarianceXY);
  const lambda1 = Math.max(0.1, midpoint + radius);
  const lambda2 = Math.max(0.1, midpoint - radius);
  let directionX = covarianceXY;
  let directionY = lambda1 - covarianceXX;
  const directionLength = Math.hypot(directionX, directionY);
  if (directionLength < 1e-8) {
    directionX = covarianceXX >= covarianceYY ? 1 : 0;
    directionY = covarianceXX >= covarianceYY ? 0 : 1;
  } else {
    directionX /= directionLength;
    directionY /= directionLength;
  }
  const outerRing = Math.sqrt(0.93);
  const axis1Length = GSPLAT_KERNEL_EXTENT * Math.min(Math.sqrt(lambda1), maximumAxis) * outerRing;
  const axis2Length = GSPLAT_KERNEL_EXTENT * Math.min(Math.sqrt(lambda2), maximumAxis) * outerRing;
  result.centerX = centerX;
  result.centerY = centerY;
  result.axis1X = directionX * axis1Length;
  result.axis1Y = directionY * axis1Length;
  result.axis2X = directionY * axis2Length;
  result.axis2Y = -directionX * axis2Length;
  return result;
}
