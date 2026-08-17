import type { Gaussian4DMemoryPolicy } from '../../gaussian/memory/Gaussian4DMemoryPolicy';
import type { ViewportMemoryUsage } from '../runtime/ViewportRuntime';

type RuntimeMemoryPolicyEvidence = Pick<
  ViewportMemoryUsage,
  'runtimePolicyMode' | 'cpuBudgetBytes' | 'gpuBudgetBytes'
>;

// #WDD-gpt 2026-08-16 - 只有运行时回报的模式和两项预算全部吻合，界面才宣称高内存策略已经真正生效。
export function isRuntimeMemoryPolicyApplied(
  usage: RuntimeMemoryPolicyEvidence,
  policy: Gaussian4DMemoryPolicy,
): boolean {
  return usage.runtimePolicyMode === policy.mode
    && usage.cpuBudgetBytes === policy.cpuBudgetBytes
    && usage.gpuBudgetBytes === policy.gpuBudgetBytes;
}

export function remainingMemoryBytes(used: number | null, limit: number | null): number | null {
  if (used === null || limit === null) return null;
  return Math.max(0, limit - used);
}
