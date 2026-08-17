import type { GraphicsDevice } from 'playcanvas';
import { CpuResidencyCache, type CpuResidencyKind, type CpuResidencyLease } from './CpuResidencyCache';
import type { Gaussian4DMemoryPolicy } from './Gaussian4DMemoryPolicy';
import type { Gaussian4DMemoryStats } from './Gaussian4DMemoryStats';
import { GpuBufferPool } from './GpuBufferPool';
import { TransferScheduler, type TransferPriority } from './TransferScheduler';

export interface GaussianCpuPageLease<T> extends CpuResidencyLease<T> {
  readonly transport: 'shared-array-buffer' | 'transferable';
}

export interface GaussianGpuExternalLease {
  readonly id: string;
  readonly byteSize: number;
  resize(byteSize: number): void;
  release(): void;
}

export class GaussianMemoryCoordinator {
  readonly gpuPool: GpuBufferPool;
  private readonly cpuCache: CpuResidencyCache;
  private readonly transferScheduler = new TransferScheduler(1);
  private readonly transports = new Map<string, GaussianCpuPageLease<unknown>['transport']>();
  private readonly externalGpuAllocations = new Map<string, number>();
  private destroyed = false;

  constructor(
    device: GraphicsDevice,
    private policy: Gaussian4DMemoryPolicy,
  ) {
    this.cpuCache = new CpuResidencyCache(policy.cpuBudgetBytes);
    this.gpuPool = new GpuBufferPool(device, policy.gpuBudgetBytes, policy.gpuChunkBytes);
  }

  get availableCpuBytes(): number {
    return this.cpuCache.availableBytes;
  }

  setPolicy(policy: Gaussian4DMemoryPolicy): void {
    if (this.destroyed) return;
    this.policy = policy;
    // #WDD-gpt 2026-08-15 - 降低预算时立即回收未 Pin 的 CPU 页与空闲 GPUBuffer，不等待下一次导入。
    this.cpuCache.setBudget(policy.cpuBudgetBytes);
    this.gpuPool.setBudget(policy.gpuBudgetBytes, policy.gpuChunkBytes);
  }

  registerCpuPage<T>(input: {
    readonly id: string;
    readonly kind: CpuResidencyKind;
    readonly byteSize: number;
    readonly value: T;
    readonly transport: GaussianCpuPageLease<T>['transport'];
    readonly pinned?: boolean;
    readonly active?: boolean;
    readonly onEvict?: () => void;
  }): GaussianCpuPageLease<T> {
    if (this.destroyed) throw new Error('Gaussian memory coordinator has been destroyed.');
    const lease = this.cpuCache.insert({
      ...input,
      onEvict: () => {
        this.transports.delete(input.id);
        input.onEvict?.();
      },
    });
    this.transports.set(input.id, input.transport);
    return {
      id: lease.id,
      kind: lease.kind,
      get byteSize() {
        return lease.byteSize;
      },
      value: lease.value,
      transport: input.transport,
      resize: (byteSize) => lease.resize(byteSize),
      pin: () => lease.pin(),
      unpin: () => lease.unpin(),
      touch: () => lease.touch(),
      release: () => lease.release(),
    };
  }

  registerExternalGpuAllocation(id: string, requestedBytes: number): GaussianGpuExternalLease {
    if (this.destroyed) throw new Error('Gaussian memory coordinator has been destroyed.');
    if (this.externalGpuAllocations.has(id)) throw new Error(`GPU allocation "${id}" already exists.`);
    const normalizedBytes = Math.max(0, Math.floor(requestedBytes));
    const externalBytes = [...this.externalGpuAllocations.values()].reduce((total, bytes) => total + bytes, 0);
    if (this.gpuPool.committedBytes + externalBytes + normalizedBytes > this.policy.gpuBudgetBytes) {
      // #WDD-gpt 2026-08-16 - 纹理也计入同一显存预算，让段落预取能在超限前淘汰已播放缓存。
      throw new Error(
        `GPU memory budget exceeded while registering ${id}: `
        + `${Math.ceil((this.gpuPool.committedBytes + externalBytes + normalizedBytes) / 1024 ** 2)} MiB requested / `
        + `${Math.floor(this.policy.gpuBudgetBytes / 1024 ** 2)} MiB budget.`,
      );
    }
    let released = false;
    requestedBytes = normalizedBytes;
    this.externalGpuAllocations.set(id, requestedBytes);
    return {
      id,
      get byteSize() {
        return released ? 0 : Math.max(0, Math.floor(requestedBytes));
      },
      resize: (byteSize: number) => {
        if (released) return;
        requestedBytes = Math.max(0, Math.floor(byteSize));
        this.externalGpuAllocations.set(id, requestedBytes);
      },
      release: () => {
        if (released) return;
        released = true;
        this.externalGpuAllocations.delete(id);
      },
    };
  }

  setActiveCpuPage(id: string | null): void {
    this.cpuCache.setActive(id);
  }

  scheduleGpuTransfer<T>(input: {
    readonly key: string;
    readonly priority?: TransferPriority;
    readonly signal?: AbortSignal;
    readonly run: (signal?: AbortSignal) => Promise<T>;
  }): Promise<T> {
    return this.transferScheduler.schedule({
      ...input,
      priority: input.priority ?? 'prefetch',
    });
  }

  getStats(): Gaussian4DMemoryStats {
    const cpu = this.cpuCache.getStats();
    const transfers = this.transferScheduler.getStats();
    const externalGpuBytes = [...this.externalGpuAllocations.values()].reduce((total, bytes) => total + bytes, 0);
    const gpuManagedBytes = this.gpuPool.committedBytes + externalGpuBytes;
    const gpuActiveBytes = this.gpuPool.activeBytes + externalGpuBytes;
    return {
      // #WDD-gpt 2026-08-16 - 将运行时实际策略随统计回传，界面据此验证预设已应用而不是只相信下拉框状态。
      policyMode: this.policy.mode,
      cpuResidentBytes: cpu.residentBytes,
      cpuCompressedBytes: cpu.compressedBytes,
      cpuDecodedBytes: cpu.decodedBytes,
      cpuEvictableBytes: cpu.evictableBytes,
      cpuEvictionCount: cpu.evictionCount,
      gpuManagedBytes,
      gpuActiveBytes,
      gpuCachedBytes: this.gpuPool.cachedBytes,
      gpuOverBudgetBytes: Math.max(0, gpuManagedBytes - this.policy.gpuBudgetBytes),
      gpuBufferReuseCount: this.gpuPool.reusedBufferCount,
      transferActiveCount: transfers.active,
      transferQueuedCount: transfers.queued,
      transferCompletedCount: transfers.completed,
      transferCancelledCount: transfers.cancelled,
      cpuBudgetBytes: this.policy.cpuBudgetBytes,
      gpuBudgetBytes: this.policy.gpuBudgetBytes,
      transport: (cpu.activeId ? this.transports.get(cpu.activeId) : undefined)
        ?? (globalThis.crossOriginIsolated ? 'shared-array-buffer' : 'transferable'),
      activeBufferId: cpu.activeId,
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.cpuCache.destroy();
    this.transferScheduler.destroy();
    this.transports.clear();
    this.externalGpuAllocations.clear();
    this.gpuPool.destroy();
    this.destroyed = true;
  }
}
