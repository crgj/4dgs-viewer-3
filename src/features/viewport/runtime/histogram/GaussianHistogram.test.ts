import { describe, expect, it } from 'vitest';
import { buildGaussianHistogramBins, histogramRangeIds } from './GaussianHistogram';

describe('GaussianHistogram', () => {
  it('counts only eligible finite stable IDs', () => {
    const histogram = buildGaussianHistogramBins([{ values: new Float32Array([0, 1, 2, Number.NaN]), eligible: new Uint8Array([1, 0, 1, 1]) }], 4);
    expect(histogram.count).toBe(2);
    expect(histogram.valueMin).toBe(0);
    expect(histogram.valueMax).toBe(2);
    expect(histogram.bins.reduce((sum, value) => sum + value, 0)).toBe(2);
  });

  it('returns stable IDs inside a dragged range in either direction', () => {
    const values = new Float32Array([0.1, 0.4, 0.8, 1]);
    const eligible = new Uint8Array([1, 0, 1, 1]);
    expect(histogramRangeIds(values, eligible, 0.9, 0.2)).toEqual([2]);
  });
});
