import { describe, expect, it } from 'vitest';
import {
  easeOrbitCameraTransition,
  orbitCameraPresetAngles,
  shortestOrbitYawDelta,
} from './OrbitCameraController';

describe('OrbitCameraController presets', () => {
  it('maps the four ViewCube faces to exact Y-up orbit angles', () => {
    expect(orbitCameraPresetAngles('front')).toEqual({ pitch: 0, yaw: 0 });
    expect(orbitCameraPresetAngles('left')).toEqual({ pitch: 0, yaw: -90 });
    expect(orbitCameraPresetAngles('right')).toEqual({ pitch: 0, yaw: 90 });
    expect(orbitCameraPresetAngles('top')).toEqual({ pitch: 90, yaw: 0 });
  });

  it('uses the shortest path when a bookmark yaw crosses the 180 degree seam', () => {
    expect(shortestOrbitYawDelta(170, -170)).toBe(20);
    expect(shortestOrbitYawDelta(-170, 170)).toBe(-20);
    expect(shortestOrbitYawDelta(10, 100)).toBe(90);
  });

  it('eases bookmark transitions without overshooting either endpoint', () => {
    expect(easeOrbitCameraTransition(-1)).toBe(0);
    expect(easeOrbitCameraTransition(0.25)).toBeCloseTo(0.0625);
    expect(easeOrbitCameraTransition(0.5)).toBe(0.5);
    expect(easeOrbitCameraTransition(0.75)).toBeCloseTo(0.9375);
    expect(easeOrbitCameraTransition(2)).toBe(1);
  });
});
