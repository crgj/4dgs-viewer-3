import type { Gaussian4DMemoryMode } from './Gaussian4DMemoryPolicy';

export interface Gaussian4DMemoryStats {
  readonly policyMode: Gaussian4DMemoryMode;
  readonly cpuResidentBytes: number;
  readonly cpuCompressedBytes: number;
  readonly cpuDecodedBytes: number;
  readonly cpuEvictableBytes: number;
  readonly cpuEvictionCount: number;
  readonly gpuManagedBytes: number;
  readonly gpuActiveBytes: number;
  readonly gpuCachedBytes: number;
  readonly gpuOverBudgetBytes: number;
  readonly gpuBufferReuseCount: number;
  readonly transferActiveCount: number;
  readonly transferQueuedCount: number;
  readonly transferCompletedCount: number;
  readonly transferCancelledCount: number;
  readonly cpuBudgetBytes: number;
  readonly gpuBudgetBytes: number;
  readonly transport: 'shared-array-buffer' | 'transferable';
  readonly activeBufferId: string | null;
}
