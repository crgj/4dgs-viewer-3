import { describe, expect, it } from 'vitest';
import { chooseRaw4DGpuEviction } from './Raw4DGpuResidencyPolicy';

const order = ['s0', 's1', 's2', 's3', 's4', 's5'];
const candidates = order.map((residentId, lastUsed) => ({ residentId, lastUsed }));

describe('Raw4DGpuResidencyPolicy', () => {
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
