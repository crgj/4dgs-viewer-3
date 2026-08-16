import {
  BUFFERUSAGE_COPY_DST,
  BUFFERUSAGE_COPY_SRC,
  StorageBuffer,
  type GraphicsDevice,
} from 'playcanvas';

interface NativeGpuError {
  readonly message?: string;
}

interface NativeGpuDevice {
  readonly limits?: {
    readonly maxBufferSize?: number;
    readonly maxStorageBufferBindingSize?: number;
  };
  pushErrorScope(filter: 'out-of-memory'): void;
  popErrorScope(): Promise<NativeGpuError | null>;
}

interface WebGpuGraphicsDevice extends GraphicsDevice {
  readonly wgpu?: NativeGpuDevice;
  readonly limits?: NativeGpuDevice['limits'];
}

export interface GpuBufferAllocation {
  readonly id: string;
  readonly role: string;
  readonly byteSize: number;
  readonly chunks: readonly StorageBuffer[];
  readonly chunkByteSizes: readonly number[];
}

function align4(value: number): number {
  return Math.ceil(value / 4) * 4;
}

export class GpuBufferPool {
  private readonly allocations = new Map<string, GpuBufferAllocation>();
  private readonly reusableBuffers = new Map<number, StorageBuffer[]>();
  private nextId = 1;
  private activeAllocationBytes = 0;
  private reusableBufferBytes = 0;
  private committedBufferBytes = 0;
  private reuseCount = 0;
  private destroyed = false;

  constructor(
    private readonly device: GraphicsDevice,
    private budgetBytes: number,
    private preferredChunkBytes: number,
  ) {}

  get usedBytes(): number {
    return this.committedBufferBytes;
  }

  get activeBytes(): number {
    return this.activeAllocationBytes;
  }

  get cachedBytes(): number {
    return this.reusableBufferBytes;
  }

  get committedBytes(): number {
    return this.committedBufferBytes;
  }

  get reusedBufferCount(): number {
    return this.reuseCount;
  }

  get overBudgetBytes(): number {
    return Math.max(0, this.committedBufferBytes - this.budgetBytes);
  }

  get maxStorageBindingBytes(): number {
    const webgpu = this.device as WebGpuGraphicsDevice;
    return webgpu.wgpu?.limits?.maxStorageBufferBindingSize
      ?? webgpu.limits?.maxStorageBufferBindingSize
      ?? 128 * 1024 ** 2;
  }

  setBudget(budgetBytes: number, preferredChunkBytes: number): void {
    this.budgetBytes = Math.max(0, budgetBytes);
    this.preferredChunkBytes = Math.max(4, preferredChunkBytes);
    this.trimReusableBuffers();
  }

  canAllocateSingleBinding(byteSize: number): boolean {
    const alignedBytes = align4(byteSize);
    const reusable = (this.reusableBuffers.get(alignedBytes)?.length ?? 0) > 0;
    return alignedBytes <= this.maxStorageBindingBytes
      && this.committedBufferBytes + (reusable ? 0 : alignedBytes) <= this.budgetBytes;
  }

  async allocateBinding(role: string, requestedBytes: number): Promise<GpuBufferAllocation> {
    const byteSize = align4(requestedBytes);
    if (byteSize > this.maxStorageBindingBytes) {
      throw new Error(
        `${role} requires ${Math.ceil(byteSize / 1024 ** 2)} MiB but one storage binding is limited to `
        + `${Math.floor(this.maxStorageBindingBytes / 1024 ** 2)} MiB.`,
      );
    }
    return this.allocateChunks(role, [byteSize]);
  }

  async allocateChunked(role: string, requestedBytes: number): Promise<GpuBufferAllocation> {
    const webgpu = this.device as WebGpuGraphicsDevice;
    const maximumBufferBytes = webgpu.wgpu?.limits?.maxBufferSize
      ?? webgpu.limits?.maxBufferSize
      ?? this.maxStorageBindingBytes;
    const chunkBytes = Math.max(4, align4(Math.min(
      this.preferredChunkBytes,
      this.maxStorageBindingBytes,
      maximumBufferBytes,
    )));
    const sizes: number[] = [];
    for (let remaining = align4(requestedBytes); remaining > 0; remaining -= chunkBytes) {
      sizes.push(Math.min(remaining, chunkBytes));
    }
    return this.allocateChunks(role, sizes);
  }

  release(allocation: GpuBufferAllocation | null | undefined): void {
    if (!allocation || !this.allocations.delete(allocation.id)) return;
    this.activeAllocationBytes -= allocation.byteSize;
    allocation.chunks.forEach((buffer, index) => {
      const byteSize = allocation.chunkByteSizes[index];
      const bucket = this.reusableBuffers.get(byteSize) ?? [];
      bucket.push(buffer);
      this.reusableBuffers.set(byteSize, bucket);
      this.reusableBufferBytes += byteSize;
    });
    // #WDD-gpt 2026-08-15 - 释放后的 StorageBuffer 进入限额缓存，后续段落切换优先复用而不是反复申请显存。
    this.trimReusableBuffers(this.maximumReusableBytes());
  }

  trim(): void {
    this.trimReusableBuffers(0);
  }

  destroy(): void {
    if (this.destroyed) return;
    for (const allocation of this.allocations.values()) {
      for (const buffer of allocation.chunks) buffer.destroy();
      this.committedBufferBytes -= allocation.byteSize;
    }
    this.allocations.clear();
    this.activeAllocationBytes = 0;
    this.trimReusableBuffers(0);
    this.committedBufferBytes = 0;
    this.destroyed = true;
  }

