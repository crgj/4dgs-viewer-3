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
  intersectsEllipse(ellipse: GaussianScreenEllipse): boolean;
}

export interface GaussianScreenEllipse {
  readonly centerX: number;
  readonly centerY: number;
  readonly axis1X: number;
  readonly axis1Y: number;
  readonly axis2X: number;
  readonly axis2Y: number;
}

export interface GaussianSelectionModifiers {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

// #WDD-gpt 2026-09-20 - 选择工具只占用鼠标左键，中键和右键始终保留给相机旋转与平移。
export function isGaussianSelectionPointerButton(button: number): boolean {
  return button === 0;
}

// #WDD-gpt 2026-09-20 - 左侧 Ctrl/Cmd 在选择工具中提供持续的增选模式与光标反馈，右侧修饰键保留原有事件兼容语义。
export function isGaussianSelectionAddFeedbackKey(code: string): boolean {
  return code === 'ControlLeft' || code === 'MetaLeft';
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

function gaussianScreenEllipseBounds(ellipse: GaussianScreenEllipse): GaussianScreenSelectionRect {
  const extentX = Math.hypot(ellipse.axis1X, ellipse.axis2X);
  const extentY = Math.hypot(ellipse.axis1Y, ellipse.axis2Y);
  return {
    left: ellipse.centerX - extentX,
    right: ellipse.centerX + extentX,
    top: ellipse.centerY - extentY,
    bottom: ellipse.centerY + extentY,
  };
}

function screenRectsIntersect(left: GaussianScreenSelectionRect, right: GaussianScreenSelectionRect): boolean {
  return left.left <= right.right && left.right >= right.left
    && left.top <= right.bottom && left.bottom >= right.top;
}

// #WDD-gpt 2026-09-20 - 将屏幕点变换到椭圆单位圆空间，统一矩形、折线与刷子相交测试。
export function gaussianScreenEllipseContains(ellipse: GaussianScreenEllipse, x: number, y: number): boolean {
  const determinant = ellipse.axis1X * ellipse.axis2Y - ellipse.axis1Y * ellipse.axis2X;
  if (Math.abs(determinant) < 1e-8) return false;
  const dx = x - ellipse.centerX;
  const dy = y - ellipse.centerY;
  const u = (dx * ellipse.axis2Y - dy * ellipse.axis2X) / determinant;
  const v = (ellipse.axis1X * dy - ellipse.axis1Y * dx) / determinant;
  return u * u + v * v <= 1 + 1e-6;
}

function ellipseUnitPoint(ellipse: GaussianScreenEllipse, point: GaussianScreenPoint): GaussianScreenPoint | null {
  const determinant = ellipse.axis1X * ellipse.axis2Y - ellipse.axis1Y * ellipse.axis2X;
  if (Math.abs(determinant) < 1e-8) return null;
  const dx = point.x - ellipse.centerX;
  const dy = point.y - ellipse.centerY;
  return {
    x: (dx * ellipse.axis2Y - dy * ellipse.axis2X) / determinant,
    y: (ellipse.axis1X * dy - ellipse.axis1Y * dx) / determinant,
  };
}

function segmentIntersectsGaussianScreenEllipse(
  ellipse: GaussianScreenEllipse,
  start: GaussianScreenPoint,
  end: GaussianScreenPoint,
): boolean {
  const unitStart = ellipseUnitPoint(ellipse, start);
  const unitEnd = ellipseUnitPoint(ellipse, end);
  if (!unitStart || !unitEnd) return false;
  const dx = unitEnd.x - unitStart.x;
  const dy = unitEnd.y - unitStart.y;
  const lengthSquared = dx * dx + dy * dy;
  const alpha = lengthSquared > 1e-12
    ? Math.max(0, Math.min(1, -(unitStart.x * dx + unitStart.y * dy) / lengthSquared))
    : 0;
  const closestX = unitStart.x + dx * alpha;
  const closestY = unitStart.y + dy * alpha;
  return closestX * closestX + closestY * closestY <= 1 + 1e-6;
}

function ellipseIntersectsPolygon(
  ellipse: GaussianScreenEllipse,
  polygon: readonly GaussianScreenPoint[],
  containsCenter: boolean,
): boolean {
  if (containsCenter) return true;
  for (const point of polygon) {
    if (gaussianScreenEllipseContains(ellipse, point.x, point.y)) return true;
  }
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    if (segmentIntersectsGaussianScreenEllipse(ellipse, polygon[previous], polygon[index])) return true;
  }
  return false;
}

// #WDD-gpt 2026-08-27 - 统一选择修饰键：Ctrl/Cmd 增选，Shift 去除；Shift 优先保证组合按键不会误增选。
export function gaussianSelectionModeFromModifiers(modifiers: GaussianSelectionModifiers): GaussianSelectionMode {
  if (modifiers.shiftKey || modifiers.altKey) return 'remove';
  if (modifiers.ctrlKey || modifiers.metaKey) return 'add';
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
  const corners = [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom },
  ];
  return {
    bounds: rect,
    contains: (x, y) => gaussianSelectionRectContains(rect, x, y),
    intersectsEllipse: (ellipse) => screenRectsIntersect(rect, gaussianScreenEllipseBounds(ellipse))
      && ellipseIntersectsPolygon(
        ellipse,
        corners,
        gaussianSelectionRectContains(rect, ellipse.centerX, ellipse.centerY),
      ),
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

export interface GaussianBrushScreenMetrics {
  readonly radius: number;
  readonly diameter: number;
  readonly visibleDiameter: number;
}

// #WDD-gpt 2026-08-17 - 命中区域、圆形光标和 SVG 笔迹共用同一组 CSS 像素尺寸，防止视觉半径与实际选择半径分叉。
export function gaussianBrushScreenMetrics(requestedRadius: number): GaussianBrushScreenMetrics {
  const radius = Math.max(2, requestedRadius);
  const diameter = radius * 2;
  // #WDD-gpt 2026-08-17 - 圆圈光标 CSS 有 1px 向外扩展环；SVG 痕迹必须覆盖相同可见外径，不能只匹配元素盒尺寸。
  const visibleDiameter = diameter + 2;
  return { radius, diameter, visibleDiameter };
}

// #WDD-gpt  2026-08-16 - Brush 路径按半径建立屏幕网格，跨帧命中时只查询邻近桶，避免点数乘笔迹长度的扫描开销。
export function createGaussianBrushSelectionRegion(
  path: readonly GaussianScreenPoint[],
  requestedRadius: number,
): GaussianScreenSelectionRegion {
  const { radius } = gaussianBrushScreenMetrics(requestedRadius);
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
  const contains = (x: number, y: number) => {
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
  };
  return {
    bounds,
    contains,
    intersectsEllipse: (ellipse) => {
      if (!screenRectsIntersect(bounds, gaussianScreenEllipseBounds(ellipse))) return false;
      if (contains(ellipse.centerX, ellipse.centerY)) return true;
      for (const point of samples) {
        if (gaussianScreenEllipseContains(ellipse, point.x, point.y)) return true;
      }
      // #WDD-gpt 2026-09-20 - 大椭圆擦过笔刷时采样其外轮廓，补足仅检查中心线会漏掉的边界相交。
      for (let index = 0; index < 32; index += 1) {
        const angle = index / 32 * Math.PI * 2;
        const cosine = Math.cos(angle);
        const sine = Math.sin(angle);
        if (contains(
          ellipse.centerX + ellipse.axis1X * cosine + ellipse.axis2X * sine,
          ellipse.centerY + ellipse.axis1Y * cosine + ellipse.axis2Y * sine,
        )) return true;
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
  const contains = (x: number, y: number) => {
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
  };
  return {
    bounds,
    contains,
    intersectsEllipse: (ellipse) => polygon.length >= 3
      && screenRectsIntersect(bounds, gaussianScreenEllipseBounds(ellipse))
      && ellipseIntersectsPolygon(ellipse, polygon, contains(ellipse.centerX, ellipse.centerY)),
  };
}
