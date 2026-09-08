import { describe, expect, it } from 'vitest';
import {
  chooseRaw4DGpuEviction,
  planRaw4DGpuPreload,
  raw4DGpuWindowContains,
} from './Raw4DGpuResidencyPolicy';

const order = ['s0', 's1', 's2', 's3', 's4', 's5'];
const candidates = order.map((residentId, lastUsed) => ({ residentId, lastUsed }));

describe('Raw4DGpuResidencyPolicy', () => {
  it('allows a complete preload only when every segment fits together', () => {
    expect(planRaw4DGpuPreload([120, 180, 200], 500)).toEqual({
      budgetBytes: 500, fits: true, requiredBytes: 500,
    });
    expect(planRaw4DGpuPreload([120, 180, 201], 500)).toEqual({
      budgetBytes: 500, fits: false, requiredBytes: 501,
    });
  });

  it('normalizes invalid estimates instead of granting an unbounded preload', () => {
    expect(planRaw4DGpuPreload([100, Number.NaN, -5], Number.POSITIVE_INFINITY)).toEqual({
      budgetBytes: 0, fits: false, requiredBytes: 100,
    });
  });

  it('bounds a long-sequence cache to the active segment and requested lookahead', () => {
    expect(order.filter((_residentId, index) => raw4DGpuWindowContains(index, 2, 1)))
      .toEqual(['s2', 's3']);
    expect(order.every((_residentId, index) => raw4DGpuWindowContains(index, 2, Number.POSITIVE_INFINITY)))
      .toBe(true);
  });

  it('prefetch only releases the farthest segment that has already played', () => {
    expect(chooseRaw4DGpuEviction({
      candidates, order, activeId: 's2', activeIndex: 2, targetIndex: 4, allowActiveEviction: false,
    })).toBe('s0');
  });

  it('on-demand activation may release the old active segment after older history', () => {
    expect(chooseRaw4DGpuEviction({
      candidates: candidates.slice(2, 5), order, activeId: 's3', activeIndex: 3,
      targetIndex: 5, allowActiveEviction: true,
    })).toBe('s2');
  });

  it('a lowered budget preserves the current segment and drops the farthest future segment', () => {
    expect(chooseRaw4DGpuEviction({
      candidates, order, activeId: 's0', activeIndex: 0, targetIndex: 0, allowActiveEviction: true,
    })).toBe('s5');
  });
});
