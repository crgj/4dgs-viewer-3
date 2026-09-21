import type { FourCgsDescriptor, FourCgsSegment } from './FourCgsTypes';

export interface FourCgsMultiSegmentSource {
  readonly sourceIndex: number;
  readonly segmentIndex: number;
}

// #WDD-gpt 2026-09-20 - 合并时间轴的真实范围写入内部 Canonical 段名，导出 Worker 不再从重复原名还原成四个同区间。
export function fourCgsTimelineSourceName(sourceName: string, segment: FourCgsSegment): string {
  const stem = sourceName.replace(/\.4cgs$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  return `${stem}_${segment.firstFrame}_${segment.lastFrame}.raw4d`;
}

function formsContinuousSourceTimeline(
  ordered: readonly { readonly descriptor: FourCgsDescriptor; readonly sourceIndex: number }[],
): boolean {
  let previous: FourCgsSegment | undefined;
  for (const { descriptor } of ordered) {
    if (descriptor.segments.length === 0) return false;
    for (const segment of descriptor.segments) {
      if (previous && (segment.firstFrame < previous.lastFrame || segment.firstFrame > previous.lastFrame + 1)) {
        return false;
      }
      previous = segment;
    }
  }
  return true;
}

export function mergeFourCgsDescriptors(input: readonly FourCgsDescriptor[]): {
  readonly descriptor: FourCgsDescriptor;
  readonly segmentSources: readonly FourCgsMultiSegmentSource[];
} {
  if (input.length < 2) throw new Error('多 4CGS 序列至少需要两个容器。');
  const selected = input.map((descriptor, sourceIndex) => ({ descriptor, sourceIndex }));
  const sourceOrdered = [...selected].sort((a, b) => a.descriptor.firstFrame - b.descriptor.firstFrame
    || a.descriptor.sourceName.localeCompare(b.descriptor.sourceName));
  // #WDD-gpt 2026-09-20 - 同起始帧表示多个独立 4CGS 片段而非错误重叠；按用户选择顺序串接。
  // #WDD-gpt 2026-09-20 - 不连续或互相重叠的不同容器同样视为独立段落；连续分卷仍按源帧排序，兼容逆序选择。
  const concatenateStandalone = input.every((descriptor) => descriptor.firstFrame === input[0].firstFrame)
    || !formsContinuousSourceTimeline(sourceOrdered);
  const ordered = concatenateStandalone ? selected : sourceOrdered;
  const segments: FourCgsSegment[] = [];
  const segmentSources: FourCgsMultiSegmentSource[] = [];
  let nextStandaloneFrame = input[0].firstFrame;
  for (const { descriptor, sourceIndex } of ordered) {
    if (descriptor.segments.length === 0) throw new Error(`${descriptor.sourceName} 不包含 4CGS 片段。`);
    const frameOffset = concatenateStandalone ? nextStandaloneFrame - descriptor.firstFrame : 0;
    descriptor.segments.forEach((segment, segmentIndex) => {
      const timelineSegment = frameOffset === 0 ? segment : {
        ...segment,
        firstFrame: segment.firstFrame + frameOffset,
        lastFrame: segment.lastFrame + frameOffset,
      };
      const previous = segments.at(-1);
      if (previous && timelineSegment.firstFrame < previous.lastFrame) {
        throw new Error(`${descriptor.sourceName} 与前一 4CGS 的帧范围重叠超过共享边界。`);
      }
      if (previous && timelineSegment.firstFrame > previous.lastFrame + 1) {
        throw new Error(`${descriptor.sourceName} 与前一 4CGS 之间缺少帧 ${previous.lastFrame + 1}-${timelineSegment.firstFrame - 1}。`);
      }
      segments.push(timelineSegment);
      segmentSources.push({ sourceIndex, segmentIndex });
    });
    if (concatenateStandalone) nextStandaloneFrame = segments.at(-1)!.lastFrame + 1;
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
