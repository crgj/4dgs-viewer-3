import { describe, expect, it } from 'vitest';
import { GaussianSequenceEditStore } from './GaussianSequenceEditStore';

function createSequence(): GaussianSequenceEditStore {
  const sequence = new GaussianSequenceEditStore([
    { id: 'segment-0', pointCount: 4, totalFrames: 3 },
    { id: 'segment-1', pointCount: 3, totalFrames: 2 },
  ]);
  sequence.setActiveSegment(0);
  return sequence;
}

describe('GaussianSequenceEditStore', () => {
  it('preserves independent edit masks while switching active segments', () => {
    const sequence = createSequence();
    sequence.select(0, [1, 3], 'replace');
    sequence.setActiveSegment(1);
    sequence.select(1, [2], 'replace');
    sequence.setActiveSegment(0);

    expect(sequence.segment(0).edits.selectedStableIds()).toEqual([1, 3]);
    expect(sequence.segment(1).edits.selectedStableIds()).toEqual([2]);
    expect(sequence.selectedCount('visible')).toBe(2);
    expect(sequence.selectedCount('global')).toBe(3);
  });

  it('applies invert, clear, and delete to every segment in global scope', () => {
    const sequence = createSequence();
    sequence.segment(0).edits.setDeleted([0]);
    sequence.segment(1).edits.setDeleted([2]);
    expect(sequence.invertSelection('global')).toBe(5);
    expect(sequence.selectedCount('global')).toBe(5);
    expect(sequence.markSelectedDeleted('global')).toBe(5);
    expect(sequence.deletionCount()).toBe(7);
    expect(sequence.selectedCount('global')).toBe(0);

    sequence.segment(0).edits.setDeleted([1], false);
    sequence.invertSelection('global');
    sequence.clearSelection('global');
    expect(sequence.selectedCount('global')).toBe(0);
  });
});
