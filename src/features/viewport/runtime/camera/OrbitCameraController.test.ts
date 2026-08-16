import { describe, expect, it } from 'vitest';
import { orbitCameraPresetAngles } from './OrbitCameraController';

describe('OrbitCameraController presets', () => {
  it('maps the four ViewCube faces to exact Y-up orbit angles', () => {
    expect(orbitCameraPresetAngles('front')).toEqual({ pitch: 0, yaw: 0 });
    expect(orbitCameraPresetAngles('left')).toEqual({ pitch: 0, yaw: -90 });
    expect(orbitCameraPresetAngles('right')).toEqual({ pitch: 0, yaw: 90 });
    expect(orbitCameraPresetAngles('top')).toEqual({ pitch: 90, yaw: 0 });
  });
});
