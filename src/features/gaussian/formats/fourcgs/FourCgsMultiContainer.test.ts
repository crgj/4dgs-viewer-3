import { describe, expect, it } from 'vitest';
import type { FourCgsDescriptor } from './FourCgsTypes';
import { mergeFourCgsDescriptors } from './FourCgsMultiContainer';

function descriptor(name: string, firstFrame: number, lastFrame: number): FourCgsDescriptor {
  return {
    sourceName: name, sourceBytes: 10, codecName: 'test', firstFrame, lastFrame,
    totalFrames: lastFrame - firstFrame + 1, slotCount: 2, crossOriginIsolated: true,
    segments: [{
      name: `${firstFrame}-${lastFrame}`, firstFrame, lastFrame, totalFrames: lastFrame - firstFrame + 1,
      gaussianCount: 1, bankCounts: { position: 1, rotation: 1, colorDc: 1, scale: 1, opacity: 1 },
    }],
    decodeTimings: { streamReadMs: 1, attributeDecodeMs: 2, totalMs: 3, workerCount: 1, hardwareConcurrency: 4, attributeTasksMs: {} },
  };
}

describe('multiple 4CGS containers', () => {
  it('sorts containers by source frame and preserves one shared boundary frame', () => {
    const merged = mergeFourCgsDescriptors([descriptor('part-2', 10, 20), descriptor('part-1', 0, 10)]);
    expect(merged.descriptor.segments.map((segment) => segment.firstFrame)).toEqual([0, 10]);
    expect(merged.descriptor.totalFrames).toBe(21);
    expect(merged.segmentSources).toEqual([{ sourceIndex: 1, segmentIndex: 0 }, { sourceIndex: 0, segmentIndex: 0 }]);
  });

  it('rejects missing frame ranges', () => {
    expect(() => mergeFourCgsDescriptors([descriptor('part-1', 0, 9), descriptor('part-2', 12, 20)]))
      .toThrow(/缺少帧 10-11/);
  });
});
