import type { GaussianSelectionMode } from '../../../gaussian/edit/GaussianEditStore';

export type GaussianScreenSelectionScope = 'visible' | 'global';

export interface GaussianScreenSelectionRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface GaussianScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface GaussianScreenSelectionRegion {
  readonly bounds: GaussianScreenSelectionRect;
  contains(x: number, y: number): boolean;
}

export interface GaussianSelectionModifiers {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

// #WDD-gpt  2026-08-16 - 屏幕选区统一归一化，允许用户从任意方向拖拽矩形。
export function normalizeGaussianSelectionRect(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  minimumSize = 4,
): GaussianScreenSelectionRect {
  const half = Math.max(0, minimumSize) * 0.5;
  const left = Math.min(startX, endX);
  const right = Math.max(startX, endX);
  const top = Math.min(startY, endY);
  const bottom = Math.max(startY, endY);
  return {
    left: right - left < minimumSize ? (left + right) * 0.5 - half : left,
    right: right - left < minimumSize ? (left + right) * 0.5 + half : right,
    top: bottom - top < minimumSize ? (top + bottom) * 0.5 - half : top,
    bottom: bottom - top < minimumSize ? (top + bottom) * 0.5 + half : bottom,
  };
}

export function gaussianSelectionRectContains(
  rect: GaussianScreenSelectionRect,
  x: number,
  y: number,
): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

// #WDD-gpt  2026-08-16 - 沿用常见编辑器修饰键：Shift 添加、Alt 减去、Ctrl/Cmd 切换。
export function gaussianSelectionModeFromModifiers(modifiers: GaussianSelectionModifiers): GaussianSelectionMode {
  if (modifiers.altKey) return 'remove';
  if (modifiers.ctrlKey || modifiers.metaKey) return 'toggle';
  if (modifiers.shiftKey) return 'add';
  return 'replace';
}

export function gaussianSelectionIdsFromMask(mask: Uint8Array): number[] {
  const ids: number[] = [];
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index]) ids.push(index);
  }
  return ids;
}

export function createGaussianRectSelectionRegion(
  rect: GaussianScreenSelectionRect,
): GaussianScreenSelectionRegion {
  return {
    bounds: rect,
    contains: (x, y) => gaussianSelectionRectContains(rect, x, y),
  };
}

function pointsBounds(points: readonly GaussianScreenPoint[], padding = 0): GaussianScreenSelectionRect {
  if (points.length === 0) return { left: 0, top: 0, right: 0, bottom: 0 };
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  return { left: left - padding, top: top - padding, right: right + padding, bottom: bottom + padding };
}

function resampleBrushPath(points: readonly GaussianScreenPoint[], spacing: number): GaussianScreenPoint[] {
  if (points.length <= 1) return [...points];
  const samples: GaussianScreenPoint[] = [{ ...points[0] }];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const distance = Math.hypot(current.x - previous.x, current.y - previous.y);
    const steps = Math.max(1, Math.ceil(distance / spacing));
    for (let step = 1; step <= steps; step += 1) {
      const alpha = step / steps;
      samples.push({
        x: previous.x + (current.x - previous.x) * alpha,
        y: previous.y + (current.y - previous.y) * alpha,
      });
    }
  }
  return samples;
}

// #WDD-gpt  2026-08-16 - Brush 路径按半径建立屏幕网格，跨帧命中时只查询邻近桶，避免点数乘笔迹长度的扫描开销。
export function createGaussianBrushSelectionRegion(
  path: readonly GaussianScreenPoint[],
  requestedRadius: number,
): GaussianScreenSelectionRegion {
  const radius = Math.max(2, requestedRadius);
  const samples = resampleBrushPath(path, Math.max(2, radius * 0.4));
  const bounds = pointsBounds(samples, radius);
  const buckets = new Map<string, GaussianScreenPoint[]>();
  for (const point of samples) {
    const key = `${Math.floor(point.x / radius)},${Math.floor(point.y / radius)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(point);
    else buckets.set(key, [point]);
  }
  const radiusSquared = radius * radius;
  return {
    bounds,
    contains: (x, y) => {
      if (!gaussianSelectionRectContains(bounds, x, y)) return false;
      const column = Math.floor(x / radius);
      const row = Math.floor(y / radius);
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const bucket = buckets.get(`${column + offsetX},${row + offsetY}`);
          if (!bucket) continue;
          for (const point of bucket) {
            const deltaX = x - point.x;
            const deltaY = y - point.y;
            if (deltaX * deltaX + deltaY * deltaY <= radiusSquared) return true;
          }
        }
      }
      return false;
    },
  };
}

function pointNearSegment(
  x: number,
  y: number,
  start: GaussianScreenPoint,
  end: GaussianScreenPoint,
  tolerance = 0.75,
): boolean {
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const lengthSquared = segmentX * segmentX + segmentY * segmentY;
  const alpha = lengthSquared > 0
    ? Math.max(0, Math.min(1, ((x - start.x) * segmentX + (y - start.y) * segmentY) / lengthSquared))
    : 0;
  return Math.hypot(x - (start.x + segmentX * alpha), y - (start.y + segmentY * alpha)) <= tolerance;
}

export function createGaussianPolygonSelectionRegion(
  points: readonly GaussianScreenPoint[],
): GaussianScreenSelectionRegion {
  const polygon = [...points];
  const bounds = pointsBounds(polygon);
  return {
    bounds,
    contains: (x, y) => {
      if (polygon.length < 3 || !gaussianSelectionRectContains(bounds, x, y)) return false;
      let inside = false;
      for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
        const currentPoint = polygon[index];
        const previousPoint = polygon[previous];
        if (pointNearSegment(x, y, previousPoint, currentPoint)) return true;
        const crosses = (currentPoint.y > y) !== (previousPoint.y > y)
          && x < (previousPoint.x - currentPoint.x) * (y - currentPoint.y)
            / (previousPoint.y - currentPoint.y) + currentPoint.x;
        if (crosses) inside = !inside;
      }
      return inside;
    },
  };
}
