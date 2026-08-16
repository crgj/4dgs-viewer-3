import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { GS2MeshGaussianFieldInput } from './GS2MeshTypes';
import {
  buildActiveBrickSlab,
  buildPreviewGaussianInput,
  buildSparseBrickBounds,
  computePartitionedWasmSurface,
  extractMarchingCubesPreview,
  extractOpacitySurface,
  extractSurfaceNetsPreview,
  requestGpuAdapterWithFallback,
  robustFieldBounds,
  smoothFeaturePreservingMesh,
  splatOpacityField,
  type GS2MeshOpacityCoreExports,
} from './gs2mesh-opacity.worker';

describe('GS2Mesh Gaussian opacity surface', () => {
  it('falls back to the automatic WebGPU adapter on hybrid-GPU browsers', async () => {
    const automaticAdapter = {} as GPUAdapter;
    const requestAdapter = vi.fn(async (options?: GPURequestAdapterOptions) => (
      options?.powerPreference === 'high-performance' ? null : automaticAdapter
    ));
    const adapter = await requestGpuAdapterWithFallback({ requestAdapter } as unknown as GPU);
    // #WDD-gpt 2026-08-15 - Reproduce browsers that expose WebGPU but return null only for the high-performance preference.
    expect(adapter).toBe(automaticAdapter);
    expect(requestAdapter).toHaveBeenCalledTimes(2);
    expect(requestAdapter.mock.calls[1][0]).toBeUndefined();
  });

  it('never lets metric calibration reduce the selected baseline topology', () => {
    const input: GS2MeshGaussianFieldInput = {
      frame: 0,
      focus: [0, 0, 0],
      boundsMin: [-0.01, -0.01, -0.01],
      boundsMax: [0.01, 0.01, 0.01],
      positions: new Float32Array([
        -0.01, -0.01, -0.01, 0.01, -0.01, -0.01,
        -0.01, 0.01, -0.01, 0.01, 0.01, -0.01,
        -0.01, -0.01, 0.01, 0.01, -0.01, 0.01,
        -0.01, 0.01, 0.01, 0.01, 0.01, 0.01,
      ]),
      rotations: new Float32Array(8 * 4),
      scales: new Float32Array(8 * 3).fill(0.001),
      colors: new Uint8Array(8 * 4).fill(180),
      opacities: new Float32Array(8).fill(0.9),
      views: [],
      fieldResolution: 96,
      isoLevel: 0.2,
      targetVoxelSize: 0.0005,
    };
    const bounds = robustFieldBounds(input, 96, 16_384, input.targetVoxelSize);
    // #WDD-gpt 2026-08-15 - Reproduce the small-scene regression that previously allowed metric mode to fall from 96³ to 48³.
    expect(Math.max(...bounds.dimensions)).toBeGreaterThanOrEqual(96);
    expect(bounds.spacing).toBeLessThanOrEqual(input.targetVoxelSize!);
  });

  it('bounds preview memory with a stratified copy while preserving spatial extrema', () => {
    const count = 20;
    const positions = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) {
      positions.set([index - 10, (index * 7) % 19 - 9, (index * 11) % 23 - 11], index * 3);
    }
    const input: GS2MeshGaussianFieldInput = {
      frame: 0,
      focus: [0, 0, 0],
      boundsMin: [-10, -9, -11],
      boundsMax: [9, 9, 11],
      positions,
      rotations: new Float32Array(count * 4),
      scales: new Float32Array(count * 3).fill(0.1),
      colors: new Uint8Array(count * 4).fill(180),
      opacities: new Float32Array(count).fill(0.9),
      views: [],
      fieldResolution: 1024,
      isoLevel: 0.2,
      targetVoxelSize: 0.002,
    };
    const preview = buildPreviewGaussianInput(input, 8);
    const axisRange = (values: Float32Array, axis: number): [number, number] => {
      const selected = Array.from({ length: values.length / 3 }, (_, index) => values[index * 3 + axis]);
      return [Math.min(...selected), Math.max(...selected)];
    };
    // #WDD-gpt 2026-08-15 - The preview cap must not crop an extremal body region or mutate the full metric input transferred to the Worker.
    expect(preview.positions.length / 3).toBe(8);
    expect(preview.fieldResolution).toBe(72);
    expect(preview.targetVoxelSize).toBeUndefined();
    expect(axisRange(preview.positions, 0)).toEqual(axisRange(input.positions, 0));
    expect(axisRange(preview.positions, 1)).toEqual(axisRange(input.positions, 1));
    expect(axisRange(preview.positions, 2)).toEqual(axisRange(input.positions, 2));
    expect(input.positions.length / 3).toBe(count);
  });

  it('streams thin anisotropic Gaussians as oriented slabs instead of a global max-scale cube', () => {
    const input: GS2MeshGaussianFieldInput = {
      frame: 0,
      focus: [0, 0, 0],
      boundsMin: [-0.25, -0.25, -0.25],
      boundsMax: [0.25, 0.25, 0.25],
      positions: new Float32Array([0, 0, 0]),
      rotations: new Float32Array([0, 0, 0, 1]),
      scales: new Float32Array([0.1, 0.1, 0.001]),
      colors: new Uint8Array([220, 160, 80, 255]),
      opacities: new Float32Array([0.95]),
      views: [],
      fieldResolution: 512,
      isoLevel: 0.2,
      targetVoxelSize: 0.001,
    };
    const bounds = buildSparseBrickBounds(input, input.fieldResolution);
    let activeBrickCount = 0;
    let maximumSlabBricks = 0;
    for (let z = 0; z < bounds.brickDimensions[2]; z += 1) {
      const slabBricks = buildActiveBrickSlab(input, bounds, z, z + 1).length / 4;
      activeBrickCount += slabBricks;
      maximumSlabBricks = Math.max(maximumSlabBricks, slabBricks);
    }
    const oldGlobalCubeCapacity = bounds.brickDimensions[0]
      * bounds.brickDimensions[1]
      * bounds.brickDimensions[2];
    // #WDD-gpt 2026-08-15 - Guard against recreating the million-brick global Set or expanding a flat splat by its largest scale on every axis.
    expect(activeBrickCount).toBeGreaterThan(0);
    expect(activeBrickCount).toBeLessThan(oldGlobalCubeCapacity / 8);
    expect(maximumSlabBricks).toBeLessThanOrEqual(bounds.brickDimensions[0] * bounds.brickDimensions[1]);
  });

  it('reduces local normal noise while respecting the half-voxel displacement guard', () => {
    const positions = new Float32Array([
      -1, -1, 0, 0, -1, 0, 1, -1, 0,
      -1, 0, 0, 0, 0, 0.24, 1, 0, 0,
      -1, 1, 0, 0, 1, 0, 1, 1, 0,
    ]);
    const indices = new Uint32Array([
      0, 1, 4, 0, 4, 3,
      1, 2, 5, 1, 5, 4,
      3, 4, 7, 3, 7, 6,
      4, 5, 8, 4, 8, 7,
    ]);
    const colors = new Uint8Array(9 * 4).fill(255);
    const smoothed = smoothFeaturePreservingMesh({ positions, normals: null, colors, indices }, 1, 3);
    // #WDD-gpt 2026-08-15 - Guard the browser bilateral smoother against both no-op regressions and excessive metric drift.
    expect(smoothed.positions[14]).toBeLessThan(positions[14]);
    for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
      const offset = vertex * 3;
      expect(Math.hypot(
        smoothed.positions[offset] - positions[offset],
        smoothed.positions[offset + 1] - positions[offset + 1],
        smoothed.positions[offset + 2] - positions[offset + 2],
      )).toBeLessThanOrEqual(0.500001);
    }
    expect([...smoothed.normals!].every(Number.isFinite)).toBe(true);
  });

  it('extracts a closed colored surface from a direct Gaussian field', async () => {
    const bytes = await readFile(resolve('src/plugins/gs2mesh/wasm/gs2mesh_core.wasm'));
    const result = await WebAssembly.instantiate(bytes, {});
    const core = result.instance.exports as GS2MeshOpacityCoreExports;
    const input: GS2MeshGaussianFieldInput = {
      frame: 0,
      focus: [0, 0, 0],
      boundsMin: [-1, -1, -1],
      boundsMax: [1, 1, 1],
      positions: new Float32Array([0, 0, 0]),
      rotations: new Float32Array([0, 0, 0, 1]),
      scales: new Float32Array([0.8, 0.6, 0.45]),
      colors: new Uint8Array([220, 80, 40, 255]),
      opacities: new Float32Array([0.95]),
      views: [{
        position: [0, 0, 3],
        right: [1, 0, 0],
        up: [0, 1, 0],
        forward: [0, 0, -1],
        tanHalfFovX: 1,
        tanHalfFovY: 1,
      }],
      fieldResolution: 48,
      isoLevel: 0.2,
    };
    // #WDD-gpt 2026-08-15 - Exercise the complete WASM field to Marching Tetrahedra path without relying on stereo images.
    const field = splatOpacityField(core, input, 1);
    const preview = extractMarchingCubesPreview(field, input);
    expect(preview.positions.length / 3).toBeGreaterThan(100);
    expect(preview.indices.length / 3).toBeGreaterThan(100);
    // #WDD-gpt 2026-08-15 - Validate the loading-stage standard Marching Cubes mesh before the refinement path.
    expect([...preview.normals!].every(Number.isFinite)).toBe(true);
    const boundedPreview = extractSurfaceNetsPreview(field, input);
    expect(boundedPreview.positions.length / 3).toBeGreaterThan(100);
    expect([...boundedPreview.normals!].every(Number.isFinite)).toBe(true);
    const mesh = extractOpacitySurface(field, input, 1);
    expect(mesh.positions.length / 3).toBeGreaterThan(100);
    expect(mesh.indices.length / 3).toBeGreaterThan(100);
    expect([...mesh.positions].every(Number.isFinite)).toBe(true);
    expect(mesh.colors[0]).toBe(220);
    const edgeCounts = new Map<string, number>();
    for (let offset = 0; offset < mesh.indices.length; offset += 3) {
      for (const [left, right] of [[0, 1], [1, 2], [2, 0]] as const) {
        const a = mesh.indices[offset + left];
        const b = mesh.indices[offset + right];
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
      }
    }
    expect([...edgeCounts.values()].every((count) => count === 2)).toBe(true);
    const partitioned = await computePartitionedWasmSurface(core, input, 64, 1);
    // #WDD-gpt 2026-08-15 - Exercise the true-resolution streamed fallback used when a browser Worker cannot obtain any WebGPU adapter.
    expect(partitioned.backend).toContain('WASM Gaussian alpha wrap');
    expect(partitioned.activeBrickCount).toBeGreaterThan(0);
    expect(partitioned.mesh.positions.length / 3).toBeGreaterThan(100);
    expect(partitioned.mesh.indices.length / 3).toBeGreaterThan(100);
    expect([...partitioned.mesh.positions].every(Number.isFinite)).toBe(true);
  });

  it('builds one connected alpha wrap across a narrow gap without dropping either side', async () => {
    const bytes = await readFile(resolve('src/plugins/gs2mesh/wasm/gs2mesh_core.wasm'));
    const result = await WebAssembly.instantiate(bytes, {});
    const core = result.instance.exports as GS2MeshOpacityCoreExports;
    const input: GS2MeshGaussianFieldInput = {
      frame: 0,
      focus: [0, 0, 0],
      boundsMin: [-0.1, -0.1, -0.1],
      boundsMax: [0.1, 0.1, 0.1],
      positions: new Float32Array([-0.04, 0, 0, 0.04, 0, 0]),
      rotations: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]),
      scales: new Float32Array([0.02, 0.05, 0.05, 0.02, 0.05, 0.05]),
      colors: new Uint8Array([220, 80, 40, 255, 40, 120, 220, 255]),
      opacities: new Float32Array([0.95, 0.95]),
      views: [],
      fieldResolution: 64,
      isoLevel: 0.2,
    };
    const wrapped = await computePartitionedWasmSurface(core, input, 64, 1);
    const vertexCount = wrapped.mesh.positions.length / 3;
    const parent = new Uint32Array(vertexCount);
    for (let vertex = 0; vertex < vertexCount; vertex += 1) parent[vertex] = vertex;
    const find = (value: number): number => {
      while (parent[value] !== value) {
        parent[value] = parent[parent[value]];
        value = parent[value];
      }
      return value;
    };
    const union = (first: number, second: number): void => {
      const firstRoot = find(first);
      const secondRoot = find(second);
      if (firstRoot !== secondRoot) parent[secondRoot] = firstRoot;
    };
    for (let offset = 0; offset < wrapped.mesh.indices.length; offset += 3) {
      union(wrapped.mesh.indices[offset], wrapped.mesh.indices[offset + 1]);
      union(wrapped.mesh.indices[offset], wrapped.mesh.indices[offset + 2]);
    }
    const usedRoots = new Set<number>();
    for (const index of wrapped.mesh.indices) usedRoots.add(find(index));
    const xCoordinates = Array.from({ length: vertexCount }, (_, vertex) => wrapped.mesh.positions[vertex * 3]);
    // #WDD-gpt 2026-08-15 - Guard the envelope strategy against reconnecting a gap by deleting one of the two source regions.
    expect(usedRoots.size).toBe(1);
    expect(Math.min(...xCoordinates)).toBeLessThan(-0.04);
    expect(Math.max(...xCoordinates)).toBeGreaterThan(0.04);
  });
});
