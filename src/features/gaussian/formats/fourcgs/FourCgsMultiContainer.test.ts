import { describe, expect, it } from 'vitest';
import type { FourCgsDescriptor } from './FourCgsTypes';
import { fourCgsTimelineSourceName, mergeFourCgsDescriptors } from './FourCgsMultiContainer';

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

  // #WDD-gpt 2026-09-20 - 不连续的容器是独立段落，不用源帧缺口阻止同时导入。
  it('concatenates containers with a source-frame gap as independent sections', () => {
    const merged = mergeFourCgsDescriptors([descriptor('part-1', 0, 9), descriptor('part-2', 12, 20)]);
    expect(merged.descriptor.segments.map((segment) => [segment.firstFrame, segment.lastFrame])).toEqual([
      [0, 9], [10, 18],
    ]);
    expect(merged.descriptor.totalFrames).toBe(19);
  });

  // #WDD-gpt 2026-09-20 - 多个同起点独立容器按选择顺序串接，不能把常见的复制文件误判为异常重叠。
  it('concatenates standalone containers with the same source start in selection order', () => {
    const merged = mergeFourCgsDescriptors([
      descriptor('first-selected', 600, 749),
      descriptor('second-selected', 600, 749),
      descriptor('third-selected', 600, 749),
      descriptor('fourth-selected', 600, 749),
    ]);
    expect(merged.descriptor.segments.map((segment) => [segment.firstFrame, segment.lastFrame])).toEqual([
      [600, 749], [750, 899], [900, 1049], [1050, 1199],
    ]);
    expect(merged.descriptor.totalFrames).toBe(600);
    expect(merged.segmentSources).toEqual([
      { sourceIndex: 0, segmentIndex: 0 },
      { sourceIndex: 1, segmentIndex: 0 },
      { sourceIndex: 2, segmentIndex: 0 },
      { sourceIndex: 3, segmentIndex: 0 },
    ]);
    expect(merged.descriptor.segments.map((segment) => fourCgsTimelineSourceName('music（复件）.4cgs', segment))).toEqual([
      'music（复件）_600_749.raw4d', 'music（复件）_750_899.raw4d',
      'music（复件）_900_1049.raw4d', 'music（复件）_1050_1199.raw4d',
    ]);
  });

  it('concatenates partially overlapping containers as independent sections in selection order', () => {
    const merged = mergeFourCgsDescriptors([descriptor('first-selected', 50, 150), descriptor('second-selected', 0, 100)]);
    expect(merged.descriptor.segments.map((segment) => [segment.firstFrame, segment.lastFrame])).toEqual([
      [50, 150], [151, 251],
    ]);
    expect(merged.segmentSources).toEqual([
      { sourceIndex: 0, segmentIndex: 0 }, { sourceIndex: 1, segmentIndex: 0 },
    ]);
  });

  it('keeps all internal boundaries while concatenating unrelated containers', () => {
    const test = descriptor('test_0001.4cgs', 0, 60);
    const testSegments = [
      [0, 10], [10, 20], [20, 30], [30, 40], [40, 50], [50, 60],
    ].map(([firstFrame, lastFrame]) => ({
      ...test.segments[0], name: `${firstFrame}-${lastFrame}`,
      firstFrame, lastFrame, totalFrames: lastFrame - firstFrame + 1,
    }));
    const merged = mergeFourCgsDescriptors([
      descriptor('music.4cgs', 600, 749), { ...test, segments: testSegments },
    ]);
    expect(merged.descriptor.segments.map((segment) => [segment.firstFrame, segment.lastFrame])).toEqual([
      [600, 749], [750, 760], [760, 770], [770, 780], [780, 790], [790, 800], [800, 810],
    ]);
    expect(merged.descriptor.totalFrames).toBe(211);
  });
});
