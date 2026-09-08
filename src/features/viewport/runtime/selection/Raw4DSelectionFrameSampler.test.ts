import { describe, expect, it } from 'vitest';
import type { Raw4DAsset, Raw4DTrack } from '../../../gaussian/formats/raw4d/Raw4DTypes';
import {
  Raw4DFrameSampler,
  Raw4DSortCenterSampler,
} from '../../../gaussian/runtime/Raw4DFrameSampler';
import { Raw4DSelectionFrameSampler } from './Raw4DSelectionFrameSampler';

function track(components: number, values: number[][], keyframes = [0]): Raw4DTrack {
  return {
    components,
    encoding: 'float32',
    keyframes,
    values: values.map((value) => new Float32Array(value)),
  };
}

function testAsset(): Raw4DAsset {
  return {
    sourceName: 'selection-test.raw4d',
    sourceEncoding: 'float32',
    splatCount: 2,
    totalFrames: 3,
    shBands: 0,
    position: track(3, [
      [0, 2], [0, 4], [1, 1],
      [2, 4], [2, 6], [3, 3],
    ], [0, 2]),
    rotation: track(4, [[1, 1], [0, 0], [0, 0], [0, 0]]),
    colorDc: track(3, [[0, 0], [0, 0], [0, 0]]),
    scale: track(3, [[0, 0], [0, 0], [0, 0]]),
    opacity: track(1, [[0, -2], [2, 2]], [0, 2]),
    shRest: [],
    lifetimeMu: new Float32Array([1, 1]),
    lifetimeW: new Float32Array([3, 0.75]),
    bounds: { min: [0, 0, 0], max: [6, 6, 3] },
  };
}

describe('Raw4DSelectionFrameSampler', () => {
  it('matches the renderer sampler for projected position and effective opacity', () => {
    const asset = testAsset();
    const selection = new Raw4DSelectionFrameSampler(asset);
    const renderer = new Raw4DFrameSampler(asset);
    const sortCenters = new Raw4DSortCenterSampler(asset);

    selection.sample(1);
    renderer.sample(1);
    sortCenters.samplePosition(1);

    for (const property of ['x', 'y', 'z', 'opacity'] as const) {
      expect([...selection.properties[property]]).toEqual([...renderer.properties[property]]);
    }
    expect([...sortCenters.centers]).toEqual([
      renderer.properties.x[0], renderer.properties.y[0], renderer.properties.z[0],
      renderer.properties.x[1], renderer.properties.y[1], renderer.properties.z[1],
    ]);
  });

  it('matches per-point lifetime endpoint positions and does not gate baked opacity twice', () => {
    const asset: Raw4DAsset = {
      ...testAsset(),
      position: track(3, [
        [0, 10], [0, 0], [0, 0],
        [4, 14], [0, 0], [0, 0],
      ], [0, 2]),
      opacity: track(1, [[0, 0], [0, 0], [0, 0]], [0, 1, 2]),
      lifetimeMu: new Float32Array([1, 1]),
      lifetimeW: new Float32Array([1, 0.5]),
      positionTiming: 'per-point-lifetime-endpoints',
      opacityTiming: 'baked',
    };
    const selection = new Raw4DSelectionFrameSampler(asset);
    const renderer = new Raw4DFrameSampler(asset);
    const sortCenters = new Raw4DSortCenterSampler(asset);

    selection.sample(1);
    renderer.sample(1);
    sortCenters.samplePosition(1);

    for (const property of ['x', 'y', 'z', 'opacity'] as const) {
      expect([...selection.properties[property]]).toEqual([...renderer.properties[property]]);
    }
    expect([...selection.properties.x]).toEqual([2, 12]);
    expect([...selection.properties.opacity]).toEqual([0.5, 0.5]);
    expect([...sortCenters.centers]).toEqual([2, 0, 0, 12, 0, 0]);
  });
});
