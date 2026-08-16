import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface TestCore extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  readonly reset: () => void;
  readonly alloc: (bytes: number) => number;
  readonly census: (gray: number, output: number, width: number, height: number) => void;
  readonly stereo_match_grid: (...parameters: number[]) => void;
  readonly opacity_splat: (...parameters: number[]) => void;
}

describe('GS2Mesh WASM core', () => {
  it('computes Census descriptors and bidirectionally consistent disparity', async () => {
    const bytes = await readFile(resolve('src/plugins/gs2mesh/wasm/gs2mesh_core.wasm'));
    const result = await WebAssembly.instantiate(bytes, {});
    const core = result.instance.exports as TestCore;
    const width = 72;
    const height = 32;
    const pixels = width * height;
    const expectedDisparity = 6;
    const left = new Uint8Array(pixels);
    const right = new Uint8Array(pixels);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        left[y * width + x] = (x * 19 + y * 37 + ((x * y) % 29) * 7) & 255;
      }
    }
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width - expectedDisparity; x += 1) {
        right[y * width + x] = left[y * width + x + expectedDisparity];
      }
    }
    core.reset();
    const leftPointer = core.alloc(pixels);
    const rightPointer = core.alloc(pixels);
    const foregroundPointer = core.alloc(pixels);
    const leftCensusPointer = core.alloc(pixels * 4);
    const rightCensusPointer = core.alloc(pixels * 4);
    const outputPointer = core.alloc(2);
    const heap = new Uint8Array(core.memory.buffer);
    heap.set(left, leftPointer);
    heap.set(right, rightPointer);
    heap.fill(1, foregroundPointer, foregroundPointer + pixels);
    core.census(leftPointer, leftCensusPointer, width, height);
    core.census(rightPointer, rightCensusPointer, width, height);
    core.stereo_match_grid(
      leftCensusPointer,
      rightCensusPointer,
      foregroundPointer,
      width,
      height,
      44,
      16,
      1,
      1,
      1,
      1,
      12,
      outputPointer,
    );
    expect(new Uint16Array(core.memory.buffer, outputPointer, 1)[0]).toBe(expectedDisparity);
  });

  it('accumulates an anisotropic opacity field and records the dominant Gaussian', async () => {
    const bytes = await readFile(resolve('src/plugins/gs2mesh/wasm/gs2mesh_core.wasm'));
    const result = await WebAssembly.instantiate(bytes, {});
    const core = result.instance.exports as TestCore;
    const dimension = 5;
    const voxelCount = dimension ** 3;
    core.reset();
    const fieldPointer = core.alloc(voxelCount * 4);
    const bestPointer = core.alloc(voxelCount * 4);
    const winnerPointer = core.alloc(voxelCount * 4);
    const field = new Float32Array(core.memory.buffer, fieldPointer, voxelCount);
    const winner = new Uint32Array(core.memory.buffer, winnerPointer, voxelCount);
    // #WDD-gpt 2026-08-15 - Verify that repeated Gaussian splats use front-to-back opacity union instead of raw density addition.
    const parameters = [
      fieldPointer, bestPointer, winnerPointer,
      dimension, dimension,
      0, 4, 0, 4, 0, 4,
      2, 2, 2,
      1, 0, 0, 0, 1, 0, 0, 0, 1,
      0.8, 7,
    ];
    core.opacity_splat(...parameters);
    const center = (2 * dimension + 2) * dimension + 2;
    expect(field[center]).toBeCloseTo(0.8, 5);
    expect(winner[center]).toBe(7);
    expect(field[center + 1]).toBeGreaterThan(0);
    expect(field[center + 1]).toBeLessThan(field[center]);
    core.opacity_splat(...parameters);
    expect(field[center]).toBeCloseTo(0.96, 5);
  });
});
