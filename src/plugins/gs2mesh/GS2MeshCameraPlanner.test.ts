import { describe, expect, it } from 'vitest';
import {
  estimateGS2MeshFocus,
  perspectiveIntrinsics,
  rotateGS2MeshOffset,
} from './GS2MeshCameraPlanner';

describe('GS2MeshCameraPlanner', () => {
  it('chooses the median Gaussian depth nearest the center ray', () => {
    const points = [
      [0.01, 0, -2],
      [-0.01, 0, -3],
      [0, 0.01, -4],
      [4, 0, -1],
    ] as const;
    const result = estimateGS2MeshFocus([0, 0, 0], [0, 0, -1], points, [0, 0, -8]);
    expect(result.focus[2]).toBeCloseTo(-2.5);
    expect(result.supportingPoints).toBe(4);
  });

  it('rotates later cameras around the selected focus', () => {
    const rotated = rotateGS2MeshOffset([0, 0, 5], [0, 1, 0], Math.PI / 2);
    expect(rotated[0]).toBeCloseTo(5);
    expect(rotated[1]).toBeCloseTo(0);
    expect(rotated[2]).toBeCloseTo(0);
  });

  it('derives square-pixel intrinsics from the active camera FOV', () => {
    const intrinsics = perspectiveIntrinsics(640, 360, 90, true);
    expect(intrinsics.fx).toBeCloseTo(320);
    expect(intrinsics.fy).toBeCloseTo(320);
    expect(intrinsics.cx).toBe(320);
    expect(intrinsics.cy).toBe(180);
  });
});
