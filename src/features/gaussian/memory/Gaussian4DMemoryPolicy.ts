export type Gaussian4DMemoryMode = 'auto' | 'compatible' | 'balanced' | 'performance' | 'custom';

export interface Gaussian4DMemoryPolicy {
  readonly mode: Gaussian4DMemoryMode;
  readonly cpuBudgetBytes: number;
  readonly gpuBudgetBytes: number;
  readonly gpuChunkBytes: number;
  readonly preloadAllKeyframes: boolean;
}

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const MAX_CPU_BUDGET_BYTES = 64 * GIB;
const AUTO_GPU_BUDGET_BYTES = 8 * GIB;
const FALLBACK_CPU_BUDGET_BYTES = 8 * GIB;

interface NavigatorWithDeviceMemory extends Navigator {
  readonly deviceMemory?: number;
}

interface PerformanceWithMemory extends Performance {
  readonly memory?: {
    readonly jsHeapSizeLimit?: number;
  };
}

export const GAUSSIAN_4D_MEMORY_POLICIES: Readonly<
  Record<Exclude<Gaussian4DMemoryMode, 'auto' | 'custom'>, Gaussian4DMemoryPolicy>
> = {
  compatible: {
    mode: 'compatible',
    cpuBudgetBytes: GIB,
    gpuBudgetBytes: 512 * MIB,
    gpuChunkBytes: 64 * MIB,
    preloadAllKeyframes: false,
  },
  balanced: {
    mode: 'balanced',
    cpuBudgetBytes: 4 * GIB,
    gpuBudgetBytes: 2 * GIB,
    gpuChunkBytes: 128 * MIB,
    preloadAllKeyframes: true,
  },
  performance: {
    mode: 'performance',
    cpuBudgetBytes: 12 * GIB,
    gpuBudgetBytes: 6 * GIB,
    gpuChunkBytes: 256 * MIB,
    preloadAllKeyframes: true,
  },
};

export function createAutomaticGaussian4DMemoryPolicy(
  deviceMemoryGiB?: number,
  jsHeapLimitBytes?: number,
): Gaussian4DMemoryPolicy {
  const deviceMemoryBytes = Number.isFinite(deviceMemoryGiB) && (deviceMemoryGiB ?? 0) > 0
    ? (deviceMemoryGiB as number) * GIB
    : 0;
  const heapLimitBytes = Number.isFinite(jsHeapLimitBytes) && (jsHeapLimitBytes ?? 0) > 0
    ? jsHeapLimitBytes as number
    : 0;
  const detectedCpuBytes = Math.max(deviceMemoryBytes, heapLimitBytes, FALLBACK_CPU_BUDGET_BYTES);
  return {
    mode: 'auto',
    cpuBudgetBytes: Math.min(MAX_CPU_BUDGET_BYTES, Math.floor(detectedCpuBytes)),
    // #WDD-gpt 2026-08-15 - WebGPU 不暴露物理显存容量；8GB 是自动模式的最高应用预算，不做崩溃式探测。
    gpuBudgetBytes: AUTO_GPU_BUDGET_BYTES,
    gpuChunkBytes: 256 * MIB,
    preloadAllKeyframes: true,
  };
}

export function detectAutomaticGaussian4DMemoryPolicy(): Gaussian4DMemoryPolicy {
  const deviceMemoryGiB = typeof navigator === 'undefined'
    ? undefined
    : (navigator as NavigatorWithDeviceMemory).deviceMemory;
  const jsHeapLimitBytes = typeof performance === 'undefined'
    ? undefined
    : (performance as PerformanceWithMemory).memory?.jsHeapSizeLimit;
  // #WDD-gpt 2026-08-15 - 自动模式取浏览器能够报告的本机内存和 JS Heap 上限中的较大值。
  return createAutomaticGaussian4DMemoryPolicy(deviceMemoryGiB, jsHeapLimitBytes);
}

export function createGaussian4DMemoryPolicy(
  mode: Gaussian4DMemoryMode,
  customCpuGiB = 12,
  customGpuGiB = 6,
): Gaussian4DMemoryPolicy {
  if (mode === 'auto') return detectAutomaticGaussian4DMemoryPolicy();
  if (mode !== 'custom') return GAUSSIAN_4D_MEMORY_POLICIES[mode];
  const cpuGiB = Math.min(64, Math.max(1, customCpuGiB));
  const gpuGiB = Math.min(32, Math.max(0.5, customGpuGiB));
  return {
    mode,
    cpuBudgetBytes: Math.floor(cpuGiB * GIB),
    gpuBudgetBytes: Math.floor(gpuGiB * GIB),
    gpuChunkBytes: 256 * MIB,
    preloadAllKeyframes: true,
  };
}
