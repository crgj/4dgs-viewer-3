import { describe, expect, it } from 'vitest';
import { KeyframeSlotCache, keyframeRequirements } from './KeyframeSlotCache';

describe('KeyframeSlotCache', () => {
  it('retains left, right and prefetched keyframes in three slots', () => {
    const uploads: Array<[number, number]> = [];
    const cache = new KeyframeSlotCache(11, 3);
    cache.initialize((slot, key) => uploads.push([slot, key]));
    expect([...cache.slotKeys]).toEqual([0, 1, 2]);
    cache.ensure(keyframeRequirements([0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30], 10), (slot, key) => {
      uploads.push([slot, key]);
    });
    expect(new Set(cache.slotKeys)).toEqual(new Set([3, 4, 5]));
    expect(uploads.length).toBe(6);
  });

  it('pins color key zero while streaming three interpolation keys', () => {
    const cache = new KeyframeSlotCache(8, 4, [0]);
    cache.initialize(() => undefined);
    cache.ensure([4, 5, 6], () => undefined);
    expect(new Set(cache.slotKeys)).toEqual(new Set([0, 4, 5, 6]));
  });
});
