import { describe, expect, it, vi } from 'vitest';
import {
  cancelPlayCanvasAtomicWorkBufferCommit,
  canApplyPlayCanvasSortResult,
  consumePlayCanvasAtomicWorkBufferCommit,
  isStalePlayCanvasSortResult,
  registerPlayCanvasAtomicWorkBufferCommit,
  shouldQueuePlayCanvasSort,
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

  it('keeps the CPU sorter single-flight while a worker result is pending', () => {
    expect(shouldQueuePlayCanvasSort(2)).toBe(true);
    expect(shouldQueuePlayCanvasSort(1)).toBe(true);
    expect(shouldQueuePlayCanvasSort(0)).toBe(false);
  });

  it('keeps only the latest atomic WorkBuffer commit for each RAW4D resource', () => {
    const resource = {};
    const first = vi.fn();
    const latest = vi.fn();
    registerPlayCanvasAtomicWorkBufferCommit(resource, first);
    registerPlayCanvasAtomicWorkBufferCommit(resource, latest);
    consumePlayCanvasAtomicWorkBufferCommit(resource)?.();
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
    expect(consumePlayCanvasAtomicWorkBufferCommit(resource)).toBeNull();
  });

  it('cancels an atomic WorkBuffer commit when direct rendering takes over', () => {
    const resource = {};
    registerPlayCanvasAtomicWorkBufferCommit(resource, vi.fn());
    cancelPlayCanvasAtomicWorkBufferCommit(resource);
    expect(consumePlayCanvasAtomicWorkBufferCommit(resource)).toBeNull();
  });
});
