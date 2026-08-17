import { describe, expect, it } from 'vitest';
import { parseRaw4D, readRaw4DHeader } from './Raw4DParser';
import { exportCompactedRaw4D, exportCompactedRaw4DSource } from './Raw4DExporter';
import type { Raw4DAsset, Raw4DTrack } from './Raw4DTypes';

const values = (input: readonly number[]) => Float32Array.from(input);
const track = (components: number, banks: readonly (readonly number[])[]): Raw4DTrack => ({
  encoding: 'float32',
  components,
  keyframes: [0, 2],
  values: banks.map(values),
});

function fixture(): Raw4DAsset {
  const ids = [0, 1, 2, 3];
  return {
    sourceName: 'fixture.raw4d', sourceEncoding: 'float32', splatCount: 4, totalFrames: 3, shBands: 0,
    position: track(3, Array.from({ length: 6 }, (_, index) => ids.map((id) => id * 10 + index))),
    rotation: track(4, Array.from({ length: 8 }, (_, index) => ids.map((id) => id * 10 + index))),
    colorDc: track(3, Array.from({ length: 6 }, (_, index) => ids.map((id) => id * 10 + index))),
    scale: track(3, Array.from({ length: 6 }, (_, index) => ids.map((id) => id * 10 + index))),
    opacity: track(1, Array.from({ length: 2 }, (_, index) => ids.map((id) => id * 10 + index))),
    shRest: [], lifetimeMu: values(ids.map((id) => id + 0.25)), lifetimeW: values(ids.map((id) => id + 1)),
    bounds: { min: [0, 0, 0], max: [35, 36, 37] },
  };
}

describe('Raw4DExporter', () => {
  it('physically removes marked stable IDs while preserving remaining property rows', async () => {
    const deletionWords = new Uint32Array(1);
    deletionWords[0] = (1 << 1) | (1 << 3);
    const blob = await exportCompactedRaw4D(fixture(), deletionWords, { chunkRows: 256 });
    const header = await readRaw4DHeader(blob);
    const decoded = await parseRaw4D(blob, { sourceName: 'compacted.raw4d' });
    expect(header.propertyNames.slice(0, 15)).toEqual([
      'x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2',
      'opacity', 'scale_0', 'scale_1', 'scale_2', 'lifetime_mu', 'lifetime_w',
    ]);
    expect(header.propertyNames).toHaveLength(43);
    expect(decoded.splatCount).toBe(2);
    expect(Array.from(decoded.lifetimeMu)).toEqual([0.25, 2.25]);
    expect(Array.from(decoded.position.values[0])).toEqual([0, 20]);
    expect(Array.from(decoded.opacity.values[1])).toEqual([1, 21]);
  });

  it('compacts source records without rewriting the original property layout', async () => {
    const source = await exportCompactedRaw4D(fixture(), new Uint32Array(1));
    const deletionWords = new Uint32Array(1);
    deletionWords[0] = 1 << 1;
    const compacted = await exportCompactedRaw4DSource(source, deletionWords);
    const decoded = await parseRaw4D(compacted);
    expect(decoded.splatCount).toBe(3);
    expect(Array.from(decoded.lifetimeMu)).toEqual([0.25, 2.25, 3.25]);
  });
});
