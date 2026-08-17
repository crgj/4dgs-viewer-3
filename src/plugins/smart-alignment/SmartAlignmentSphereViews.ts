import type { SmartAlignmentVector3, SmartAlignmentViewId } from './SmartAlignmentTypes';

export const SMART_ALIGNMENT_SPHERE_VIEW_COUNT = 24;

export const SMART_ALIGNMENT_SPHERE_VIEW_IDS: readonly SmartAlignmentViewId[] = Array.from(
  { length: SMART_ALIGNMENT_SPHERE_VIEW_COUNT },
  (_, index) => `sphere-${String(index).padStart(3, '0')}` as SmartAlignmentViewId,
);

const GOLDEN_ANGLE_RADIANS = Math.PI * (3 - Math.sqrt(5));

// #WDD-gpt 2026-08-17 - 用 Fibonacci 球面均匀采样替代单一水平环绕圈，机位同时覆盖人物上方、侧面和下方且避开极点重复。
export function smartAlignmentSphereDirection(
  viewId: SmartAlignmentViewId,
  azimuthOffsetRadians: number,
): SmartAlignmentVector3 | null {
  const match = /^sphere-(\d{3})$/.exec(viewId);
  if (!match) return null;
  const index = Number(match[1]);
  if (!Number.isInteger(index) || index < 0 || index >= SMART_ALIGNMENT_SPHERE_VIEW_COUNT) {
    return null;
  }
  const y = 1 - (2 * (index + 0.5)) / SMART_ALIGNMENT_SPHERE_VIEW_COUNT;
  const horizontalRadius = Math.sqrt(Math.max(0, 1 - y * y));
  const azimuth = azimuthOffsetRadians + index * GOLDEN_ANGLE_RADIANS;
  return [
    Math.cos(azimuth) * horizontalRadius,
    y,
    Math.sin(azimuth) * horizontalRadius,
  ];
}
