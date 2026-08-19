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

interface GuardedSorterPrototype {
  applyPendingSorted(this: GuardedSorter): void;
  setSortParameters(this: GuardedSorter, payload: SortParameters): void;
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
let installed = false;

export function isStalePlayCanvasSortResult(version: number, latestVersion: number): boolean {
  return Number.isFinite(version) && Number.isFinite(latestVersion) && version < latestVersion;
}

export function canApplyPlayCanvasSortResult(jobsInFlight: number): boolean {
  return jobsInFlight === 0;
}

export function installPlayCanvasSortResultGuard(): void {
  if (installed) return;
  installed = true;

  const prototype = GSplatUnifiedSorter.prototype as unknown as GuardedSorterPrototype;
  const originalApplyPendingSorted = prototype.applyPendingSorted;
  const originalSetSortParameters = prototype.setSortParameters;
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

  prototype.onSorted = function onSorted(message: SortMessage): void {
    const version = Number(message.data?.version ?? message.version);
    originalOnSorted.call(this, message);
    const latestVersion = latestVersionBySorter.get(this);
    if (latestVersion === undefined || !isStalePlayCanvasSortResult(version, latestVersion)) return;
    const pending = this.pendingSorted;
    if (!pending || pending.version !== version) return;
    this.pendingSorted = null;
    this.releaseOrderData(pending.orderData);
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
