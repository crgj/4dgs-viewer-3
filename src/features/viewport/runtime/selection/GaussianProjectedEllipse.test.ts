import { describe, expect, it } from 'vitest';
import { GSPLAT_KERNEL_EXTENT } from '../../../gaussian/runtime/GaussianRenderMode';
import { gaussianProjectedEllipse, projectGaussianAxisToScreen } from './GaussianProjectedEllipse';

describe('GaussianProjectedEllipse', () => {
  it('projects perspective axis differentials into CSS screen pixels', () => {
    const projection = new Float32Array([
      2, 0, 0, 0,
      0, 2, 0, 0,
      0, 0, -1, -1,
      0, 0, -0.2, 0,
    ]);
    const horizontal = projectGaussianAxisToScreen(
      projection,
      { x: 0, y: 0, z: -10 },
      { x: 1, y: 0, z: 0 },
      { width: 1000, height: 500 },
    );
    expect(horizontal?.x).toBeCloseTo(100);
    expect(horizontal?.y).toBeCloseTo(0);
    const vertical = projectGaussianAxisToScreen(
      projection,
      { x: 0, y: 0, z: -10 },
      { x: 0, y: 1, z: 0 },
      { width: 1000, height: 500 },
    );
    expect(vertical?.x).toBeCloseTo(0);
    expect(vertical?.y).toBeCloseTo(-50);
  });

  it('creates orthogonal ellipse axes from the summed projected covariance', () => {
    const ellipse = gaussianProjectedEllipse(20, 30, [
      { x: 4, y: 0 }, { x: 0, y: 2 }, { x: 0, y: 0 },
    ], 100, 0);
    expect(ellipse).not.toBeNull();
    expect(ellipse!.centerX).toBe(20);
    expect(ellipse!.centerY).toBe(30);
    expect(Math.hypot(ellipse!.axis1X, ellipse!.axis1Y))
      .toBeCloseTo(GSPLAT_KERNEL_EXTENT * 4 * Math.sqrt(0.93), 5);
    expect(Math.hypot(ellipse!.axis2X, ellipse!.axis2Y))
      .toBeCloseTo(GSPLAT_KERNEL_EXTENT * 2 * Math.sqrt(0.93), 5);
    expect(ellipse!.axis1X * ellipse!.axis2X + ellipse!.axis1Y * ellipse!.axis2Y).toBeCloseTo(0, 5);
  });
});
