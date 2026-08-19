import { describe, expect, it } from 'vitest';
import { GaussianEditStore } from './GaussianEditStore';

describe('GaussianEditStore', () => {
  it('keeps deletion and selection state in stable-ID bitsets', () => {
    const edits = new GaussianEditStore(100, 32);
    expect(edits.byteLength).toBe(32);
    edits.setDeleted([1, 65]);
    edits.select([2, 3]);
    edits.select([3, 4], 'toggle');
    expect(edits.isDeleted(1)).toBe(true);
    expect(edits.isDeleted(65)).toBe(true);
    expect(edits.isSelected(2)).toBe(true);
    expect(edits.isSelected(3)).toBe(false);
    expect(edits.isSelected(4)).toBe(true);
    expect(edits.selectionCount).toBe(2);
    edits.select([], 'replace');
    expect(edits.selectionCount).toBe(0);
  });

  it('stores CPU-only sparse attributes without allocating a value for every point', () => {
    const edits = new GaussianEditStore(1_000_000, 65_536);
    edits.defineAttribute({ name: 'semantic', type: 'u16', sparse: true, residency: 'cpu-only' });
    const before = edits.byteLength;
    edits.setAttribute('semantic', 900_000, 7);
    edits.setAttribute('semantic', 3, 2);
    expect(edits.getAttribute('semantic', 900_000)).toEqual([7]);
    expect(edits.getAttribute('semantic', 3)).toEqual([2]);
    expect(edits.getAttribute('semantic', 4)).toBeNull();
    expect(edits.byteLength - before).toBeLessThan(128);
  });

  it('inverts only undeleted stable IDs for global selection', () => {
    const edits = new GaussianEditStore(6);
    edits.setDeleted([1, 5]);
    edits.select([0, 1, 3]);
    edits.invertUndeletedSelection();
    expect(Array.from({ length: 6 }, (_, stableId) => edits.isSelected(stableId))).toEqual([
      false, false, true, false, true, false,
    ]);
  });

  it('marks selected points for deletion without removing stable-ID storage', () => {
    const edits = new GaussianEditStore(8);
    edits.select([1, 3, 7]);
    expect(edits.selectedStableIds()).toEqual([1, 3, 7]);
    expect(edits.markSelectedDeleted()).toBe(3);
    expect(edits.deletionCount).toBe(3);
    expect(edits.selectionCount).toBe(0);
    expect(edits.pointCount).toBe(8);
    expect([1, 3, 7].every((stableId) => edits.isDeleted(stableId))).toBe(true);
  });

  it('round-trips workspace selection and soft-deletion bitsets', () => {
    const source = new GaussianEditStore(70);
    source.setDeleted([0, 31, 32, 69]);
    source.select([2, 34, 68]);
    const restored = new GaussianEditStore(70);
    restored.restoreBitsets(source.snapshotBitsets());
    expect(restored.deletionCount).toBe(4);
    expect(restored.selectedStableIds()).toEqual([2, 34, 68]);
    expect(restored.isDeleted(69)).toBe(true);
  });

  it('validates stable IDs and attribute component counts', () => {
    const edits = new GaussianEditStore(4);
    edits.defineAttribute({ name: 'normal', type: 'f32', components: 3 });
    expect(() => edits.setAttribute('normal', 1, [1, 2])).toThrow(/requires 3/);
    expect(() => edits.setDeleted([4])).toThrow(RangeError);
  });
});
