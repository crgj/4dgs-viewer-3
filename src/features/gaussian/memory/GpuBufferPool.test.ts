import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeBuffers, FakeStorageBuffer } = vi.hoisted(() => {
  class HoistedFakeStorageBuffer {
    destroyed = false;
    name = '';

    constructor(
      readonly device: unknown,
      readonly byteSize: number,
      readonly usage: number,
    ) {
      buffers.push(this);
    }

    destroy(): void {
      this.destroyed = true;
    }
  }
  const buffers: HoistedFakeStorageBuffer[] = [];
  return { fakeBuffers: buffers, FakeStorageBuffer: HoistedFakeStorageBuffer };
});

vi.mock('playcanvas', () => ({
  BUFFERUSAGE_COPY_DST: 1,
  BUFFERUSAGE_COPY_SRC: 2,
  StorageBuffer: FakeStorageBuffer,
}));

import { GpuBufferPool } from './GpuBufferPool';

function fakeDevice() {
  return {
    wgpu: {
      limits: { maxBufferSize: 1024, maxStorageBufferBindingSize: 1024 },
      pushErrorScope: vi.fn(),
      popErrorScope: vi.fn(async () => null),
    },
  };
}

describe('GpuBufferPool', () => {
  beforeEach(() => {
    fakeBuffers.length = 0;
  });

  it('reuses a released StorageBuffer with the same binding size', async () => {
    const pool = new GpuBufferPool(fakeDevice() as never, 1024, 256);
    const first = await pool.allocateBinding('current', 64);
    const firstBuffer = first.chunks[0];
    pool.release(first);

    expect(pool.activeBytes).toBe(0);
    expect(pool.cachedBytes).toBe(64);
    const second = await pool.allocateBinding('next', 64);

    expect(second.chunks[0]).toBe(firstBuffer);
    expect(pool.activeBytes).toBe(64);
    expect(pool.cachedBytes).toBe(0);
    expect(pool.committedBytes).toBe(64);
    expect(pool.reusedBufferCount).toBe(1);
  });

  it('destroys reusable buffers immediately when the budget is lowered', async () => {
    const pool = new GpuBufferPool(fakeDevice() as never, 1024, 256);
    const allocation = await pool.allocateBinding('segment', 128);
    const buffer = allocation.chunks[0] as unknown as (typeof fakeBuffers)[number];
    pool.release(allocation);

    pool.setBudget(0, 256);

    expect(buffer.destroyed).toBe(true);
    expect(pool.committedBytes).toBe(0);
    expect(pool.cachedBytes).toBe(0);
  });
});
