import { describe, expect, it } from 'vitest';
import type { GS2MeshData, GS2MeshGaussianFieldInput } from '../gs2mesh/GS2MeshTypes';
import { RelightingMeshSequence, type RelightingMeshHost, type RelightingMeshWorker } from './RelightingMeshSequence';

function input(frame: number, x: number): GS2MeshGaussianFieldInput {
  return {
    frame,
    focus: [0, 0, 0],
    boundsMin: [x, 0, 0],
    boundsMax: [x, 0, 0],
    positions: new Float32Array([x, 0, 0]),
    rotations: new Float32Array([0, 0, 0, 1]),
    scales: new Float32Array([0.1, 0.1, 0.1]),
    colors: new Uint8Array([255, 255, 255, 255]),
    opacities: new Float32Array([1]),
    views: [],
    fieldResolution: 96,
    isoLevel: 0.28,
  };
}

describe('RelightingMeshSequence', () => {
  it('passes every frame to reconstruction without temporal averaging', async () => {
    const observed: number[] = [];
    const mesh: GS2MeshData = {
      positions: new Float32Array([0, 0, 0]),
      normals: new Float32Array([0, 1, 0]),
      colors: new Uint8Array([255, 255, 255, 255]),
      indices: new Uint32Array(0),
    };
    const worker: RelightingMeshWorker = {
      reconstruct: async (frameInput, _signal, _progress, _preview, options) => {
        observed.push(frameInput.positions[0]);
        expect(options).toEqual({ perFrameDenseOnly: true });
        // 模拟真实 Worker 的 transferable 行为，提交后主线程 TypedArray 会被 detach。
        structuredClone(frameInput.positions.buffer, { transfer: [frameInput.positions.buffer] });
        return { mesh, backend: 'test-full-frame' };
      },
      cancel: () => undefined,
      dispose: () => undefined,
    };
    const host: RelightingMeshHost = {
      clearGS2Mesh: () => undefined,
      installRelightingMesh: () => ({ vertexCount: 1, triangleCount: 0 }),
      updateGS2MeshGeometry: () => ({ vertexCount: 1, triangleCount: 0 }),
      streamRelightingMeshFrames: async (_options, visitor) => {
        await visitor(input(0, 0), 1, 3);
        await visitor(input(1, 4), 2, 3);
        await visitor(input(2, 8), 3, 3);
      },
    };
    const states: Array<{ stage: string; gaussianCount?: number }> = [];
    await new RelightingMeshSequence(worker).generate(host, {
      frameStart: 0,
      frameEnd: 2,
      maxGaussians: 40_000,
      fieldResolution: 96,
      isoLevel: 0.28,
    }, (state) => states.push({ stage: state.stage, gaussianCount: state.gaussianCount }));
    expect(observed).toEqual([0, 4, 8]);
    expect(states.at(-1)).toEqual({ stage: 'success', gaussianCount: 1 });
  });
});
