export interface Raw4DGpuResidencyCandidate {
  readonly residentId: string;
  readonly lastUsed: number;
}

export interface Raw4DGpuEvictionInput {
  readonly candidates: readonly Raw4DGpuResidencyCandidate[];
  readonly order: readonly string[];
  readonly activeId?: string;
  readonly activeIndex: number;
  readonly targetIndex: number;
  readonly allowActiveEviction: boolean;
}

// #WDD-gpt 2026-08-16 - 显存窗口优先淘汰离目标最远的已播放段；没有历史段时才清理最远未来段。
export function chooseRaw4DGpuEviction(input: Raw4DGpuEvictionInput): string | null {
  const targetId = input.order[input.targetIndex];
  const orderIndex = new Map(input.order.map((residentId, index) => [residentId, index]));
  const candidates = input.candidates.filter(({ residentId }) => {
    if (residentId === targetId) return false;
    if (!input.allowActiveEviction && residentId === input.activeId) return false;
    const index = orderIndex.get(residentId) ?? -1;
    return input.allowActiveEviction || index < input.activeIndex;
  });
  candidates.sort((left, right) => {
    const leftIndex = orderIndex.get(left.residentId) ?? -1;
    const rightIndex = orderIndex.get(right.residentId) ?? -1;
    const leftPast = leftIndex < input.targetIndex;
    const rightPast = rightIndex < input.targetIndex;
    if (leftPast !== rightPast) return leftPast ? -1 : 1;
    if (leftPast && leftIndex !== rightIndex) return leftIndex - rightIndex;
    if (!leftPast && leftIndex !== rightIndex) return rightIndex - leftIndex;
    return left.lastUsed - right.lastUsed;
  });
  return candidates[0]?.residentId ?? null;
}
