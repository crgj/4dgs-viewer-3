import { describe, expect, it } from 'vitest';
import type { Raw4DAsset, Raw4DTrack } from './Raw4DTypes';
import { measureRaw4DAssetBytes } from './Raw4DMemoryMetrics';

function createTrack(values: number[][], keyframes = [0]): Raw4DTrack {
  return {
    encoding: 'float32',
    components: values.length / keyframes.length,
    keyframes,
    values: values.map((value) => new Float32Array(value)),
  };
}

describe('RAW4D memory statistics', () => {
  it('counts owned TypedArray backing-store bytes', () => {
    const asset: Raw4DAsset = {
      sourceName: 'memory.raw4d',
      sourceEncoding: 'float32',
      splatCount: 2,
      totalFrames: 1,
      shBands: 0,
      position: createTrack([[1, 2], [3, 4], [5, 6]]),
      rotation: createTrack([[1, 1], [0, 0], [0, 0], [0, 0]]),
      colorDc: createTrack([[0, 0], [0, 0], [0, 0]]),
      scale: createTrack([[0, 0], [0, 0], [0, 0]]),
      opacity: createTrack([[0, 0]]),
      shRest: [],
      lifetimeMu: new Float32Array(2),
      lifetimeW: new Float32Array(2),
      bounds: { min: [1, 3, 5], max: [2, 4, 6] },
    };

    expect(measureRaw4DAssetBytes(asset)).toBe(16 * 2 * Float32Array.BYTES_PER_ELEMENT);
  });
});
