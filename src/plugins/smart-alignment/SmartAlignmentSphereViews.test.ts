import { describe, expect, it } from 'vitest';
import {
  SMART_ALIGNMENT_SPHERE_VIEW_COUNT,
  SMART_ALIGNMENT_SPHERE_VIEW_IDS,
  smartAlignmentSphereDirection,
} from './SmartAlignmentSphereViews';

describe('SmartAlignmentSphereViews', () => {
  it('creates 24 unique full-sphere camera directions', () => {
    const directions = SMART_ALIGNMENT_SPHERE_VIEW_IDS.map((viewId) => (
      smartAlignmentSphereDirection(viewId, 0)
    ));
    expect(directions).toHaveLength(SMART_ALIGNMENT_SPHERE_VIEW_COUNT);
    expect(new Set(SMART_ALIGNMENT_SPHERE_VIEW_IDS).size).toBe(SMART_ALIGNMENT_SPHERE_VIEW_COUNT);
    expect(directions.every((direction) => direction !== null)).toBe(true);
    const resolved = directions.filter((direction): direction is NonNullable<typeof direction> => (
      direction !== null
    ));
    for (const direction of resolved) {
      expect(Math.hypot(...direction)).toBeCloseTo(1, 12);
    }
    expect(Math.max(...resolved.map((direction) => direction[1]))).toBeGreaterThan(0.9);
    expect(Math.min(...resolved.map((direction) => direction[1]))).toBeLessThan(-0.9);
    const octants = new Set(resolved.map(([x, y, z]) => (
      `${x >= 0 ? '+' : '-'}${y >= 0 ? '+' : '-'}${z >= 0 ? '+' : '-'}`
    )));
    expect(octants.size).toBe(8);
  });

  it('rejects out-of-range spherical view identifiers', () => {
    expect(smartAlignmentSphereDirection('sphere-024', 0)).toBeNull();
  });
});
