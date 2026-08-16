import { describe, expect, it } from 'vitest';
import { syncRelightingCameraProjection } from './GaussianRelightingController';

describe('GaussianRelightingController projection sync', () => {
  it('copies horizontal FOV and the full projection state to the offscreen camera', () => {
    const source = {
      fov: 48,
      nearClip: 0.01,
      farClip: 200,
      projection: 0,
      horizontalFov: true,
      aspectRatioMode: 1,
      aspectRatio: 1.777,
    };
    const target = {
      fov: 48,
      nearClip: 0.1,
      farClip: 1000,
      projection: 0,
      horizontalFov: false,
      aspectRatioMode: 0,
      aspectRatio: 1,
    };
    syncRelightingCameraProjection(source, target);
    // #WDD-gpt 2026-08-16 - A vertical-FOV proxy camera projects a different mesh footprint in wide viewports and makes splats sample unrelated lighting pixels.
    expect(target).toEqual(source);
  });
});
