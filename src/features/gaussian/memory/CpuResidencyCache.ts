export type CpuResidencyKind = 'compressed' | 'decoded';

export interface CpuResidencyStats {
  readonly compressedBytes: number;
  readonly decodedBytes: number;
  readonly residentBytes: number;
  readonly budgetBytes: number;
  readonly evictableBytes: number;
  readonly entryCount: number;
  readonly evictionCount: number;
  readonly overBudgetBytes: number;
  readonly activeId: string | null;
}

export interface CpuResidencyLease<T> {
  readonly id: string;
  readonly kind: CpuResidencyKind;
  readonly byteSize: number;
  readonly value: T;
  resize(byteSize: number): void;
  pin(): void;
  unpin(): void;
  touch(): void;
  release(): void;
}

interface CpuCacheEntry<T> {
  readonly id: string;
  readonly kind: CpuResidencyKind;
  byteSize: number;
  readonly value: T;
  readonly onEvict?: () => void;
  pinCount: number;
  lastUsed: number;
}

export class CpuResidencyCache {
  private readonly entries = new Map<string, CpuCacheEntry<unknown>>();
  private residentBytes = 0;
  private compressedBytes = 0;
  private decodedBytes = 0;
  private tick = 0;
  private evictionCount = 0;
  private activeId: string | null = null;
  private destroyed = false;

  constructor(private budgetBytes: number) {}

  get availableBytes(): number {
    return Math.max(0, this.budgetBytes - this.residentBytes);
  }

  setBudget(budgetBytes: number): void {
    this.budgetBytes = Math.max(0, budgetBytes);
    this.reconcile();
  }

  insert<T>(input: {
    readonly id: string;
    readonly kind: CpuResidencyKind;
    readonly byteSize: number;
    readonly value: T;
    readonly pinned?: boolean;
    readonly active?: boolean;
    readonly onEvict?: () => void;
  }): CpuResidencyLease<T> {
    if (this.destroyed) throw new Error('CPU residency cache has been destroyed.');
    if (this.entries.has(input.id)) throw new Error(`CPU residency page "${input.id}" already exists.`);
    const byteSize = Math.max(0, Math.floor(input.byteSize));
    this.reconcile(byteSize);
    if (this.residentBytes + byteSize > this.budgetBytes) {
      throw new Error(
        `CPU memory budget exceeded: ${Math.ceil((this.residentBytes + byteSize) / 1024 ** 2)} MiB requested / `
        + `${Math.floor(this.budgetBytes / 1024 ** 2)} MiB budget.`,
      );
    }

    // #WDD-gpt 2026-08-15 - 所有压缩段和解码页统一登记、Pin 与 LRU 淘汰，避免格式各自维护内存计数。
    const entry: CpuCacheEntry<T> = {
      id: input.id,
      kind: input.kind,
      byteSize,
      value: input.value,
      onEvict: input.onEvict,
      pinCount: input.pinned ? 1 : 0,
      lastUsed: ++this.tick,
    };
    this.entries.set(entry.id, entry as CpuCacheEntry<unknown>);
    this.residentBytes += byteSize;
    if (entry.kind === 'compressed') this.compressedBytes += byteSize;
    else this.decodedBytes += byteSize;
    if (input.active) this.activeId = entry.id;
    return this.createLease(entry);
  }

  setActive(id: string | null): void {
    this.activeId = id && this.entries.has(id) ? id : null;
    if (this.activeId) this.touch(this.activeId);
  }

  getStats(): CpuResidencyStats {
    let evictableBytes = 0;
    for (const entry of this.entries.values()) {
      if (entry.pinCount === 0) evictableBytes += entry.byteSize;
    }
    return {
      compressedBytes: this.compressedBytes,
      decodedBytes: this.decodedBytes,
      residentBytes: this.residentBytes,
      budgetBytes: this.budgetBytes,
      evictableBytes,
      entryCount: this.entries.size,
      evictionCount: this.evictionCount,
      overBudgetBytes: Math.max(0, this.residentBytes - this.budgetBytes),
      activeId: this.activeId,
    };
  }

  reconcile(requiredBytes = 0): void {
    const targetBytes = Math.max(0, this.budgetBytes - Math.max(0, requiredBytes));
    if (this.residentBytes <= targetBytes) return;
    const candidates = [...this.entries.values()]
      .filter((entry) => entry.pinCount === 0)
      .sort((left, right) => left.lastUsed - right.lastUsed);
    for (const entry of candidates) {
      if (this.residentBytes <= targetBytes) break;
      this.remove(entry.id, true);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    for (const id of [...this.entries.keys()]) this.remove(id, false);
    this.activeId = null;
    this.destroyed = true;
  }

  private createLease<T>(entry: CpuCacheEntry<T>): CpuResidencyLease<T> {
    let released = false;
    return {
      id: entry.id,
      kind: entry.kind,
      get byteSize() {
        return entry.byteSize;
      },
      value: entry.value,
      resize: (byteSize: number) => {
        if (!released) this.resize(entry.id, byteSize);
      },
      pin: () => {
        if (released) return;
        const current = this.entries.get(entry.id);
        if (current) current.pinCount += 1;
      },
      unpin: () => {
        if (released) return;
        const current = this.entries.get(entry.id);
        if (current) current.pinCount = Math.max(0, current.pinCount - 1);
        this.reconcile();
      },
      touch: () => {
        if (!released) this.touch(entry.id);
      },
      release: () => {
        if (released) return;
        released = true;
        this.remove(entry.id, false);
      },
    };
  }

  private touch(id: string): void {
    const entry = this.entries.get(id);
    if (entry) entry.lastUsed = ++this.tick;
  }

  private resize(id: string, requestedBytes: number): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const byteSize = Math.max(0, Math.floor(requestedBytes));
    const delta = byteSize - entry.byteSize;
    if (delta === 0) return;
    if (delta > 0) {
      this.reconcile(delta);
      if (this.residentBytes + delta > this.budgetBytes) {
        throw new Error(
          `CPU memory budget exceeded while growing "${id}": `
          + `${Math.ceil((this.residentBytes + delta) / 1024 ** 2)} MiB requested / `
          + `${Math.floor(this.budgetBytes / 1024 ** 2)} MiB budget.`,
        );
      }
    }
    entry.byteSize = byteSize;
    this.residentBytes += delta;
    if (entry.kind === 'compressed') this.compressedBytes += delta;
    else this.decodedBytes += delta;
    entry.lastUsed = ++this.tick;
  }

  private remove(id: string, evicted: boolean): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.residentBytes -= entry.byteSize;
    if (entry.kind === 'compressed') this.compressedBytes -= entry.byteSize;
    else this.decodedBytes -= entry.byteSize;
    if (this.activeId === id) this.activeId = null;
    if (evicted) this.evictionCount += 1;
    entry.onEvict?.();
  }
}
