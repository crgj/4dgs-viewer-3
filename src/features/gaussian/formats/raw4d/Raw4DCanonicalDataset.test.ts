import { describe, expect, it } from 'vitest';
import type { Raw4DAsset, Raw4DScalarEncoding, Raw4DTrack } from './Raw4DTypes';
import { Raw4DCanonicalDataset } from './Raw4DCanonicalDataset';

function track(
  pointCount: number,
  components: number,
  keyCount: number,
  encoding: Raw4DScalarEncoding,
): Raw4DTrack {
  const ArrayType = encoding === 'float16' ? Uint16Array : Float32Array;
  const backing = new ArrayType(pointCount * components * keyCount);
  return {
    encoding,
    components,
    keyframes: Array.from({ length: keyCount }, (_, index) => index),
    values: Array.from({ length: components * keyCount }, (_, index) => (
      backing.subarray(index * pointCount, (index + 1) * pointCount)
    )),
  };
}

function asset(pointCount = 10, encoding: Raw4DScalarEncoding = 'float16'): Raw4DAsset {
  const scalar = encoding === 'float16' ? new Uint16Array(pointCount) : new Float32Array(pointCount);
  return {
    sourceName: 'test.raw4d', sourceEncoding: encoding, splatCount: pointCount, totalFrames: 3, shBands: 0,
    position: track(pointCount, 3, 2, encoding), rotation: track(pointCount, 4, 2, encoding),
    colorDc: track(pointCount, 3, 2, encoding), scale: track(pointCount, 3, 2, encoding),
    opacity: track(pointCount, 1, 2, encoding), shRest: [], lifetimeMu: scalar, lifetimeW: scalar,
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  };
}

describe('Raw4DCanonicalDataset', () => {
  it('exposes source-width point pages and stable IDs without copying', async () => {
    const source = asset();
    const canonical = new Raw4DCanonicalDataset(source, 4);
    const page = await canonical.tracks.get('position')!.getPage(1, 2);
    expect(page.encoding).toBe('float16');
    expect(page.pointCount).toBe(2);
    expect(page.values[0]).toBeInstanceOf(Uint16Array);
    expect(page.values[0].buffer).toBe(source.position.values[3].buffer);
    expect(canonical.stableId(2, 1)).toBe(9);
    expect(canonical.locate(9)).toEqual({ pageIndex: 2, localIndex: 1 });
  });
});
