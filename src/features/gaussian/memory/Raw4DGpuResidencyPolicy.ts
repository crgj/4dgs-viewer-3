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

export interface Raw4DGpuPreloadPlan {
  readonly budgetBytes: number;
  readonly fits: boolean;
  readonly requiredBytes: number;
}

// #WDD-gpt 2026-09-07 - 全量显存预读必须先整体试算，避免加载一半才因超预算回退并重建滑窗。
export function planRaw4DGpuPreload(
  segmentBytes: readonly number[],
  budgetBytes: number,
): Raw4DGpuPreloadPlan {
  const normalizedBudget = Number.isFinite(budgetBytes) ? Math.max(0, budgetBytes) : 0;
  const requiredBytes = segmentBytes.reduce((total, bytes) => (
    total + (Number.isFinite(bytes) ? Math.max(0, bytes) : 0)
  ), 0);
  return {
    budgetBytes: normalizedBudget,
    fits: requiredBytes <= normalizedBudget,
    requiredBytes,
  };
}

// #WDD-gpt 2026-09-07 - 超长 RAW4D 序列只保留当前段与有限未来段，避免后台建满 GPU 实体令排序版本永远无法稳定。
export function raw4DGpuWindowContains(
  segmentIndex: number,
  activeIndex: number,
  maxFutureSegments: number,
): boolean {
  if (!Number.isFinite(maxFutureSegments)) return true;
  const futureLimit = Math.max(0, Math.floor(maxFutureSegments));
  return segmentIndex >= activeIndex && segmentIndex <= activeIndex + futureLimit;
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
