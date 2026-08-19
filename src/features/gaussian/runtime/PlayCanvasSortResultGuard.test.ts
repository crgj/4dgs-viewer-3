import { describe, expect, it } from 'vitest';
import {
  canApplyPlayCanvasSortResult,
  isStalePlayCanvasSortResult,
} from './PlayCanvasSortResultGuard';

describe('PlayCanvas CPU sort result guard', () => {
  it('rejects only results older than the newest requested world version', () => {
    expect(isStalePlayCanvasSortResult(4, 5)).toBe(true);
    expect(isStalePlayCanvasSortResult(5, 5)).toBe(false);
    expect(isStalePlayCanvasSortResult(6, 5)).toBe(false);
  });

  it('waits for every queued worker sort before applying the newest result', () => {
    expect(canApplyPlayCanvasSortResult(2)).toBe(false);
    expect(canApplyPlayCanvasSortResult(1)).toBe(false);
    expect(canApplyPlayCanvasSortResult(0)).toBe(true);
  });
});
