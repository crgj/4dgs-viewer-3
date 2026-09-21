import type { FourCgsDescriptor, FourCgsSegment } from './FourCgsTypes';

export interface FourCgsMultiSegmentSource {
  readonly sourceIndex: number;
  readonly segmentIndex: number;
}

export function mergeFourCgsDescriptors(input: readonly FourCgsDescriptor[]): {
  readonly descriptor: FourCgsDescriptor;
  readonly segmentSources: readonly FourCgsMultiSegmentSource[];
} {
  if (input.length < 2) throw new Error('多 4CGS 序列至少需要两个容器。');
  const ordered = input.map((descriptor, sourceIndex) => ({ descriptor, sourceIndex }))
    .sort((a, b) => a.descriptor.firstFrame - b.descriptor.firstFrame
      || a.descriptor.sourceName.localeCompare(b.descriptor.sourceName));
  const segments: FourCgsSegment[] = [];
  const segmentSources: FourCgsMultiSegmentSource[] = [];
  for (const { descriptor, sourceIndex } of ordered) {
    if (descriptor.segments.length === 0) throw new Error(`${descriptor.sourceName} 不包含 4CGS 片段。`);
    descriptor.segments.forEach((segment, segmentIndex) => {
      const previous = segments.at(-1);
      if (previous && segment.firstFrame < previous.lastFrame) {
        throw new Error(`${descriptor.sourceName} 与前一 4CGS 的帧范围重叠超过共享边界。`);
      }
      if (previous && segment.firstFrame > previous.lastFrame + 1) {
        throw new Error(`${descriptor.sourceName} 与前一 4CGS 之间缺少帧 ${previous.lastFrame + 1}-${segment.firstFrame - 1}。`);
      }
      segments.push(segment);
      segmentSources.push({ sourceIndex, segmentIndex });
    });
  }
  const firstFrame = segments[0].firstFrame;
  const lastFrame = segments.at(-1)!.lastFrame;
  const sourceBytes = input.reduce((sum, descriptor) => sum + descriptor.sourceBytes, 0);
  const slotCount = input.reduce((sum, descriptor) => sum + descriptor.slotCount, 0);
  if (!Number.isSafeInteger(sourceBytes) || !Number.isSafeInteger(slotCount)) throw new Error('多 4CGS 汇总大小超过安全整数范围。');
  const sceneTransform = ordered.find(({ descriptor }) => descriptor.sceneTransform)?.descriptor.sceneTransform;
  const cameraBookmarks = ordered.find(({ descriptor }) => descriptor.cameraBookmarks)?.descriptor.cameraBookmarks;
  // #WDD-gpt 2026-09-20 - 合并只重排容器与片段目录，点数据仍由各自解码器逐文件读取，避免多文件展开内存叠加。
  return {
    descriptor: {
      sourceName: `4CGS × ${input.length}`,
      sourceBytes,
      codecName: `4CGS-MultiContainer-${input.length}`,
      firstFrame,
      lastFrame,
      totalFrames: lastFrame - firstFrame + 1,
      slotCount,
      segments,
      sceneTransform,
      cameraBookmarks,
      crossOriginIsolated: input.every((descriptor) => descriptor.crossOriginIsolated),
      decodeTimings: {
        streamReadMs: input.reduce((sum, descriptor) => sum + descriptor.decodeTimings.streamReadMs, 0),
        attributeDecodeMs: input.reduce((sum, descriptor) => sum + descriptor.decodeTimings.attributeDecodeMs, 0),
        totalMs: input.reduce((sum, descriptor) => sum + descriptor.decodeTimings.totalMs, 0),
        workerCount: Math.max(...input.map((descriptor) => descriptor.decodeTimings.workerCount)),
        hardwareConcurrency: Math.max(...input.map((descriptor) => descriptor.decodeTimings.hardwareConcurrency)),
        attributeTasksMs: {},
      },
    },
    segmentSources,
  };
}
