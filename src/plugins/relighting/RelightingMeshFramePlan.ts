// #WDD-gpt 2026-08-21 - 统一多片段时间轴到逐帧重光照采样的映射；相邻片段共享的边界帧只采用后一段。
export interface RelightingSegmentFramePlan {
  readonly segmentIndex: number;
  readonly firstFrame: number;
  readonly lastFrame: number;
  readonly totalFrames: number;
}

export interface RelightingFrameAddress {
  readonly globalFrame: number;
  readonly localFrame: number;
  readonly segmentIndex: number;
}

export function buildRelightingSegmentFramePlans(
  segmentFrameCounts: readonly number[],
): RelightingSegmentFramePlan[] {
  let firstFrame = 0;
  return segmentFrameCounts.map((rawCount, segmentIndex) => {
    const totalFrames = Math.max(1, Math.round(rawCount));
    const plan = {
      segmentIndex,
      firstFrame,
      lastFrame: firstFrame + totalFrames - 1,
      totalFrames,
    };
    firstFrame = plan.lastFrame;
    return plan;
  });
}

export function addressRelightingFrames(
  plans: readonly RelightingSegmentFramePlan[],
  requestedStart: number,
  requestedEnd: number,
): RelightingFrameAddress[] {
  if (plans.length === 0) return [];
  const timelineEnd = plans.at(-1)!.lastFrame;
  const frameStart = Math.max(0, Math.min(timelineEnd, Math.round(requestedStart)));
  const frameEnd = Math.max(frameStart, Math.min(timelineEnd, Math.round(requestedEnd)));
  const addresses: RelightingFrameAddress[] = [];
  for (let globalFrame = frameStart; globalFrame <= frameEnd; globalFrame += 1) {
    let plan = plans[0];
    for (let index = 1; index < plans.length; index += 1) {
      if (plans[index].firstFrame <= globalFrame) plan = plans[index];
      else break;
    }
    addresses.push({
      globalFrame,
      localFrame: Math.max(0, Math.min(plan.totalFrames - 1, globalFrame - plan.firstFrame)),
      segmentIndex: plan.segmentIndex,
    });
  }
  return addresses;
}
