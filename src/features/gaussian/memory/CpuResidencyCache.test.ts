import { describe, expect, it, vi } from 'vitest';
import { CpuResidencyCache } from './CpuResidencyCache';

describe('CpuResidencyCache', () => {
  it('evicts the least-recently-used unpinned page before admitting a new segment', () => {
    const cache = new CpuResidencyCache(100);
    const firstEvicted = vi.fn();
    const first = cache.insert({
      id: 'segment-1', kind: 'compressed', byteSize: 40, value: 1, pinned: false, onEvict: firstEvicted,
    });
    cache.insert({ id: 'segment-2', kind: 'compressed', byteSize: 40, value: 2, pinned: false });
    first.touch();
    cache.insert({ id: 'segment-3', kind: 'decoded', byteSize: 40, value: 3, pinned: false });

    const stats = cache.getStats();
    expect(stats.residentBytes).toBe(80);
    expect(stats.compressedBytes).toBe(40);
    expect(stats.decodedBytes).toBe(40);
    expect(stats.evictionCount).toBe(1);
    expect(firstEvicted).not.toHaveBeenCalled();
  });

  it('never evicts pinned current data and reports a clean budget failure', () => {
    const cache = new CpuResidencyCache(64);
    cache.insert({ id: 'current', kind: 'decoded', byteSize: 64, value: 'current', pinned: true, active: true });

    expect(() => cache.insert({
      id: 'next', kind: 'compressed', byteSize: 1, value: 'next', pinned: false,
    })).toThrow(/CPU memory budget exceeded/);
    expect(cache.getStats()).toMatchObject({
      activeId: 'current',
      residentBytes: 64,
      evictableBytes: 0,
    });
  });

  it('reconciles unpinned pages immediately when the budget is lowered', () => {
    const cache = new CpuResidencyCache(120);
    const first = cache.insert({ id: 'one', kind: 'compressed', byteSize: 40, value: 1, pinned: true });
    cache.insert({ id: 'two', kind: 'decoded', byteSize: 40, value: 2, pinned: false });
    first.unpin();

    cache.setBudget(40);

    expect(cache.getStats()).toMatchObject({
      budgetBytes: 40,
      residentBytes: 40,
      evictionCount: 1,
    });
  });

  it('resizes typed sidecar residency and evicts older unpinned pages first', () => {
    const cache = new CpuResidencyCache(100);
    cache.insert({ id: 'old', kind: 'decoded', byteSize: 30, value: 1 });
    const edits = cache.insert({ id: 'edits', kind: 'decoded', byteSize: 20, value: 2, pinned: true });
    edits.resize(80);
    expect(edits.byteSize).toBe(80);
    expect(cache.getStats()).toMatchObject({ residentBytes: 80, evictionCount: 1 });
  });
});
