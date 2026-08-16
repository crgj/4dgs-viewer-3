import { describe, expect, it } from 'vitest';
import {
  gaussianCylinderContains,
  normalizeGaussianCylinderRegion,
} from './GaussianCylinderSelection';

describe('GaussianCylinderSelection', () => {
  it('accepts the cylinder boundary and ground padding', () => {
    const region = { centerX: 1, centerZ: -2, radius: 2, height: 3, groundPadding: 0.25 };
    expect(gaussianCylinderContains(region, { x: 3, y: 3, z: -2 })).toBe(true);
    expect(gaussianCylinderContains(region, { x: 1, y: -0.25, z: -2 })).toBe(true);
    expect(gaussianCylinderContains(region, { x: 3.01, y: 1, z: -2 })).toBe(false);
    expect(gaussianCylinderContains(region, { x: 1, y: -0.251, z: -2 })).toBe(false);
  });

  it('normalizes unsafe input without admitting non-finite points', () => {
    expect(normalizeGaussianCylinderRegion({
      centerX: Number.NaN, centerZ: Number.POSITIVE_INFINITY,
      radius: -4, height: 0, groundPadding: -1,
    })).toEqual({ centerX: 0, centerZ: 0, radius: 0.001, height: 0.001, groundPadding: 0 });
    expect(gaussianCylinderContains(
      { centerX: 0, centerZ: 0, radius: 1, height: 1, groundPadding: 0 },
      { x: Number.NaN, y: 0, z: 0 },
    )).toBe(false);
  });
});
