import { describe, expect, it, vi } from 'vitest';
import type {
  GS2MeshData,
  GS2MeshGaussianFieldInput,
  GS2MeshHost,
  GS2MeshState,
} from './GS2MeshTypes';

const preview: GS2MeshData = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  colors: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]),
  indices: new Uint32Array([0, 1, 2]),
};

vi.mock('./GS2MeshOpacityWorkerClient', () => ({
  GS2MeshOpacityWorkerClient: class {
    async reconstruct(
      _input: GS2MeshGaussianFieldInput,
      _signal: AbortSignal,
      _onProgress: () => void,
      onPreview: (mesh: GS2MeshData, backend: string, elapsedMs: number) => void,
    ): Promise<never> {
      onPreview(preview, 'WASM preview', 12);
      throw new Error('精细表面超过浏览器安全内存预算。');
    }

    cancel(): void {}
    dispose(): void {}
  },
}));

import { GS2MeshPlugin } from './GS2MeshPlugin';

function capture(): GS2MeshGaussianFieldInput {
  return {
    frame: 7,
    focus: [0, 0, 0],
    boundsMin: [-1, -1, -1],
    boundsMax: [1, 1, 1],
    positions: new Float32Array([0, 0, 0]),
    rotations: new Float32Array([0, 0, 0, 1]),
    scales: new Float32Array([0.1, 0.1, 0.1]),
    colors: new Uint8Array([255, 255, 255, 255]),
    opacities: new Float32Array([0.9]),
    views: [],
    fieldResolution: 96,
    isoLevel: 0.28,
  };
}

describe('GS2MeshPlugin refinement recovery', () => {
  it('keeps a completed preview exportable when background refinement fails', async () => {
    const clearGS2Mesh = vi.fn();
    const installGS2Mesh = vi.fn(() => ({ vertexCount: 3, triangleCount: 1 }));
    const host = {
      captureGS2MeshGaussians: vi.fn(async () => capture()),
      installGS2Mesh,
      clearGS2Mesh,
      setGS2MeshVisible: vi.fn(),
    } as unknown as GS2MeshHost;
    const states: GS2MeshState[] = [];
    const plugin = new GS2MeshPlugin();
    await plugin.reconstruct(host, {
      fieldResolution: 96,
      isoLevel: 0.28,
      maxGaussians: 80_000,
      viewCount: 8,
      sceneUnitMillimeters: 1000,
      targetVoxelMillimeters: 0.5,
      smoothingIterations: 3,
    }, (state) => states.push(state));
    // #WDD-gpt 2026-08-15 - Refinement failure must no longer delete the preview that relighting and PLY export can already consume.
    expect(clearGS2Mesh).not.toHaveBeenCalled();
    expect(installGS2Mesh).toHaveBeenCalledWith(preview);
    expect(plugin.canExport).toBe(true);
    expect(states.at(-1)).toMatchObject({
      stage: 'success',
      frame: 7,
      vertexCount: 3,
      triangleCount: 1,
    });
    expect(states.at(-1)?.warning).toMatch(/可导出、可重光照/);
  });
});
