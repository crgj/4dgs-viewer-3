import { describe, expect, it } from 'vitest';
import { fourCgsPartFilename, partitionConsecutiveSegments } from './fourCgsExportPartitions';

describe('4CGS consecutive output partitions', () => {
  // #WDD-gpt 2026-09-20 - 锁定非整除时前部分多一段，且所有原片段恰好出现一次。
  it('balances ordered segments without splitting or duplication', () => {
    expect(partitionConsecutiveSegments([0, 1, 2, 3, 4], 2)).toEqual([[0, 1, 2], [3, 4]]);
    expect(partitionConsecutiveSegments([0, 1, 2], 3)).toEqual([[0], [1], [2]]);
  });

  it('rejects more parts than source segments and names parts deterministically', () => {
    expect(() => partitionConsecutiveSegments([0, 1], 3)).toThrow(/3.*2/);
    expect(fourCgsPartFilename('dance', 0, 3)).toBe('dance.part-01-of-03.4cgs');
    expect(fourCgsPartFilename('dance', 0, 1)).toBe('dance.4cgs');
  });
});
