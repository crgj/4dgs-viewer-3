// #WDD-gpt 2026-08-19 - PlayCanvas 统一 CPU 排序器会保留旧 world version 的异步结果；在新中心已提交后必须丢弃旧结果。
import { GSplatUnifiedSorter } from 'playcanvas/build/playcanvas/src/scene/gsplat-unified/gsplat-unified-sorter.js';
import { GSplatManager } from 'playcanvas/build/playcanvas/src/scene/gsplat-unified/gsplat-manager.js';

interface SortParameters {
  readonly version: number;
}

interface SortMessage {
  readonly data?: {
    readonly version?: number;
  };
  readonly version?: number;
}

interface PendingSortResult {
  readonly version: number;
  readonly orderData: Uint32Array;
}

interface GuardedSorter {
  readonly jobsInFlight: number;
  pendingSorted: PendingSortResult | null;
  releaseOrderData(orderData: Uint32Array): void;
}

interface QueuedSortParameters {
  readonly params: readonly unknown[];
  readonly radialSorting: boolean;
}

interface GuardedSorterPrototype {
  applyPendingSorted(this: GuardedSorter): void;
  setSortParameters(this: GuardedSorter, payload: SortParameters): void;
  setSortParams(this: GuardedSorter, params: readonly unknown[], radialSorting: boolean): void;
  onSorted(this: GuardedSorter, message: SortMessage): void;
}

interface GuardedManager {
  readonly world: {
    readonly lastWorldStateVersion: number;
  };
}

interface GuardedManagerPrototype {
  onSorted(this: GuardedManager, count: number, version: number, orderData: Uint32Array): void;
}

const latestVersionBySorter = new WeakMap<GuardedSorter, number>();
const queuedSortBySorter = new WeakMap<GuardedSorter, QueuedSortParameters>();
let installed = false;

export function isStalePlayCanvasSortResult(version: number, latestVersion: number): boolean {
  return Number.isFinite(version) && Number.isFinite(latestVersion) && version < latestVersion;
}

export function canApplyPlayCanvasSortResult(jobsInFlight: number): boolean {
  return jobsInFlight === 0;
}

export function shouldQueuePlayCanvasSort(jobsInFlight: number): boolean {
  return jobsInFlight > 0;
}

export function installPlayCanvasSortResultGuard(): void {
  if (installed) return;
  installed = true;

  const prototype = GSplatUnifiedSorter.prototype as unknown as GuardedSorterPrototype;
  const originalApplyPendingSorted = prototype.applyPendingSorted;
  const originalSetSortParameters = prototype.setSortParameters;
  const originalSetSortParams = prototype.setSortParams;
  const originalOnSorted = prototype.onSorted;

  prototype.applyPendingSorted = function applyPendingSorted(): void {
    if (!this.pendingSorted) {
      originalApplyPendingSorted.call(this);
      return;
    }
    if (!canApplyPlayCanvasSortResult(this.jobsInFlight)) {
      return;
    }
    originalApplyPendingSorted.call(this);
  };

  prototype.setSortParameters = function setSortParameters(payload: SortParameters): void {
    latestVersionBySorter.set(this, payload.version);
    originalSetSortParameters.call(this, payload);
  };

  // #WDD-gpt 2026-09-08 - PlayCanvas 虽只创建一个 CPU Sort Worker，却允许多个版本同时在途；
  // 这里把它收敛为单飞队列并只保留最新参数，防止旧帧排序在快速切帧期间排队回写。
  prototype.setSortParams = function setSortParams(
    params: readonly unknown[],
    radialSorting: boolean,
  ): void {
    if (shouldQueuePlayCanvasSort(this.jobsInFlight)) {
      queuedSortBySorter.set(this, { params, radialSorting });
      return;
    }
    originalSetSortParams.call(this, params, radialSorting);
  };

  prototype.onSorted = function onSorted(message: SortMessage): void {
    const version = Number(message.data?.version ?? message.version);
    originalOnSorted.call(this, message);
    const latestVersion = latestVersionBySorter.get(this);
    if (latestVersion !== undefined && isStalePlayCanvasSortResult(version, latestVersion)) {
      const pending = this.pendingSorted;
      if (pending?.version === version) {
        this.pendingSorted = null;
        this.releaseOrderData(pending.orderData);
      }
    }
    const queued = queuedSortBySorter.get(this);
    if (!queued || shouldQueuePlayCanvasSort(this.jobsInFlight)) return;
    queuedSortBySorter.delete(this);
    originalSetSortParams.call(this, queued.params, queued.radialSorting);
  };

  const managerPrototype = GSplatManager.prototype as unknown as GuardedManagerPrototype;
  const originalManagerOnSorted = managerPrototype.onSorted;
  managerPrototype.onSorted = function onSorted(count: number, version: number, orderData: Uint32Array): void {
    if (isStalePlayCanvasSortResult(version, this.world.lastWorldStateVersion)) {
      return;
    }
    originalManagerOnSorted.call(this, count, version, orderData);
  };
}
