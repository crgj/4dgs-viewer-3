import { describe, expect, it } from 'vitest';
import {
  createSurfacePointIndex,
  fillSmallBoundaryHoles,
  isNearSurface,
  refineDisparities,
} from './GS2MeshGeometryCleanup';

describe('GS2Mesh geometry cleanup', () => {
  it('removes a disparity spike and fills isolated holes without crossing foreground', () => {
    const columns = 9;
    const rows = 9;
    const disparities = new Uint16Array(columns * rows);
    const foreground = new Uint8Array(columns * rows);
    disparities.fill(20);
    foreground.fill(1);
    disparities[4 * columns + 4] = 0;
    disparities[2 * columns + 2] = 70;
    foreground[0] = 0;
    disparities[0] = 0;
    const refined = refineDisparities(disparities, foreground, columns, rows);
    expect(refined[4 * columns + 4]).toBe(20);
    expect(refined[2 * columns + 2]).toBe(20);
    expect(refined[0]).toBe(0);
  });

  it('rejects points away from the current Gaussian surface samples', () => {
    const index = createSurfacePointIndex(Float32Array.from([
      0, 0, 0,
      0.02, 0, 0,
      0, 0.02, 0,
    ]), 1);
    expect(isNearSurface(index, 0.01, 0.01, 0.005)).toBe(true);
    expect(isNearSurface(index, 0.4, 0.4, 0.4)).toBe(false);
  });

  it('fills a small inner boundary while preserving the large outer boundary', () => {
    const positions = [
      -2, -2, 0, 2, -2, 0, 2, 2, 0, -2, 2, 0,
      -0.25, -0.25, 0, 0.25, -0.25, 0, 0.25, 0.25, 0, -0.25, 0.25, 0,
    ];
    const colors = Array.from({ length: 8 }, () => [120, 180, 220, 255]).flat();
    const indices = [
      0, 1, 5, 0, 5, 4,
      1, 2, 6, 1, 6, 5,
      2, 3, 7, 2, 7, 6,
      3, 0, 4, 3, 4, 7,
    ];
    expect(fillSmallBoundaryHoles(positions, colors, indices, 1)).toBe(1);
    expect(positions).toHaveLength(27);
    expect(indices).toHaveLength(36);
  });
});