  private async allocateChunks(role: string, chunkByteSizes: readonly number[]): Promise<GpuBufferAllocation> {
    if (this.destroyed) throw new Error('GPU buffer pool has been destroyed.');
    const byteSize = chunkByteSizes.reduce((total, size) => total + size, 0);
    const chunks: Array<StorageBuffer | null> = chunkByteSizes.map((size) => this.takeReusableBuffer(size));
    const newBufferBytes = chunks.reduce(
      (total, buffer, index) => total + (buffer ? 0 : chunkByteSizes[index]),
      0,
    );
    this.trimReusableBuffers(Math.max(0, this.budgetBytes - this.committedBufferBytes - newBufferBytes));
    if (this.committedBufferBytes + newBufferBytes > this.budgetBytes) {
      chunks.forEach((buffer, index) => {
        if (buffer) this.cacheBuffer(buffer, chunkByteSizes[index]);
      });
      throw new Error(
        `GPU memory budget exceeded while allocating ${role}: `
        + `${Math.ceil((this.activeAllocationBytes + byteSize) / 1024 ** 2)} MiB active data requested / `
        + `${Math.floor(this.budgetBytes / 1024 ** 2)} MiB budget.`,
      );
    }

    const nativeDevice = (this.device as WebGpuGraphicsDevice).wgpu;
    const createdIndices: number[] = [];
    try {
      for (let index = 0; index < chunkByteSizes.length; index += 1) {
        if (chunks[index]) {
          (chunks[index] as StorageBuffer & { name?: string }).name = `${role} [${index + 1}/${chunkByteSizes.length}]`;
          continue;
        }
        nativeDevice?.pushErrorScope('out-of-memory');
        let buffer: StorageBuffer | null = null;
        try {
          // #WDD-gpt 2026-08-15 - 所有大显存都从可计量、可释放的长期 Buffer 池分配，并捕获 WebGPU OOM。
          buffer = new StorageBuffer(
            this.device,
            chunkByteSizes[index],
            BUFFERUSAGE_COPY_DST | BUFFERUSAGE_COPY_SRC,
          );
          (buffer as StorageBuffer & { name?: string }).name = `${role} [${index + 1}/${chunkByteSizes.length}]`;
        } catch (error) {
          if (nativeDevice) await nativeDevice.popErrorScope();
          throw error;
        }
        const gpuError = nativeDevice ? await nativeDevice.popErrorScope() : null;
        if (gpuError) {
          buffer.destroy();
          throw new Error(`WebGPU out of memory while allocating ${role}: ${gpuError.message ?? 'unknown error'}`);
        }
        chunks[index] = buffer;
        createdIndices.push(index);
        this.committedBufferBytes += chunkByteSizes[index];
      }
    } catch (error) {
      for (const index of createdIndices) {
        chunks[index]?.destroy();
        this.committedBufferBytes -= chunkByteSizes[index];
        chunks[index] = null;
      }
      chunks.forEach((buffer, index) => {
        if (buffer) this.cacheBuffer(buffer, chunkByteSizes[index]);
      });
      throw error;
    }

    const allocation: GpuBufferAllocation = {
      id: `gpu-${this.nextId++}`,
      role,
      byteSize,
      chunks: chunks as StorageBuffer[],
      chunkByteSizes: [...chunkByteSizes],
    };
    this.allocations.set(allocation.id, allocation);
    this.activeAllocationBytes += byteSize;
    return allocation;
  }

  private takeReusableBuffer(byteSize: number): StorageBuffer | null {
    const bucket = this.reusableBuffers.get(byteSize);
    const buffer = bucket?.pop() ?? null;
    if (!buffer) return null;
    if (bucket?.length === 0) this.reusableBuffers.delete(byteSize);
    this.reusableBufferBytes -= byteSize;
    this.reuseCount += 1;
    return buffer;
  }

  private cacheBuffer(buffer: StorageBuffer, byteSize: number): void {
    const bucket = this.reusableBuffers.get(byteSize) ?? [];
    bucket.push(buffer);
    this.reusableBuffers.set(byteSize, bucket);
    this.reusableBufferBytes += byteSize;
  }

  private maximumReusableBytes(): number {
    return Math.min(Math.floor(this.budgetBytes * 0.25), this.preferredChunkBytes * 2);
  }

  private trimReusableBuffers(targetReusableBytes = Math.min(this.reusableBufferBytes, this.maximumReusableBytes())): void {
    const target = Math.max(0, targetReusableBytes);
    if (this.reusableBufferBytes <= target && this.committedBufferBytes <= this.budgetBytes) return;
    const buckets = [...this.reusableBuffers.entries()].sort(([left], [right]) => right - left);
    for (const [byteSize, buffers] of buckets) {
      while (buffers.length > 0 && (
        this.reusableBufferBytes > target || this.committedBufferBytes > this.budgetBytes
      )) {
        buffers.pop()!.destroy();
        this.reusableBufferBytes -= byteSize;
        this.committedBufferBytes -= byteSize;
      }
      if (buffers.length === 0) this.reusableBuffers.delete(byteSize);
      if (this.reusableBufferBytes <= target && this.committedBufferBytes <= this.budgetBytes) break;
    }
  }
}
