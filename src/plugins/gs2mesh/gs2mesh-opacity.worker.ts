import wasmUrl from './wasm/gs2mesh_core.wasm?url';
import { marchingCubes, surfaceNets } from 'isosurface';
import type { GS2MeshData, GS2MeshGaussianFieldInput } from './GS2MeshTypes';
import type {
  GS2MeshOpacityWorkerRequest,
  GS2MeshOpacityWorkerResponse,
  GS2MeshOpacityWorkerStage,
} from './GS2MeshOpacityWorkerProtocol';

export interface GS2MeshOpacityCoreExports extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  readonly reset: () => void;
  readonly alloc: (bytes: number) => number;
  readonly opacity_splat: (
    field: number,
    best: number,
    winner: number,
    dimX: number,
    dimY: number,
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
    minZ: number,
    maxZ: number,
    centerX: number,
    centerY: number,
    centerZ: number,
    a00: number,
    a01: number,
    a02: number,
    a10: number,
    a11: number,
    a12: number,
    a20: number,
    a21: number,
    a22: number,
    opacity: number,
    gaussianId: number,
  ) => void;
}

export interface FieldGrid {
  readonly field: Float32Array;
  readonly winner: Uint32Array;
  readonly dimX: number;
  readonly dimY: number;
  readonly dimZ: number;
  readonly minimum: readonly [number, number, number];
  readonly spacing: number;
}

interface SparsePreviewField extends FieldGrid {
  readonly backend: string;
}

interface SparseGaussianData {
  readonly gaussians: Float32Array;
  readonly blockOffsets: Uint32Array;
  readonly blockGaussianIds: Uint32Array;
  readonly blockDimensions: readonly [number, number, number];
  readonly blockSize: number;
}

interface VisualHullData {
  readonly views: Float32Array;
  readonly masks: Uint32Array;
  readonly resolution: number;
  readonly viewCount: number;
}

interface WorkerReconstructionResult {
  readonly mesh: GS2MeshData;
  readonly backend: string;
}

interface GofSurfaceExtraction {
  readonly mesh: GS2MeshData;
  readonly brackets: Float32Array;
}

export interface SparseBrickBounds {
  readonly dimensions: readonly [number, number, number];
  readonly brickDimensions: readonly [number, number, number];
  readonly minimum: readonly [number, number, number];
  readonly spacing: number;
  readonly brickSize: number;
}

interface SparsePartitionExtraction extends GofSurfaceExtraction {
  readonly backend: string;
  readonly spacing: number;
  readonly activeBrickCount: number;
}

interface CrossingVertex {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

const workerScope = typeof self === 'undefined' ? null : self as DedicatedWorkerGlobalScope;
const TETRAHEDRA = [
  [0, 5, 1, 6],
  [0, 1, 2, 6],
  [0, 2, 3, 6],
  [0, 3, 7, 6],
  [0, 7, 4, 6],
  [0, 4, 5, 6],
] as const;
const TETRA_EDGES = [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]] as const;
const CORNERS = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
] as const;
const MAX_DENSE_TOPOLOGY_RESOLUTION = 160;
const MAX_SPARSE_FIELD_RESOLUTION = 1024;
const MAX_METRIC_AXIS_RESOLUTION = 16_384;
const MAX_PROJECTED_TRIANGLES = 4_000_000;
const MAX_WASM_FINAL_TRIANGLES = 12_000_000;
const MAX_SAFE_JS_ACCUMULATED_TRIANGLES = 1_250_000;
const PREVIEW_FIELD_RESOLUTION = 72;
const PREVIEW_GAUSSIAN_LIMIT = 12_000;
const SPARSE_BRICK_SIZE = 16;
const SPARSE_BRICK_BATCH_SIZE = 24;
const SPARSE_BRICK_SLAB_DEPTH = 1;
const GAUSSIAN_SUPPORT_SIGMA = 3.5;
const GOF_REFINEMENT_BATCH_VERTICES = 65_536;

class BrowserTopologyBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserTopologyBudgetError';
  }
}

function topologyResolutionFor(requestedResolution: number): number {
  const clamped = Math.max(48, Math.min(MAX_SPARSE_FIELD_RESOLUTION, requestedResolution));
  // #WDD-gpt 2026-08-15 - High brick modes only use this bounded value for auxiliary ray-tile packing and fallback paths.
  return clamped > MAX_DENSE_TOPOLOGY_RESOLUTION ? 128 : clamped;
}

let corePromise: Promise<GS2MeshOpacityCoreExports> | null = null;
let gpuAdapterPromise: Promise<GPUAdapter | null> | null = null;

export async function requestGpuAdapterWithFallback(gpu: GPU): Promise<GPUAdapter | null> {
  const highPerformance = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (highPerformance) return highPerformance;
  const automatic = await gpu.requestAdapter();
  if (automatic) return automatic;
  return gpu.requestAdapter({ powerPreference: 'low-power' });
}

function post(message: GS2MeshOpacityWorkerResponse, transfer: Transferable[] = []): void {
  workerScope?.postMessage(message, transfer);
}

function report(requestId: number, stage: GS2MeshOpacityWorkerStage, progress: number): void {
  post({ type: 'progress', requestId, stage, progress });
}

async function loadCore(): Promise<GS2MeshOpacityCoreExports> {
  corePromise ??= (async () => {
    const response = await fetch(wasmUrl);
    if (!response.ok) throw new Error(`无法加载 GS2Mesh WASM 不透明度核心（HTTP ${response.status}）。`);
    const result = await WebAssembly.instantiate(await response.arrayBuffer(), {});
    return result.instance.exports as GS2MeshOpacityCoreExports;
  })();
  return corePromise;
}

async function requestReusableGpuAdapter(forceRefresh = false): Promise<GPUAdapter> {
  const gpu = navigator.gpu;
  if (!gpu) throw new Error('当前浏览器未提供 WebGPU。');
  if (forceRefresh) gpuAdapterPromise = null;
  // #WDD-gpt 2026-08-15 - Some hybrid-GPU drivers reject an explicit high-performance preference even though their default adapter is usable.
  gpuAdapterPromise ??= requestGpuAdapterWithFallback(gpu);
  const adapter = await gpuAdapterPromise;
  if (!adapter) {
    gpuAdapterPromise = null;
    throw new Error('无法取得 WebGPU 适配器。请确认浏览器已启用硬件加速和 WebGPU。');
  }
  return adapter;
}

async function requestReusableGpuDevice(): Promise<GPUDevice> {
  try {
    return await (await requestReusableGpuAdapter()).requestDevice();
  } catch (error) {
    gpuAdapterPromise = null;
    try {
      return await (await requestReusableGpuAdapter(true)).requestDevice();
    } catch {
      throw error;
    }
  }
}

function quantile(values: number[], fraction: number): number {
  values.sort((left, right) => left - right);
  return values[Math.max(0, Math.min(values.length - 1, Math.round((values.length - 1) * fraction)))];
}

export function robustFieldBounds(
  input: GS2MeshGaussianFieldInput,
  resolution = input.fieldResolution,
  maximumResolution = MAX_DENSE_TOPOLOGY_RESOLUTION,
  requestedSpacing?: number,
): {
  minimum: [number, number, number];
  dimensions: [number, number, number];
  spacing: number;
} {
  const count = input.positions.length / 3;
  const stride = Math.max(1, Math.ceil(count / 30_000));
  const axes: [number[], number[], number[]] = [[], [], []];
  const sampledScales: number[] = [];
  for (let index = 0; index < count; index += stride) {
    const offset = index * 3;
    axes[0].push(input.positions[offset]);
    axes[1].push(input.positions[offset + 1]);
    axes[2].push(input.positions[offset + 2]);
    sampledScales.push(Math.max(input.scales[offset], input.scales[offset + 1], input.scales[offset + 2]));
  }
  const low: [number, number, number] = [
    quantile(axes[0], 0.002),
    quantile(axes[1], 0.002),
    quantile(axes[2], 0.002),
  ];
  const high: [number, number, number] = [
    quantile(axes[0], 0.998),
    quantile(axes[1], 0.998),
    quantile(axes[2], 0.998),
  ];
  const medianScale = quantile(sampledScales, 0.5);
  const rawSpans = high.map((value, axis) => Math.max(1e-5, value - low[axis]));
  const longestRawSpan = Math.max(...rawSpans);
  const padding = Math.max(longestRawSpan * 0.025, medianScale * 2.5, 1e-5);
  const minimum: [number, number, number] = [
    low[0] - padding,
    low[1] - padding,
    low[2] - padding,
  ];
  const spans = high.map((value, axis) => value + padding - minimum[axis]);
  const longestSpan = Math.max(...spans);
  // #WDD-gpt 2026-08-15 - Dense callers remain capped, while sparse brick planning can request the true virtual resolution through 1024³.
  const metricSpacing = Number.isFinite(requestedSpacing) && requestedSpacing! > 0
    ? Math.max(1e-8, requestedSpacing!)
    : null;
  const targetResolution = metricSpacing === null
    ? Math.max(48, Math.min(maximumResolution, resolution))
    : Math.max(48, Math.min(
      maximumResolution,
      Math.max(resolution, Math.ceil(longestSpan / metricSpacing) + 1),
    ));
  // #WDD-gpt 2026-08-15 - Metric spacing may refine the selected baseline but can never reduce its topology resolution.
  const spacing = longestSpan / Math.max(1, targetResolution - 1);
  const dimensions: [number, number, number] = [
    Math.max(24, Math.min(targetResolution, Math.ceil(spans[0] / spacing) + 1)),
    Math.max(24, Math.min(targetResolution, Math.ceil(spans[1] / spacing) + 1)),
    Math.max(24, Math.min(targetResolution, Math.ceil(spans[2] / spacing) + 1)),
  ];
  return { minimum, dimensions, spacing };
}

export function buildPreviewGaussianInput(
  input: GS2MeshGaussianFieldInput,
  maximumGaussians = PREVIEW_GAUSSIAN_LIMIT,
): GS2MeshGaussianFieldInput {
  const count = input.positions.length / 3;
  const targetCount = Math.max(1, Math.min(count, Math.round(maximumGaussians)));
  if (targetCount === count && input.fieldResolution === PREVIEW_FIELD_RESOLUTION) return input;
  const selected = new Set<number>();
  if (count > 0) {
    const extremes = [0, 0, 0, 0, 0, 0];
    for (let index = 1; index < count; index += 1) {
      const offset = index * 3;
      if (input.positions[offset] < input.positions[extremes[0] * 3]) extremes[0] = index;
      if (input.positions[offset] > input.positions[extremes[1] * 3]) extremes[1] = index;
      if (input.positions[offset + 1] < input.positions[extremes[2] * 3 + 1]) extremes[2] = index;
      if (input.positions[offset + 1] > input.positions[extremes[3] * 3 + 1]) extremes[3] = index;
      if (input.positions[offset + 2] < input.positions[extremes[4] * 3 + 2]) extremes[4] = index;
      if (input.positions[offset + 2] > input.positions[extremes[5] * 3 + 2]) extremes[5] = index;
    }
    for (const index of extremes) {
      if (selected.size >= targetCount) break;
      selected.add(index);
    }
    for (let cursor = 0; selected.size < targetCount && cursor < count * 2; cursor += 1) {
      selected.add(Math.min(count - 1, Math.floor((cursor + 0.5) * count / targetCount) % count));
    }
    for (let index = 0; selected.size < targetCount && index < count; index += 1) selected.add(index);
  }
  const indices = [...selected].sort((left, right) => left - right);
  const positions = new Float32Array(indices.length * 3);
  const rotations = new Float32Array(indices.length * 4);
  const scales = new Float32Array(indices.length * 3);
  const colors = new Uint8Array(indices.length * 4);
  const opacities = new Float32Array(indices.length);
  for (let target = 0; target < indices.length; target += 1) {
    const source = indices[target];
    positions.set(input.positions.subarray(source * 3, source * 3 + 3), target * 3);
    rotations.set(input.rotations.subarray(source * 4, source * 4 + 4), target * 4);
    scales.set(input.scales.subarray(source * 3, source * 3 + 3), target * 3);
    colors.set(input.colors.subarray(source * 4, source * 4 + 4), target * 4);
    opacities[target] = input.opacities[source];
  }
  // #WDD-gpt 2026-08-15 - The loading preview owns a small stratified copy with all six spatial extrema; the full transferred frame remains untouched for metric reconstruction.
  return {
    ...input,
    positions,
    rotations,
    scales,
    colors,
    opacities,
    fieldResolution: PREVIEW_FIELD_RESOLUTION,
    targetVoxelMillimeters: undefined,
    targetVoxelSize: undefined,
  };
}

export function buildSparseBrickBounds(
  input: GS2MeshGaussianFieldInput,
  requestedResolution: number,
): SparseBrickBounds {
  const { minimum, dimensions, spacing } = robustFieldBounds(
    input,
    requestedResolution,
    input.targetVoxelSize ? MAX_METRIC_AXIS_RESOLUTION : MAX_SPARSE_FIELD_RESOLUTION,
    input.targetVoxelSize,
  );
  const brickDimensions = dimensions.map((dimension) => Math.ceil((dimension - 1) / SPARSE_BRICK_SIZE)) as [number, number, number];
  return { dimensions, brickDimensions, minimum, spacing, brickSize: SPARSE_BRICK_SIZE };
}

export function buildActiveBrickSlab(
  input: GS2MeshGaussianFieldInput,
  bounds: SparseBrickBounds,
  slabStartZ: number,
  slabEndZ: number,
  onBrickGaussian?: (brickId: number, gaussianId: number) => void,
  wrapRadius = 0,
): Uint32Array {
  const { brickDimensions, minimum, spacing } = bounds;
  const firstZ = Math.max(0, Math.min(brickDimensions[2], Math.floor(slabStartZ)));
  const endZ = Math.max(firstZ, Math.min(brickDimensions[2], Math.ceil(slabEndZ)));
  const active = new Set<number>();
  const addBrick = (x: number, y: number, z: number, gaussianId: number): void => {
    if (x < 0 || y < 0 || z < firstZ
      || x >= brickDimensions[0] || y >= brickDimensions[1] || z >= brickDimensions[2]) return;
    if (z >= endZ) return;
    const brickId = (z * brickDimensions[1] + y) * brickDimensions[0] + x;
    active.add(brickId);
    onBrickGaussian?.(brickId, gaussianId);
  };
  const halfBrick = bounds.brickSize * spacing * 0.5;
  const supportSquared = GAUSSIAN_SUPPORT_SIGMA ** 2;
  const count = input.positions.length / 3;
  for (let gaussianIndex = 0; gaussianIndex < count; gaussianIndex += 1) {
    const offset = gaussianIndex * 3;
    const centerX = input.positions[offset];
    const centerY = input.positions[offset + 1];
    const centerZ = input.positions[offset + 2];
    const scaleX = Math.max(1e-7, Math.hypot(input.scales[offset], wrapRadius));
    const scaleY = Math.max(1e-7, Math.hypot(input.scales[offset + 1], wrapRadius));
    const scaleZ = Math.max(1e-7, Math.hypot(input.scales[offset + 2], wrapRadius));
    const rotationOffset = gaussianIndex * 4;
    const rawX = input.rotations[rotationOffset];
    const rawY = input.rotations[rotationOffset + 1];
    const rawZ = input.rotations[rotationOffset + 2];
    const rawW = input.rotations[rotationOffset + 3];
    const inverseLength = 1 / Math.max(1e-12, Math.hypot(rawX, rawY, rawZ, rawW));
    const x = rawX * inverseLength;
    const y = rawY * inverseLength;
    const z = rawZ * inverseLength;
    const w = rawW * inverseLength;
    const r00 = 1 - 2 * (y * y + z * z);
    const r01 = 2 * (x * y - z * w);
    const r02 = 2 * (x * z + y * w);
    const r10 = 2 * (x * y + z * w);
    const r11 = 1 - 2 * (x * x + z * z);
    const r12 = 2 * (y * z - x * w);
    const r20 = 2 * (x * z - y * w);
    const r21 = 2 * (y * z + x * w);
    const r22 = 1 - 2 * (x * x + y * y);
    const radiusX = GAUSSIAN_SUPPORT_SIGMA * Math.hypot(r00 * scaleX, r01 * scaleY, r02 * scaleZ);
    const radiusY = GAUSSIAN_SUPPORT_SIGMA * Math.hypot(r10 * scaleX, r11 * scaleY, r12 * scaleZ);
    const radiusZ = GAUSSIAN_SUPPORT_SIGMA * Math.hypot(r20 * scaleX, r21 * scaleY, r22 * scaleZ);
    const voxelX = (centerX - minimum[0]) / spacing;
    const voxelY = (centerY - minimum[1]) / spacing;
    const voxelZ = (centerZ - minimum[2]) / spacing;
    const minBrickX = Math.max(0, Math.floor((voxelX - radiusX / spacing) / bounds.brickSize));
    const maxBrickX = Math.min(brickDimensions[0] - 1, Math.floor((voxelX + radiusX / spacing) / bounds.brickSize));
    const minBrickY = Math.max(0, Math.floor((voxelY - radiusY / spacing) / bounds.brickSize));
    const maxBrickY = Math.min(brickDimensions[1] - 1, Math.floor((voxelY + radiusY / spacing) / bounds.brickSize));
    const minBrickZ = Math.max(firstZ, Math.floor((voxelZ - radiusZ / spacing) / bounds.brickSize));
    const maxBrickZ = Math.min(endZ - 1, Math.floor((voxelZ + radiusZ / spacing) / bounds.brickSize));
    if (minBrickX > maxBrickX || minBrickY > maxBrickY || minBrickZ > maxBrickZ) continue;
    const localHalfX = halfBrick * (Math.abs(r00) + Math.abs(r10) + Math.abs(r20)) / scaleX;
    const localHalfY = halfBrick * (Math.abs(r01) + Math.abs(r11) + Math.abs(r21)) / scaleY;
    const localHalfZ = halfBrick * (Math.abs(r02) + Math.abs(r12) + Math.abs(r22)) / scaleZ;
    for (let z = minBrickZ; z <= maxBrickZ; z += 1) {
      for (let y = minBrickY; y <= maxBrickY; y += 1) {
        for (let x = minBrickX; x <= maxBrickX; x += 1) {
          const brickCenterX = minimum[0] + (x * bounds.brickSize + bounds.brickSize * 0.5) * spacing;
          const brickCenterY = minimum[1] + (y * bounds.brickSize + bounds.brickSize * 0.5) * spacing;
          const brickCenterZ = minimum[2] + (z * bounds.brickSize + bounds.brickSize * 0.5) * spacing;
          const deltaX = brickCenterX - centerX;
          const deltaY = brickCenterY - centerY;
          const deltaZ = brickCenterZ - centerZ;
          const localX = (deltaX * r00 + deltaY * r10 + deltaZ * r20) / scaleX;
          const localY = (deltaX * r01 + deltaY * r11 + deltaZ * r21) / scaleY;
          const localZ = (deltaX * r02 + deltaY * r12 + deltaZ * r22) / scaleZ;
          const distanceX = Math.max(0, Math.abs(localX) - localHalfX);
          const distanceY = Math.max(0, Math.abs(localY) - localHalfY);
          const distanceZ = Math.max(0, Math.abs(localZ) - localHalfZ);
          // #WDD-gpt 2026-08-15 - Reject empty corners of the old max-scale cube using the rotated 3.5-sigma ellipsoid while conservatively retaining intersecting bricks.
          if (distanceX * distanceX + distanceY * distanceY + distanceZ * distanceZ <= supportSquared) {
            addBrick(x, y, z, gaussianIndex);
          }
        }
      }
    }
  }
  const sorted = [...active].sort((left, right) => left - right);
  const origins = new Uint32Array(sorted.length * 4);
  const plane = brickDimensions[0] * brickDimensions[1];
  for (let index = 0; index < sorted.length; index += 1) {
    const id = sorted[index];
    const z = Math.floor(id / plane);
    const remainder = id - z * plane;
    const y = Math.floor(remainder / brickDimensions[0]);
    const x = remainder - y * brickDimensions[0];
    origins.set([x * bounds.brickSize, y * bounds.brickSize, z * bounds.brickSize, 0], index * 4);
  }
  // #WDD-gpt 2026-08-15 - The caller owns only this Z slab's registry; it is discarded immediately after its GPU batches are extracted.
  return origins;
}

function pinFieldBorder(field: Float32Array, dimX: number, dimY: number, dimZ: number): void {
  // #WDD-gpt 2026-08-15 - Pin every volume face to empty so preview and refined surfaces close at the reconstruction bounds.
  for (let z = 0; z < dimZ; z += 1) {
    for (let y = 0; y < dimY; y += 1) {
      const row = (z * dimY + y) * dimX;
      field[row] = 0;
      field[row + dimX - 1] = 0;
    }
    if (z === 0 || z === dimZ - 1) {
      field.fill(0, z * dimY * dimX, (z + 1) * dimY * dimX);
    } else {
      field.fill(0, z * dimY * dimX, z * dimY * dimX + dimX);
      field.fill(0, (z * dimY + dimY - 1) * dimX, (z + 1) * dimY * dimX);
    }
  }
}

function effectiveScales(
  input: GS2MeshGaussianFieldInput,
  gaussianIndex: number,
  spacing: number,
): readonly [number, number, number] {
  const offset = gaussianIndex * 3;
  const rawX = input.scales[offset];
  const rawY = input.scales[offset + 1];
  const rawZ = input.scales[offset + 2];
  const minimumAxis = rawX <= rawY && rawX <= rawZ ? 0 : rawY <= rawZ ? 1 : 2;
  return [
    Math.min(spacing * 8, Math.max(rawX, spacing * (minimumAxis === 0 ? 0.34 : 0.62))),
    Math.min(spacing * 8, Math.max(rawY, spacing * (minimumAxis === 1 ? 0.34 : 0.62))),
    Math.min(spacing * 8, Math.max(rawZ, spacing * (minimumAxis === 2 ? 0.34 : 0.62))),
  ];
}

function buildSparseGaussianData(
  input: GS2MeshGaussianFieldInput,
  minimum: readonly [number, number, number],
  dimensions: readonly [number, number, number],
  spacing: number,
  inflateForPreview: boolean,
): SparseGaussianData {
  const blockSize = 8;
  const blockDimensions = dimensions.map((dimension) => Math.ceil(dimension / blockSize)) as [number, number, number];
  const blockCount = blockDimensions[0] * blockDimensions[1] * blockDimensions[2];
  const buckets = Array.from({ length: blockCount }, () => [] as number[]);
  const count = input.positions.length / 3;
  const gaussians = new Float32Array(count * 16);
  for (let index = 0; index < count; index += 1) {
    const positionOffset = index * 3;
    const rotationOffset = index * 4;
    const centerX = input.positions[positionOffset];
    const centerY = input.positions[positionOffset + 1];
    const centerZ = input.positions[positionOffset + 2];
    const [scaleX, scaleY, scaleZ] = inflateForPreview
      ? effectiveScales(input, index, spacing)
      : [
        Math.max(1e-7, input.scales[positionOffset]),
        Math.max(1e-7, input.scales[positionOffset + 1]),
        Math.max(1e-7, input.scales[positionOffset + 2]),
      ];
    const x = input.rotations[rotationOffset];
    const y = input.rotations[rotationOffset + 1];
    const z = input.rotations[rotationOffset + 2];
    const w = input.rotations[rotationOffset + 3];
    const r00 = 1 - 2 * (y * y + z * z);
    const r01 = 2 * (x * y - z * w);
    const r02 = 2 * (x * z + y * w);
    const r10 = 2 * (x * y + z * w);
    const r11 = 1 - 2 * (x * x + z * z);
    const r12 = 2 * (y * z - x * w);
    const r20 = 2 * (x * z - y * w);
    const r21 = 2 * (y * z + x * w);
    const r22 = 1 - 2 * (x * x + y * y);
    gaussians.set([
      centerX, centerY, centerZ, Math.max(0, Math.min(0.999, input.opacities[index])),
      r00 / scaleX, r10 / scaleX, r20 / scaleX, 0,
      r01 / scaleY, r11 / scaleY, r21 / scaleY, 0,
      r02 / scaleZ, r12 / scaleZ, r22 / scaleZ, 0,
    ], index * 16);

    const radius = Math.min(24, Math.max(2, Math.ceil(Math.max(scaleX, scaleY, scaleZ) * 3 / spacing)));
    const voxelX = (centerX - minimum[0]) / spacing;
    const voxelY = (centerY - minimum[1]) / spacing;
    const voxelZ = (centerZ - minimum[2]) / spacing;
    const minBlockX = Math.max(0, Math.floor((voxelX - radius) / blockSize));
    const maxBlockX = Math.min(blockDimensions[0] - 1, Math.floor((voxelX + radius) / blockSize));
    const minBlockY = Math.max(0, Math.floor((voxelY - radius) / blockSize));
    const maxBlockY = Math.min(blockDimensions[1] - 1, Math.floor((voxelY + radius) / blockSize));
    const minBlockZ = Math.max(0, Math.floor((voxelZ - radius) / blockSize));
    const maxBlockZ = Math.min(blockDimensions[2] - 1, Math.floor((voxelZ + radius) / blockSize));
    for (let bz = minBlockZ; bz <= maxBlockZ; bz += 1) {
      for (let by = minBlockY; by <= maxBlockY; by += 1) {
        for (let bx = minBlockX; bx <= maxBlockX; bx += 1) {
          buckets[(bz * blockDimensions[1] + by) * blockDimensions[0] + bx].push(index);
        }
      }
    }
  }
  const blockOffsets = new Uint32Array(blockCount + 1);
  let entryCount = 0;
  for (let block = 0; block < blockCount; block += 1) {
    blockOffsets[block] = entryCount;
    entryCount += buckets[block].length;
  }
  blockOffsets[blockCount] = entryCount;
  if (entryCount > 16_000_000) throw new Error('WebGPU 稀疏块索引超过浏览器安全上限。');
  const blockGaussianIds = new Uint32Array(entryCount);
  let cursor = 0;
  for (const bucket of buckets) {
    blockGaussianIds.set(bucket, cursor);
    cursor += bucket.length;
  }
  return { gaussians, blockOffsets, blockGaussianIds, blockDimensions, blockSize };
}

function buildVisualHull(input: GS2MeshGaussianFieldInput, resolution = 64): VisualHullData {
  const selectedViews = input.views.slice(0, 16);
  const viewCount = selectedViews.length;
  const views = new Float32Array(Math.max(1, viewCount) * 16);
  const masks = new Uint32Array(Math.max(1, viewCount) * resolution * resolution);
  for (let viewIndex = 0; viewIndex < viewCount; viewIndex += 1) {
    const view = selectedViews[viewIndex];
    views.set([
      ...view.position, Math.max(1e-4, view.tanHalfFovX),
      ...view.right, Math.max(1e-4, view.tanHalfFovY),
      ...view.up, 0,
      ...view.forward, 0,
    ], viewIndex * 16);
  }
  const count = input.positions.length / 3;
  for (let viewIndex = 0; viewIndex < viewCount; viewIndex += 1) {
    const view = selectedViews[viewIndex];
    const maskOffset = viewIndex * resolution * resolution;
    for (let index = 0; index < count; index += 1) {
      const offset = index * 3;
      const relX = input.positions[offset] - view.position[0];
      const relY = input.positions[offset + 1] - view.position[1];
      const relZ = input.positions[offset + 2] - view.position[2];
      const depth = relX * view.forward[0] + relY * view.forward[1] + relZ * view.forward[2];
      if (!(depth > 1e-5)) continue;
      const nx = (relX * view.right[0] + relY * view.right[1] + relZ * view.right[2]) / (depth * view.tanHalfFovX);
      const ny = (relX * view.up[0] + relY * view.up[1] + relZ * view.up[2]) / (depth * view.tanHalfFovY);
      const largestScale = Math.max(input.scales[offset], input.scales[offset + 1], input.scales[offset + 2]);
      const radiusX = Math.max(1.5, largestScale * 3 / (depth * view.tanHalfFovX) * resolution * 0.5 + 1);
      const radiusY = Math.max(1.5, largestScale * 3 / (depth * view.tanHalfFovY) * resolution * 0.5 + 1);
      const centerX = (nx * 0.5 + 0.5) * resolution;
      const centerY = (ny * 0.5 + 0.5) * resolution;
      const minX = Math.max(0, Math.floor(centerX - radiusX));
      const maxX = Math.min(resolution - 1, Math.ceil(centerX + radiusX));
      const minY = Math.max(0, Math.floor(centerY - radiusY));
      const maxY = Math.min(resolution - 1, Math.ceil(centerY + radiusY));
      for (let y = minY; y <= maxY; y += 1) {
        masks.fill(1, maskOffset + y * resolution + minX, maskOffset + y * resolution + maxX + 1);
      }
    }
  }
  return { views, masks, resolution, viewCount };
}

function buildRayTileGaussianData(
  input: GS2MeshGaussianFieldInput,
  minimum: readonly [number, number, number],
  dimensions: readonly [number, number, number],
  spacing: number,
  maskResolution: number,
): SparseGaussianData {
  const spatial = buildSparseGaussianData(input, minimum, dimensions, spacing, false);
  const tileSize = 4;
  const tileColumns = Math.ceil(maskResolution / tileSize);
  const tileRows = Math.ceil(maskResolution / tileSize);
  const viewCount = input.views.length;
  const buckets = Array.from({ length: Math.max(1, viewCount * tileColumns * tileRows) }, () => [] as number[]);
  const count = input.positions.length / 3;
  for (let viewIndex = 0; viewIndex < viewCount; viewIndex += 1) {
    const view = input.views[viewIndex];
    for (let index = 0; index < count; index += 1) {
      const offset = index * 3;
      const relX = input.positions[offset] - view.position[0];
      const relY = input.positions[offset + 1] - view.position[1];
      const relZ = input.positions[offset + 2] - view.position[2];
      const depth = relX * view.forward[0] + relY * view.forward[1] + relZ * view.forward[2];
      if (!(depth > 1e-5)) continue;
      const nx = (relX * view.right[0] + relY * view.right[1] + relZ * view.right[2]) / (depth * view.tanHalfFovX);
      const ny = (relX * view.up[0] + relY * view.up[1] + relZ * view.up[2]) / (depth * view.tanHalfFovY);
      const largestScale = Math.max(input.scales[offset], input.scales[offset + 1], input.scales[offset + 2]);
      const radiusX = Math.max(1, largestScale * 3 / (depth * view.tanHalfFovX) * maskResolution * 0.5 + 1);
      const radiusY = Math.max(1, largestScale * 3 / (depth * view.tanHalfFovY) * maskResolution * 0.5 + 1);
      const centerX = (nx * 0.5 + 0.5) * maskResolution;
      const centerY = (ny * 0.5 + 0.5) * maskResolution;
      const minTileX = Math.max(0, Math.floor((centerX - radiusX) / tileSize));
      const maxTileX = Math.min(tileColumns - 1, Math.floor((centerX + radiusX) / tileSize));
      const minTileY = Math.max(0, Math.floor((centerY - radiusY) / tileSize));
      const maxTileY = Math.min(tileRows - 1, Math.floor((centerY + radiusY) / tileSize));
      for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
        for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
          buckets[(viewIndex * tileRows + tileY) * tileColumns + tileX].push(index);
        }
      }
    }
  }
  const blockOffsets = new Uint32Array(buckets.length + 1);
  let entryCount = 0;
  for (let bucket = 0; bucket < buckets.length; bucket += 1) {
    blockOffsets[bucket] = entryCount;
    entryCount += buckets[bucket].length;
  }
  blockOffsets[buckets.length] = entryCount;
  if (entryCount > 16_000_000) throw new Error('WebGPU GOF 屏幕 tile 索引超过浏览器安全上限。');
  const blockGaussianIds = new Uint32Array(entryCount);
  let cursor = 0;
  for (const bucket of buckets) {
    blockGaussianIds.set(bucket, cursor);
    cursor += bucket.length;
  }
  // #WDD-gpt 2026-08-15 - GOF uses sparse per-view ray tiles so foreground Gaussian opacity is not lost by a point-local 3D lookup.
  return {
    gaussians: spatial.gaussians,
    blockOffsets,
    blockGaussianIds,
    blockDimensions: [tileColumns, tileRows, Math.max(1, viewCount)],
    blockSize: tileSize,
  };
}

const SPARSE_OCCUPANCY_SHADER = /* wgsl */ `
struct Params {
  dims: vec4<u32>,
  blockDims: vec4<u32>,
  minimumSpacing: vec4<f32>,
  visual: vec4<u32>,
};
struct Gaussian {
  centerOpacity: vec4<f32>,
  inverse0: vec4<f32>,
  inverse1: vec4<f32>,
  inverse2: vec4<f32>,
};
struct View {
  positionTanX: vec4<f32>,
  rightTanY: vec4<f32>,
  up: vec4<f32>,
  forward: vec4<f32>,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> gaussians: array<Gaussian>;
@group(0) @binding(2) var<storage, read> blockOffsets: array<u32>;
@group(0) @binding(3) var<storage, read> blockGaussianIds: array<u32>;
@group(0) @binding(4) var<storage, read> views: array<View>;
@group(0) @binding(5) var<storage, read> hullMasks: array<u32>;
@group(0) @binding(6) var<storage, read_write> field: array<f32>;
@group(0) @binding(7) var<storage, read_write> winners: array<u32>;

fn insideVisualHull(point: vec3<f32>) -> bool {
  for (var viewId = 0u; viewId < params.visual.x; viewId += 1u) {
    let view = views[viewId];
    let relative = point - view.positionTanX.xyz;
    let depth = dot(relative, view.forward.xyz);
    if (depth <= 0.00001) { return false; }
    let nx = dot(relative, view.rightTanY.xyz) / (depth * view.positionTanX.w);
    let ny = dot(relative, view.up.xyz) / (depth * view.rightTanY.w);
    if (abs(nx) > 1.0 || abs(ny) > 1.0) { return false; }
    let resolution = params.visual.y;
    let px = min(resolution - 1u, u32((nx * 0.5 + 0.5) * f32(resolution)));
    let py = min(resolution - 1u, u32((ny * 0.5 + 0.5) * f32(resolution)));
    let maskIndex = viewId * resolution * resolution + py * resolution + px;
    if (hullMasks[maskIndex] == 0u) { return false; }
  }
  return true;
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (any(id >= params.dims.xyz)) { return; }
  let outputIndex = (id.z * params.dims.y + id.y) * params.dims.x + id.x;
  let point = params.minimumSpacing.xyz + vec3<f32>(id) * params.minimumSpacing.w;
  if (!insideVisualHull(point)) {
    field[outputIndex] = 0.0;
    winners[outputIndex] = 0u;
    return;
  }
  if (params.visual.z == 1u && params.visual.x > 0u) {
    var minimumViewOpacity = 1.0;
    var gofBestContribution = 0.0;
    var gofWinner = 0u;
    for (var viewId = 0u; viewId < params.visual.x; viewId += 1u) {
      let view = views[viewId];
      let rayVector = point - view.positionTanX.xyz;
      let pointDistance = length(rayVector);
      let rayDirection = rayVector / max(0.000001, pointDistance);
      let depth = dot(rayVector, view.forward.xyz);
      let nx = dot(rayVector, view.rightTanY.xyz) / (depth * view.positionTanX.w);
      let ny = dot(rayVector, view.up.xyz) / (depth * view.rightTanY.w);
      let pixelX = min(params.visual.y - 1u, u32((nx * 0.5 + 0.5) * f32(params.visual.y)));
      let pixelY = min(params.visual.y - 1u, u32((ny * 0.5 + 0.5) * f32(params.visual.y)));
      let tileX = pixelX / params.blockDims.w;
      let tileY = pixelY / params.blockDims.w;
      let tileIndex = (viewId * params.blockDims.y + tileY) * params.blockDims.x + tileX;
      let begin = blockOffsets[tileIndex];
      let end = blockOffsets[tileIndex + 1u];
      var viewTransmittance = 1.0;
      for (var gofCursor = begin; gofCursor < end; gofCursor += 1u) {
        let gaussianId = blockGaussianIds[gofCursor];
        let gaussian = gaussians[gaussianId];
        let originDelta = view.positionTanX.xyz - gaussian.centerOpacity.xyz;
        let originLocal = vec3<f32>(
          dot(originDelta, gaussian.inverse0.xyz),
          dot(originDelta, gaussian.inverse1.xyz),
          dot(originDelta, gaussian.inverse2.xyz)
        );
        let rayLocal = vec3<f32>(
          dot(rayDirection, gaussian.inverse0.xyz),
          dot(rayDirection, gaussian.inverse1.xyz),
          dot(rayDirection, gaussian.inverse2.xyz)
        );
        let denominator = max(0.0000001, dot(rayLocal, rayLocal));
        let peakDistance = clamp(-dot(originLocal, rayLocal) / denominator, 0.0, pointDistance);
        let evaluation = originLocal + rayLocal * peakDistance;
        let contribution = gaussian.centerOpacity.w * exp(-0.5 * dot(evaluation, evaluation));
        viewTransmittance *= 1.0 - contribution;
        let pointDelta = point - gaussian.centerOpacity.xyz;
        let pointLocal = vec3<f32>(
          dot(pointDelta, gaussian.inverse0.xyz),
          dot(pointDelta, gaussian.inverse1.xyz),
          dot(pointDelta, gaussian.inverse2.xyz)
        );
        let pointContribution = gaussian.centerOpacity.w * exp(-0.5 * dot(pointLocal, pointLocal));
        if (pointContribution > gofBestContribution) {
          gofBestContribution = pointContribution;
          gofWinner = gaussianId;
        }
      }
      minimumViewOpacity = min(minimumViewOpacity, 1.0 - viewTransmittance);
    }
    field[outputIndex] = minimumViewOpacity;
    winners[outputIndex] = gofWinner;
    return;
  }
  let block = id / params.blockDims.www;
  let blockIndex = (block.z * params.blockDims.y + block.y) * params.blockDims.x + block.x;
  let begin = blockOffsets[blockIndex];
  let end = blockOffsets[blockIndex + 1u];
  var transmittance = 1.0;
  var bestContribution = 0.0;
  var winner = 0u;
  for (var cursor = begin; cursor < end; cursor += 1u) {
    let gaussianId = blockGaussianIds[cursor];
    let gaussian = gaussians[gaussianId];
    let delta = point - gaussian.centerOpacity.xyz;
    let local = vec3<f32>(
      dot(delta, gaussian.inverse0.xyz),
      dot(delta, gaussian.inverse1.xyz),
      dot(delta, gaussian.inverse2.xyz)
    );
    let radiusSquared = dot(local, local);
    if (radiusSquared <= 9.0) {
      let contribution = gaussian.centerOpacity.w * exp(-0.5 * radiusSquared);
      transmittance *= 1.0 - contribution;
      if (contribution > bestContribution) {
        bestContribution = contribution;
        winner = gaussianId;
      }
    }
  }
  field[outputIndex] = 1.0 - transmittance;
  winners[outputIndex] = winner;
}`;

const PARTITIONED_GOF_SHADER = /* wgsl */ `
struct Params {
  volumeDims: vec4<u32>,
  batch: vec4<u32>,
  tile: vec4<u32>,
  minimumSpacing: vec4<f32>,
  visual: vec4<u32>,
};
struct Gaussian {
  centerOpacity: vec4<f32>,
  inverse0: vec4<f32>,
  inverse1: vec4<f32>,
  inverse2: vec4<f32>,
};
struct View {
  positionTanX: vec4<f32>,
  rightTanY: vec4<f32>,
  up: vec4<f32>,
  forward: vec4<f32>,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> gaussians: array<Gaussian>;
@group(0) @binding(2) var<storage, read> tileOffsets: array<u32>;
@group(0) @binding(3) var<storage, read> tileGaussianIds: array<u32>;
@group(0) @binding(4) var<storage, read> views: array<View>;
@group(0) @binding(5) var<storage, read> hullMasks: array<u32>;
@group(0) @binding(6) var<storage, read> brickOrigins: array<vec4<u32>>;
@group(0) @binding(7) var<storage, read_write> output: array<vec2<f32>>;

fn insideVisualHull(point: vec3<f32>) -> bool {
  for (var viewId = 0u; viewId < params.visual.x; viewId += 1u) {
    let view = views[viewId];
    let relative = point - view.positionTanX.xyz;
    let depth = dot(relative, view.forward.xyz);
    if (depth <= 0.00001) { return false; }
    let nx = dot(relative, view.rightTanY.xyz) / (depth * view.positionTanX.w);
    let ny = dot(relative, view.up.xyz) / (depth * view.rightTanY.w);
    if (abs(nx) > 1.0 || abs(ny) > 1.0) { return false; }
    let resolution = params.visual.y;
    let px = min(resolution - 1u, u32((nx * 0.5 + 0.5) * f32(resolution)));
    let py = min(resolution - 1u, u32((ny * 0.5 + 0.5) * f32(resolution)));
    if (hullMasks[viewId * resolution * resolution + py * resolution + px] == 0u) { return false; }
  }
  return true;
}

@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let pointsPerBrick = params.batch.z * params.batch.z * params.batch.z;
  let pointId = id.x;
  if (pointId >= params.batch.x * pointsPerBrick) { return; }
  let brickId = pointId / pointsPerBrick;
  let localId = pointId - brickId * pointsPerBrick;
  let localZ = localId / (params.batch.z * params.batch.z);
  let remainder = localId - localZ * params.batch.z * params.batch.z;
  let localY = remainder / params.batch.z;
  let localX = remainder - localY * params.batch.z;
  let globalId = brickOrigins[brickId].xyz + vec3<u32>(localX, localY, localZ);
  if (any(globalId >= params.volumeDims.xyz)
      || any(globalId == vec3<u32>(0u))
      || any(globalId >= params.volumeDims.xyz - vec3<u32>(1u))) {
    output[pointId] = vec2<f32>(0.0, bitcast<f32>(0u));
    return;
  }
  let point = params.minimumSpacing.xyz + vec3<f32>(globalId) * params.minimumSpacing.w;
  if (!insideVisualHull(point) || params.visual.x == 0u) {
    output[pointId] = vec2<f32>(0.0, bitcast<f32>(0u));
    return;
  }
  var minimumViewOpacity = 1.0;
  var bestPointContribution = 0.0;
  var winner = 0u;
  for (var viewId = 0u; viewId < params.visual.x; viewId += 1u) {
    let view = views[viewId];
    let rayVector = point - view.positionTanX.xyz;
    let pointDistance = length(rayVector);
    let rayDirection = rayVector / max(0.000001, pointDistance);
    let depth = dot(rayVector, view.forward.xyz);
    let nx = dot(rayVector, view.rightTanY.xyz) / (depth * view.positionTanX.w);
    let ny = dot(rayVector, view.up.xyz) / (depth * view.rightTanY.w);
    let pixelX = min(params.visual.y - 1u, u32((nx * 0.5 + 0.5) * f32(params.visual.y)));
    let pixelY = min(params.visual.y - 1u, u32((ny * 0.5 + 0.5) * f32(params.visual.y)));
    let tileX = pixelX / params.tile.z;
    let tileY = pixelY / params.tile.z;
    let tileIndex = (viewId * params.tile.y + tileY) * params.tile.x + tileX;
    let begin = tileOffsets[tileIndex];
    let end = tileOffsets[tileIndex + 1u];
    var transmittance = 1.0;
    for (var cursor = begin; cursor < end; cursor += 1u) {
      let gaussianId = tileGaussianIds[cursor];
      let gaussian = gaussians[gaussianId];
      let originDelta = view.positionTanX.xyz - gaussian.centerOpacity.xyz;
      let originLocal = vec3<f32>(
        dot(originDelta, gaussian.inverse0.xyz),
        dot(originDelta, gaussian.inverse1.xyz),
        dot(originDelta, gaussian.inverse2.xyz)
      );
      let rayLocal = vec3<f32>(
        dot(rayDirection, gaussian.inverse0.xyz),
        dot(rayDirection, gaussian.inverse1.xyz),
        dot(rayDirection, gaussian.inverse2.xyz)
      );
      let denominator = max(0.0000001, dot(rayLocal, rayLocal));
      let peakDistance = clamp(-dot(originLocal, rayLocal) / denominator, 0.0, pointDistance);
      let evaluation = originLocal + rayLocal * peakDistance;
      let contribution = gaussian.centerOpacity.w * exp(-0.5 * dot(evaluation, evaluation));
      transmittance *= 1.0 - contribution;
      let pointDelta = point - gaussian.centerOpacity.xyz;
      let pointLocal = vec3<f32>(
        dot(pointDelta, gaussian.inverse0.xyz),
        dot(pointDelta, gaussian.inverse1.xyz),
        dot(pointDelta, gaussian.inverse2.xyz)
      );
      let pointContribution = gaussian.centerOpacity.w * exp(-0.5 * dot(pointLocal, pointLocal));
      if (pointContribution > bestPointContribution) {
        bestPointContribution = pointContribution;
        winner = gaussianId;
      }
    }
    minimumViewOpacity = min(minimumViewOpacity, 1.0 - transmittance);
  }
  output[pointId] = vec2<f32>(minimumViewOpacity, bitcast<f32>(winner));
}`;

const GOF_EDGE_REFINEMENT_SHADER = /* wgsl */ `
struct Params {
  counts: vec4<u32>,
  tile: vec4<u32>,
  surface: vec4<f32>,
};
struct Gaussian {
  centerOpacity: vec4<f32>,
  inverse0: vec4<f32>,
  inverse1: vec4<f32>,
  inverse2: vec4<f32>,
};
struct View {
  positionTanX: vec4<f32>,
  rightTanY: vec4<f32>,
  up: vec4<f32>,
  forward: vec4<f32>,
};
struct Bracket {
  first: vec4<f32>,
  second: vec4<f32>,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> gaussians: array<Gaussian>;
@group(0) @binding(2) var<storage, read> tileOffsets: array<u32>;
@group(0) @binding(3) var<storage, read> tileGaussianIds: array<u32>;
@group(0) @binding(4) var<storage, read> views: array<View>;
@group(0) @binding(5) var<storage, read> hullMasks: array<u32>;
@group(0) @binding(6) var<storage, read> brackets: array<Bracket>;
@group(0) @binding(7) var<storage, read_write> refinedPositions: array<vec4<f32>>;

fn insideVisualHull(point: vec3<f32>) -> bool {
  for (var viewId = 0u; viewId < params.counts.y; viewId += 1u) {
    let view = views[viewId];
    let relative = point - view.positionTanX.xyz;
    let depth = dot(relative, view.forward.xyz);
    if (depth <= 0.00001) { return false; }
    let nx = dot(relative, view.rightTanY.xyz) / (depth * view.positionTanX.w);
    let ny = dot(relative, view.up.xyz) / (depth * view.rightTanY.w);
    if (abs(nx) > 1.0 || abs(ny) > 1.0) { return false; }
    let pixelX = min(params.counts.z - 1u, u32((nx * 0.5 + 0.5) * f32(params.counts.z)));
    let pixelY = min(params.counts.z - 1u, u32((ny * 0.5 + 0.5) * f32(params.counts.z)));
    let maskIndex = viewId * params.counts.z * params.counts.z + pixelY * params.counts.z + pixelX;
    if (hullMasks[maskIndex] == 0u) { return false; }
  }
  return true;
}

fn gofOpacity(point: vec3<f32>) -> f32 {
  if (!insideVisualHull(point) || params.counts.y == 0u) { return 0.0; }
  var minimumViewOpacity = 1.0;
  for (var viewId = 0u; viewId < params.counts.y; viewId += 1u) {
    let view = views[viewId];
    let rayVector = point - view.positionTanX.xyz;
    let pointDistance = length(rayVector);
    let rayDirection = rayVector / max(0.000001, pointDistance);
    let depth = dot(rayVector, view.forward.xyz);
    let nx = dot(rayVector, view.rightTanY.xyz) / (depth * view.positionTanX.w);
    let ny = dot(rayVector, view.up.xyz) / (depth * view.rightTanY.w);
    let pixelX = min(params.counts.z - 1u, u32((nx * 0.5 + 0.5) * f32(params.counts.z)));
    let pixelY = min(params.counts.z - 1u, u32((ny * 0.5 + 0.5) * f32(params.counts.z)));
    let tileX = pixelX / params.tile.z;
    let tileY = pixelY / params.tile.z;
    let tileIndex = (viewId * params.tile.y + tileY) * params.tile.x + tileX;
    let begin = tileOffsets[tileIndex];
    let end = tileOffsets[tileIndex + 1u];
    var transmittance = 1.0;
    for (var cursor = begin; cursor < end; cursor += 1u) {
      let gaussian = gaussians[tileGaussianIds[cursor]];
      let originDelta = view.positionTanX.xyz - gaussian.centerOpacity.xyz;
      let originLocal = vec3<f32>(
        dot(originDelta, gaussian.inverse0.xyz),
        dot(originDelta, gaussian.inverse1.xyz),
        dot(originDelta, gaussian.inverse2.xyz)
      );
      let rayLocal = vec3<f32>(
        dot(rayDirection, gaussian.inverse0.xyz),
        dot(rayDirection, gaussian.inverse1.xyz),
        dot(rayDirection, gaussian.inverse2.xyz)
      );
      let denominator = max(0.0000001, dot(rayLocal, rayLocal));
      let peakDistance = clamp(-dot(originLocal, rayLocal) / denominator, 0.0, pointDistance);
      let evaluation = originLocal + rayLocal * peakDistance;
      let contribution = gaussian.centerOpacity.w * exp(-0.5 * dot(evaluation, evaluation));
      transmittance *= 1.0 - contribution;
    }
    minimumViewOpacity = min(minimumViewOpacity, 1.0 - transmittance);
  }
  return minimumViewOpacity;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let vertexId = id.x;
  if (vertexId >= params.counts.x) { return; }
  var first = brackets[vertexId].first.xyz;
  var second = brackets[vertexId].second.xyz;
  let firstInside = gofOpacity(first) >= params.surface.x;
  let secondInside = gofOpacity(second) >= params.surface.x;
  if (firstInside == secondInside) {
    refinedPositions[vertexId] = vec4<f32>((first + second) * 0.5, 1.0);
    return;
  }
  for (var iteration = 0u; iteration < params.counts.w; iteration += 1u) {
    let middle = (first + second) * 0.5;
    let middleInside = gofOpacity(middle) >= params.surface.x;
    if (middleInside == firstInside) {
      first = middle;
    } else {
      second = middle;
    }
  }
  refinedPositions[vertexId] = vec4<f32>((first + second) * 0.5, 1.0);
}`;

function createGpuBuffer(device: GPUDevice, data: ArrayBufferView, usage: GPUBufferUsageFlags): GPUBuffer {
  const buffer = device.createBuffer({
    size: Math.max(4, Math.ceil(data.byteLength / 4) * 4),
    usage,
    mappedAtCreation: true,
  });
  new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  buffer.unmap();
  return buffer;
}

async function computeWebGpuField(
  input: GS2MeshGaussianFieldInput,
  resolution: number,
  gofLevelSet: boolean,
): Promise<SparsePreviewField> {
  const device = await requestReusableGpuDevice();
  const requestedResolution = Math.max(48, Math.min(MAX_SPARSE_FIELD_RESOLUTION, Math.round(resolution)));
  const topologyResolution = topologyResolutionFor(requestedResolution);
  const { minimum, dimensions, spacing } = robustFieldBounds(input, topologyResolution);
  const [dimX, dimY, dimZ] = dimensions;
  const voxelCount = dimX * dimY * dimZ;
  const hull = buildVisualHull(input, gofLevelSet ? 256 : 64);
  const sparse = gofLevelSet
    ? buildRayTileGaussianData(input, minimum, dimensions, spacing, hull.resolution)
    : buildSparseGaussianData(input, minimum, dimensions, spacing, true);
  const paramsBuffer = new ArrayBuffer(64);
  const paramsU32 = new Uint32Array(paramsBuffer);
  const paramsF32 = new Float32Array(paramsBuffer);
  paramsU32.set([dimX, dimY, dimZ, input.positions.length / 3], 0);
  paramsU32.set([...sparse.blockDimensions, sparse.blockSize], 4);
  paramsF32.set([...minimum, spacing], 8);
  paramsU32.set([hull.viewCount, hull.resolution, gofLevelSet ? 1 : 0, 0], 12);
  const buffers: GPUBuffer[] = [];
  try {
    const params = createGpuBuffer(device, new Uint8Array(paramsBuffer), GPUBufferUsage.UNIFORM);
    const gaussians = createGpuBuffer(device, sparse.gaussians, GPUBufferUsage.STORAGE);
    const blockOffsets = createGpuBuffer(device, sparse.blockOffsets, GPUBufferUsage.STORAGE);
    const blockGaussianIds = createGpuBuffer(device, sparse.blockGaussianIds, GPUBufferUsage.STORAGE);
    const views = createGpuBuffer(device, hull.views, GPUBufferUsage.STORAGE);
    const masks = createGpuBuffer(device, hull.masks, GPUBufferUsage.STORAGE);
    const field = device.createBuffer({ size: voxelCount * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const winners = device.createBuffer({ size: voxelCount * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const fieldReadback = device.createBuffer({ size: voxelCount * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const winnerReadback = device.createBuffer({ size: voxelCount * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    buffers.push(params, gaussians, blockOffsets, blockGaussianIds, views, masks, field, winners, fieldReadback, winnerReadback);
    const module = device.createShaderModule({ code: SPARSE_OCCUPANCY_SHADER });
    const compilation = await module.getCompilationInfo();
    const shaderErrors = compilation.messages.filter((message) => message.type === 'error');
    if (shaderErrors.length) throw new Error(`WebGPU shader 编译失败：${shaderErrors[0].message}`);
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [params, gaussians, blockOffsets, blockGaussianIds, views, masks, field, winners].map((buffer, binding) => ({
        binding,
        resource: { buffer },
      })),
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(dimX / 4), Math.ceil(dimY / 4), Math.ceil(dimZ / 4));
    pass.end();
    encoder.copyBufferToBuffer(field, 0, fieldReadback, 0, voxelCount * 4);
    encoder.copyBufferToBuffer(winners, 0, winnerReadback, 0, voxelCount * 4);
    device.queue.submit([encoder.finish()]);
    await Promise.all([fieldReadback.mapAsync(GPUMapMode.READ), winnerReadback.mapAsync(GPUMapMode.READ)]);
    const fieldValues = new Float32Array(fieldReadback.getMappedRange()).slice();
    const winnerValues = new Uint32Array(winnerReadback.getMappedRange()).slice();
    fieldReadback.unmap();
    winnerReadback.unmap();
    pinFieldBorder(fieldValues, dimX, dimY, dimZ);
    return {
      field: fieldValues,
      winner: winnerValues,
      dimX,
      dimY,
      dimZ,
      minimum,
      spacing,
      backend: gofLevelSet
        ? `WebGPU GOF ${requestedResolution}³-equivalent sparse field (${topologyResolution}³ topology) + Marching Tetrahedra`
        : 'WebGPU Sparse Oriented Occupancy + Visual Hull + Marching Cubes',
    };
  } finally {
    for (const buffer of buffers) buffer.destroy();
    device.destroy();
  }
}

async function computePartitionedGofSurface(
  input: GS2MeshGaussianFieldInput,
  requestedResolution: number,
  requestId: number,
): Promise<SparsePartitionExtraction> {
  const plan = buildSparseBrickBounds(input, requestedResolution);
  const device = await requestReusableGpuDevice();
  const hull = buildVisualHull(input, 256);
  // #WDD-gpt 2026-08-15 - Ray tiles only need packed Gaussians, so their helper receives bounded dummy spatial dimensions instead of allocating a 1024³ block index.
  const packingBounds = robustFieldBounds(input, 128);
  const sparse = buildRayTileGaussianData(
    input,
    packingBounds.minimum,
    packingBounds.dimensions,
    packingBounds.spacing,
    hull.resolution,
  );
  const pointsPerAxis = plan.brickSize + 1;
  const pointsPerBrick = pointsPerAxis ** 3;
  const batchPointCapacity = SPARSE_BRICK_BATCH_SIZE * pointsPerBrick;
  const batchBytes = batchPointCapacity * 8;
  const buffers: GPUBuffer[] = [];
  const mergedPositions: number[] = [];
  const mergedColors: number[] = [];
  const mergedIndices: number[] = [];
  const mergedBrackets: number[] = [];
  const welded = new Map<string, number>();
  let brickCount = 0;
  const inverseWeld = 1 / Math.max(1e-10, plan.spacing * 1e-4);
  const appendBrick = (extraction: GofSurfaceExtraction): void => {
    const remap = new Int32Array(extraction.mesh.positions.length / 3);
    remap.fill(-1);
    const mapVertex = (oldIndex: number): number => {
      const cached = remap[oldIndex];
      if (cached >= 0) return cached;
      const positionOffset = oldIndex * 3;
      const key = `${Math.round(extraction.mesh.positions[positionOffset] * inverseWeld)},${Math.round(extraction.mesh.positions[positionOffset + 1] * inverseWeld)},${Math.round(extraction.mesh.positions[positionOffset + 2] * inverseWeld)}`;
      const existing = welded.get(key);
      if (existing !== undefined) {
        remap[oldIndex] = existing;
        return existing;
      }
      const next = mergedPositions.length / 3;
      remap[oldIndex] = next;
      welded.set(key, next);
      mergedPositions.push(
        extraction.mesh.positions[positionOffset],
        extraction.mesh.positions[positionOffset + 1],
        extraction.mesh.positions[positionOffset + 2],
      );
      const colorOffset = oldIndex * 4;
      mergedColors.push(
        extraction.mesh.colors[colorOffset],
        extraction.mesh.colors[colorOffset + 1],
        extraction.mesh.colors[colorOffset + 2],
        255,
      );
      const bracketOffset = oldIndex * 6;
      mergedBrackets.push(
        extraction.brackets[bracketOffset],
        extraction.brackets[bracketOffset + 1],
        extraction.brackets[bracketOffset + 2],
        extraction.brackets[bracketOffset + 3],
        extraction.brackets[bracketOffset + 4],
        extraction.brackets[bracketOffset + 5],
      );
      return next;
    };
    for (let indexOffset = 0; indexOffset < extraction.mesh.indices.length; indexOffset += 3) {
      const first = mapVertex(extraction.mesh.indices[indexOffset]);
      const second = mapVertex(extraction.mesh.indices[indexOffset + 1]);
      const third = mapVertex(extraction.mesh.indices[indexOffset + 2]);
      if (first !== second && second !== third && third !== first) mergedIndices.push(first, second, third);
    }
    if (mergedIndices.length / 3 > MAX_SAFE_JS_ACCUMULATED_TRIANGLES) {
      // #WDD-gpt 2026-08-15 - Stop before dynamic JS arrays and string weld keys can make the browser terminate the Worker without an exception.
      throw new BrowserTopologyBudgetError('精细 GOF 表面超过浏览器安全内存预算（125 万三角形）。已保留快速预览；请改用 2 mm 或 40K Gaussian。');
    }
    if (mergedIndices.length / 3 > MAX_PROJECTED_TRIANGLES) {
      throw new Error('活动分区生成的三角形超过 400 万，请降低不透明度场精度。');
    }
  };
  try {
    const params = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const gaussians = createGpuBuffer(device, sparse.gaussians, GPUBufferUsage.STORAGE);
    const tileOffsets = createGpuBuffer(device, sparse.blockOffsets, GPUBufferUsage.STORAGE);
    const tileGaussianIds = createGpuBuffer(device, sparse.blockGaussianIds, GPUBufferUsage.STORAGE);
    const views = createGpuBuffer(device, hull.views, GPUBufferUsage.STORAGE);
    const masks = createGpuBuffer(device, hull.masks, GPUBufferUsage.STORAGE);
    const origins = device.createBuffer({
      size: SPARSE_BRICK_BATCH_SIZE * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const output = device.createBuffer({
      size: batchBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const readback = device.createBuffer({
      size: batchBytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    buffers.push(params, gaussians, tileOffsets, tileGaussianIds, views, masks, origins, output, readback);
    const module = device.createShaderModule({ code: PARTITIONED_GOF_SHADER });
    const compilation = await module.getCompilationInfo();
    const shaderErrors = compilation.messages.filter((message) => message.type === 'error');
    if (shaderErrors.length) throw new Error(`分区 GOF shader 编译失败：${shaderErrors[0].message}`);
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [params, gaussians, tileOffsets, tileGaussianIds, views, masks, origins, output].map((buffer, binding) => ({
        binding,
        resource: { buffer },
      })),
    });
    const totalSlabs = plan.brickDimensions[2];
    for (let slabStartZ = 0; slabStartZ < totalSlabs; slabStartZ += SPARSE_BRICK_SLAB_DEPTH) {
      const slabEndZ = Math.min(totalSlabs, slabStartZ + SPARSE_BRICK_SLAB_DEPTH);
      const slabOrigins = buildActiveBrickSlab(input, plan, slabStartZ, slabEndZ);
      const slabBrickCount = slabOrigins.length / 4;
      brickCount += slabBrickCount;
      for (let batchStart = 0; batchStart < slabBrickCount; batchStart += SPARSE_BRICK_BATCH_SIZE) {
        const currentBrickCount = Math.min(SPARSE_BRICK_BATCH_SIZE, slabBrickCount - batchStart);
        const currentPointCount = currentBrickCount * pointsPerBrick;
        const currentBytes = currentPointCount * 8;
        const paramsBuffer = new ArrayBuffer(80);
        const paramsU32 = new Uint32Array(paramsBuffer);
        const paramsF32 = new Float32Array(paramsBuffer);
        paramsU32.set([...plan.dimensions, 0], 0);
        paramsU32.set([currentBrickCount, plan.brickSize, pointsPerAxis, currentPointCount], 4);
        paramsU32.set([sparse.blockDimensions[0], sparse.blockDimensions[1], sparse.blockSize, 0], 8);
        paramsF32.set([...plan.minimum, plan.spacing], 12);
        paramsU32.set([hull.viewCount, hull.resolution, 0, 0], 16);
        device.queue.writeBuffer(params, 0, paramsBuffer);
        device.queue.writeBuffer(
          origins,
          0,
          slabOrigins.subarray(batchStart * 4, (batchStart + currentBrickCount) * 4),
        );
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(currentPointCount / 128));
        pass.end();
        encoder.copyBufferToBuffer(output, 0, readback, 0, currentBytes);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ, 0, currentBytes);
        const packedU32 = new Uint32Array(readback.getMappedRange(0, currentBytes)).slice();
        readback.unmap();
        const packedF32 = new Float32Array(packedU32.buffer);
        for (let localBrick = 0; localBrick < currentBrickCount; localBrick += 1) {
          const field = new Float32Array(pointsPerBrick);
          const winner = new Uint32Array(pointsPerBrick);
          const sourceBase = localBrick * pointsPerBrick * 2;
          for (let point = 0; point < pointsPerBrick; point += 1) {
            field[point] = packedF32[sourceBase + point * 2];
            winner[point] = packedU32[sourceBase + point * 2 + 1];
          }
          const originOffset = (batchStart + localBrick) * 4;
          const originX = slabOrigins[originOffset];
          const originY = slabOrigins[originOffset + 1];
          const originZ = slabOrigins[originOffset + 2];
          const local = extractOpacitySurfaceWithBrackets({
            field,
            winner,
            dimX: pointsPerAxis,
            dimY: pointsPerAxis,
            dimZ: pointsPerAxis,
            minimum: [
              plan.minimum[0] + originX * plan.spacing,
              plan.minimum[1] + originY * plan.spacing,
              plan.minimum[2] + originZ * plan.spacing,
            ],
            spacing: plan.spacing,
          }, input, requestId, false, false, false);
          if (local.mesh.indices.length) appendBrick(local);
        }
        // #WDD-gpt 2026-08-15 - GPU field/readback buffers are reused per batch while the CPU registry contains only the current Z slab.
        const slabProgress = slabStartZ + (slabEndZ - slabStartZ) * (batchStart + currentBrickCount) / Math.max(1, slabBrickCount);
        report(requestId, 'fusing', slabProgress / totalSlabs * 0.82);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      if (!slabBrickCount) report(requestId, 'fusing', slabEndZ / totalSlabs * 0.82);
    }
    if (!brickCount) throw new Error('当前帧没有可计算的非空 GOF 分区。');
    const filtered = filterComponents(mergedPositions, mergedColors, mergedIndices, mergedBrackets);
    if (filtered.indices.length < 30) throw new Error('分区 GOF 没有提取到足够的连续表面。');
    const positions = Float32Array.from(filtered.positions);
    const indices = Uint32Array.from(filtered.indices);
    const actualResolution = Math.max(...plan.dimensions);
    const physicalSpacing = input.sceneUnitMillimeters
      ? ` / ${(plan.spacing * input.sceneUnitMillimeters).toFixed(3)} mm leaf`
      : '';
    return {
      mesh: {
        positions,
        normals: calculateVertexNormals(positions, indices),
        colors: Uint8Array.from(filtered.colors),
        indices,
      },
      brackets: Float32Array.from(filtered.brackets),
      spacing: plan.spacing,
      activeBrickCount: brickCount,
      backend: `WebGPU GOF ${actualResolution}³ virtual${physicalSpacing}, streamed sparse 16³ bricks (${brickCount.toLocaleString()} active, 1 Z layer registry, ${SPARSE_BRICK_BATCH_SIZE}/GPU batch) + welded Marching Tetrahedra`,
    };
  } finally {
    for (const buffer of buffers) buffer.destroy();
    device.destroy();
  }
}

function applyVisualHullMaskToBrick(
  field: Float32Array,
  winner: Uint32Array,
  minimum: readonly [number, number, number],
  spacing: number,
  pointsPerAxis: number,
  hull: VisualHullData,
): void {
  if (!hull.viewCount) return;
  const plane = pointsPerAxis * pointsPerAxis;
  for (let index = 0; index < field.length; index += 1) {
    if (!(field[index] > 0)) continue;
    const z = Math.floor(index / plane);
    const remainder = index - z * plane;
    const y = Math.floor(remainder / pointsPerAxis);
    const x = remainder - y * pointsPerAxis;
    const pointX = minimum[0] + x * spacing;
    const pointY = minimum[1] + y * spacing;
    const pointZ = minimum[2] + z * spacing;
    let inside = true;
    for (let viewIndex = 0; viewIndex < hull.viewCount; viewIndex += 1) {
      const viewOffset = viewIndex * 16;
      const relativeX = pointX - hull.views[viewOffset];
      const relativeY = pointY - hull.views[viewOffset + 1];
      const relativeZ = pointZ - hull.views[viewOffset + 2];
      const depth = relativeX * hull.views[viewOffset + 12]
        + relativeY * hull.views[viewOffset + 13]
        + relativeZ * hull.views[viewOffset + 14];
      if (!(depth > 1e-5)) {
        inside = false;
        break;
      }
      const normalizedX = (
        relativeX * hull.views[viewOffset + 4]
        + relativeY * hull.views[viewOffset + 5]
        + relativeZ * hull.views[viewOffset + 6]
      ) / (depth * hull.views[viewOffset + 3]);
      const normalizedY = (
        relativeX * hull.views[viewOffset + 8]
        + relativeY * hull.views[viewOffset + 9]
        + relativeZ * hull.views[viewOffset + 10]
      ) / (depth * hull.views[viewOffset + 7]);
      if (Math.abs(normalizedX) > 1 || Math.abs(normalizedY) > 1) {
        inside = false;
        break;
      }
      const pixelX = Math.min(hull.resolution - 1, Math.max(0, Math.floor((normalizedX * 0.5 + 0.5) * hull.resolution)));
      const pixelY = Math.min(hull.resolution - 1, Math.max(0, Math.floor((normalizedY * 0.5 + 0.5) * hull.resolution)));
      if (!hull.masks[(viewIndex * hull.resolution + pixelY) * hull.resolution + pixelX]) {
        inside = false;
        break;
      }
    }
    if (!inside) {
      field[index] = 0;
      winner[index] = 0;
    }
  }
}

export async function computePartitionedWasmSurface(
  core: GS2MeshOpacityCoreExports,
  input: GS2MeshGaussianFieldInput,
  requestedResolution: number,
  requestId: number,
): Promise<SparsePartitionExtraction> {
  const plan = buildSparseBrickBounds(input, requestedResolution);
  const hull = buildVisualHull(input, 128);
  const pointsPerAxis = plan.brickSize + 1;
  const pointsPerBrick = pointsPerAxis ** 3;
  // #WDD-gpt 2026-08-15 - Build topology from a smooth Gaussian alpha envelope instead of altering the field with per-brick morphology; quadrature padding keeps large axes nearly unchanged while wrapping thin gaps.
  const wrapRadius = plan.spacing * 1.5;
  core.reset();
  const fieldPointer = core.alloc(pointsPerBrick * Float32Array.BYTES_PER_ELEMENT);
  const bestPointer = core.alloc(pointsPerBrick * Float32Array.BYTES_PER_ELEMENT);
  const winnerPointer = core.alloc(pointsPerBrick * Uint32Array.BYTES_PER_ELEMENT);
  const field = new Float32Array(core.memory.buffer, fieldPointer, pointsPerBrick);
  const best = new Float32Array(core.memory.buffer, bestPointer, pointsPerBrick);
  const winner = new Uint32Array(core.memory.buffer, winnerPointer, pointsPerBrick);
  let mergedPositions: number[] = [];
  let mergedColors: number[] = [];
  let mergedIndices: number[] = [];
  let clusterCounts: number[] = [];
  let welded = new Map<string, number>();
  let clusterVoxelSize = 1e-4;
  let inverseWeld = 1 / Math.max(1e-10, plan.spacing * clusterVoxelSize);
  let brickCount = 0;
  const recluster = (nextVoxelSize: number): void => {
    const nextPositions: number[] = [];
    const nextColors: number[] = [];
    const nextCounts: number[] = [];
    const nextWelded = new Map<string, number>();
    const remap = new Uint32Array(clusterCounts.length);
    const inverseCluster = 1 / Math.max(1e-10, plan.spacing * nextVoxelSize);
    for (let vertex = 0; vertex < clusterCounts.length; vertex += 1) {
      const count = Math.max(1, clusterCounts[vertex]);
      const positionOffset = vertex * 3;
      const colorOffset = vertex * 4;
      const x = mergedPositions[positionOffset] / count;
      const y = mergedPositions[positionOffset + 1] / count;
      const z = mergedPositions[positionOffset + 2] / count;
      const key = `${Math.round(x * inverseCluster)},${Math.round(y * inverseCluster)},${Math.round(z * inverseCluster)}`;
      let next = nextWelded.get(key);
      if (next === undefined) {
        next = nextCounts.length;
        nextWelded.set(key, next);
        nextPositions.push(0, 0, 0);
        nextColors.push(0, 0, 0, 0);
        nextCounts.push(0);
      }
      remap[vertex] = next;
      nextPositions[next * 3] += x * count;
      nextPositions[next * 3 + 1] += y * count;
      nextPositions[next * 3 + 2] += z * count;
      nextColors[next * 4] += mergedColors[colorOffset];
      nextColors[next * 4 + 1] += mergedColors[colorOffset + 1];
      nextColors[next * 4 + 2] += mergedColors[colorOffset + 2];
      nextColors[next * 4 + 3] += 255 * count;
      nextCounts[next] += count;
    }
    const nextIndices: number[] = [];
    for (let offset = 0; offset < mergedIndices.length; offset += 3) {
      const first = remap[mergedIndices[offset]];
      const second = remap[mergedIndices[offset + 1]];
      const third = remap[mergedIndices[offset + 2]];
      if (first !== second && second !== third && third !== first) nextIndices.push(first, second, third);
    }
    mergedPositions = nextPositions;
    mergedColors = nextColors;
    mergedIndices = nextIndices;
    clusterCounts = nextCounts;
    welded = nextWelded;
    clusterVoxelSize = nextVoxelSize;
    inverseWeld = inverseCluster;
  };
  const appendBrick = (mesh: GS2MeshData): void => {
    const remap = new Int32Array(mesh.positions.length / 3);
    remap.fill(-1);
    const mapVertex = (oldIndex: number): number => {
      const cached = remap[oldIndex];
      if (cached >= 0) return cached;
      const positionOffset = oldIndex * 3;
      const key = `${Math.round(mesh.positions[positionOffset] * inverseWeld)},${Math.round(mesh.positions[positionOffset + 1] * inverseWeld)},${Math.round(mesh.positions[positionOffset + 2] * inverseWeld)}`;
      const existing = welded.get(key);
      if (existing !== undefined) {
        remap[oldIndex] = existing;
        clusterCounts[existing] += 1;
        mergedPositions[existing * 3] += mesh.positions[positionOffset];
        mergedPositions[existing * 3 + 1] += mesh.positions[positionOffset + 1];
        mergedPositions[existing * 3 + 2] += mesh.positions[positionOffset + 2];
        mergedColors[existing * 4] += mesh.colors[oldIndex * 4];
        mergedColors[existing * 4 + 1] += mesh.colors[oldIndex * 4 + 1];
        mergedColors[existing * 4 + 2] += mesh.colors[oldIndex * 4 + 2];
        mergedColors[existing * 4 + 3] += 255;
        return existing;
      }
      const next = mergedPositions.length / 3;
      remap[oldIndex] = next;
      welded.set(key, next);
      mergedPositions.push(
        mesh.positions[positionOffset],
        mesh.positions[positionOffset + 1],
        mesh.positions[positionOffset + 2],
      );
      const colorOffset = oldIndex * 4;
      mergedColors.push(
        mesh.colors[colorOffset],
        mesh.colors[colorOffset + 1],
        mesh.colors[colorOffset + 2],
        255,
      );
      clusterCounts.push(1);
      return next;
    };
    for (let indexOffset = 0; indexOffset < mesh.indices.length; indexOffset += 3) {
      const first = mapVertex(mesh.indices[indexOffset]);
      const second = mapVertex(mesh.indices[indexOffset + 1]);
      const third = mapVertex(mesh.indices[indexOffset + 2]);
      if (first !== second && second !== third && third !== first) mergedIndices.push(first, second, third);
    }
    if (mergedIndices.length / 3 > MAX_SAFE_JS_ACCUMULATED_TRIANGLES) {
      // #WDD-gpt 2026-08-15 - The WASM fallback shares the same JS-side topology accumulator and must fail recoverably before renderer OOM.
      throw new BrowserTopologyBudgetError('WASM 精细表面超过浏览器安全内存预算（125 万三角形）。已保留快速预览；请改用 2 mm 或 40K Gaussian。');
    }
    if (mergedIndices.length / 3 > 10_000_000 && clusterVoxelSize < 4) {
      // #WDD-gpt 2026-08-15 - Recluster only oversized topology; averaging at 2 then 4 voxels preserves the sampled field while preventing unbounded JS index growth.
      recluster(clusterVoxelSize < 1 ? 2 : clusterVoxelSize * 2);
    }
    if (mergedIndices.length / 3 > MAX_WASM_FINAL_TRIANGLES * 1.5) {
      throw new Error('WASM 流式 Marching Cubes 的中间三角形超过 1,800 万，浏览器内存不足以安全完成最终连通分量过滤。');
    }
  };
  const totalSlabs = plan.brickDimensions[2];
  for (let slabStartZ = 0; slabStartZ < totalSlabs; slabStartZ += SPARSE_BRICK_SLAB_DEPTH) {
    const slabEndZ = Math.min(totalSlabs, slabStartZ + SPARSE_BRICK_SLAB_DEPTH);
    const gaussianIdsByBrick = new Map<number, number[]>();
    const slabOrigins = buildActiveBrickSlab(input, plan, slabStartZ, slabEndZ, (brickId, gaussianId) => {
      const ids = gaussianIdsByBrick.get(brickId);
      if (ids) ids.push(gaussianId);
      else gaussianIdsByBrick.set(brickId, [gaussianId]);
    }, wrapRadius);
    const slabBrickCount = slabOrigins.length / 4;
    brickCount += slabBrickCount;
    for (let localBrick = 0; localBrick < slabBrickCount; localBrick += 1) {
      field.fill(0);
      best.fill(0);
      winner.fill(0);
      const originOffset = localBrick * 4;
      const originX = slabOrigins[originOffset];
      const originY = slabOrigins[originOffset + 1];
      const originZ = slabOrigins[originOffset + 2];
      const brickX = originX / plan.brickSize;
      const brickY = originY / plan.brickSize;
      const brickZ = originZ / plan.brickSize;
      const brickId = (brickZ * plan.brickDimensions[1] + brickY) * plan.brickDimensions[0] + brickX;
      const localMinimum: [number, number, number] = [
        plan.minimum[0] + originX * plan.spacing,
        plan.minimum[1] + originY * plan.spacing,
        plan.minimum[2] + originZ * plan.spacing,
      ];
      for (const gaussianId of gaussianIdsByBrick.get(brickId) ?? []) {
        const positionOffset = gaussianId * 3;
        const rotationOffset = gaussianId * 4;
        const centerX = (input.positions[positionOffset] - localMinimum[0]) / plan.spacing;
        const centerY = (input.positions[positionOffset + 1] - localMinimum[1]) / plan.spacing;
        const centerZ = (input.positions[positionOffset + 2] - localMinimum[2]) / plan.spacing;
        const scaleX = Math.max(1e-7, Math.hypot(input.scales[positionOffset], wrapRadius));
        const scaleY = Math.max(1e-7, Math.hypot(input.scales[positionOffset + 1], wrapRadius));
        const scaleZ = Math.max(1e-7, Math.hypot(input.scales[positionOffset + 2], wrapRadius));
        const rawX = input.rotations[rotationOffset];
        const rawY = input.rotations[rotationOffset + 1];
        const rawZ = input.rotations[rotationOffset + 2];
        const rawW = input.rotations[rotationOffset + 3];
        const inverseLength = 1 / Math.max(1e-12, Math.hypot(rawX, rawY, rawZ, rawW));
        const x = rawX * inverseLength;
        const y = rawY * inverseLength;
        const z = rawZ * inverseLength;
        const w = rawW * inverseLength;
        const r00 = 1 - 2 * (y * y + z * z);
        const r01 = 2 * (x * y - z * w);
        const r02 = 2 * (x * z + y * w);
        const r10 = 2 * (x * y + z * w);
        const r11 = 1 - 2 * (x * x + z * z);
        const r12 = 2 * (y * z - x * w);
        const r20 = 2 * (x * z - y * w);
        const r21 = 2 * (y * z + x * w);
        const r22 = 1 - 2 * (x * x + y * y);
        const radiusX = 3 * Math.hypot(r00 * scaleX, r01 * scaleY, r02 * scaleZ) / plan.spacing;
        const radiusY = 3 * Math.hypot(r10 * scaleX, r11 * scaleY, r12 * scaleZ) / plan.spacing;
        const radiusZ = 3 * Math.hypot(r20 * scaleX, r21 * scaleY, r22 * scaleZ) / plan.spacing;
        const minX = Math.max(0, Math.floor(centerX - radiusX));
        const maxX = Math.min(pointsPerAxis - 1, Math.ceil(centerX + radiusX));
        const minY = Math.max(0, Math.floor(centerY - radiusY));
        const maxY = Math.min(pointsPerAxis - 1, Math.ceil(centerY + radiusY));
        const minZ = Math.max(0, Math.floor(centerZ - radiusZ));
        const maxZ = Math.min(pointsPerAxis - 1, Math.ceil(centerZ + radiusZ));
        if (minX > maxX || minY > maxY || minZ > maxZ) continue;
        core.opacity_splat(
          fieldPointer,
          bestPointer,
          winnerPointer,
          pointsPerAxis,
          pointsPerAxis,
          minX,
          maxX,
          minY,
          maxY,
          minZ,
          maxZ,
          centerX,
          centerY,
          centerZ,
          r00 * plan.spacing / scaleX,
          r10 * plan.spacing / scaleX,
          r20 * plan.spacing / scaleX,
          r01 * plan.spacing / scaleY,
          r11 * plan.spacing / scaleY,
          r21 * plan.spacing / scaleY,
          r02 * plan.spacing / scaleZ,
          r12 * plan.spacing / scaleZ,
          r22 * plan.spacing / scaleZ,
          input.opacities[gaussianId],
          gaussianId,
        );
      }
      applyVisualHullMaskToBrick(field, winner, localMinimum, plan.spacing, pointsPerAxis, hull);
      const local = extractMarchingCubesPartition({
        field,
        winner,
        dimX: pointsPerAxis,
        dimY: pointsPerAxis,
        dimZ: pointsPerAxis,
        minimum: localMinimum,
        spacing: plan.spacing,
      }, input);
      if (local.indices.length) appendBrick(local);
      if ((localBrick & 7) === 7) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    // #WDD-gpt 2026-08-15 - WebGPU-less browsers retain the requested metric spacing by recycling one 17-cubed WASM field per brick and one Z-layer candidate map.
    report(requestId, 'fusing', slabEndZ / Math.max(1, totalSlabs) * 0.82);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  if (!brickCount) throw new Error('当前帧没有可计算的非空 WASM 分区。');
  for (let vertex = 0; vertex < clusterCounts.length; vertex += 1) {
    const count = Math.max(1, clusterCounts[vertex]);
    mergedPositions[vertex * 3] /= count;
    mergedPositions[vertex * 3 + 1] /= count;
    mergedPositions[vertex * 3 + 2] /= count;
    mergedColors[vertex * 4] = Math.round(mergedColors[vertex * 4] / count);
    mergedColors[vertex * 4 + 1] = Math.round(mergedColors[vertex * 4 + 1] / count);
    mergedColors[vertex * 4 + 2] = Math.round(mergedColors[vertex * 4 + 2] / count);
    mergedColors[vertex * 4 + 3] = 255;
  }
  const filtered = filterComponents(mergedPositions, mergedColors, mergedIndices);
  if (filtered.indices.length < 30) throw new Error('WASM 分区不透明度场没有提取到足够的连续表面。');
  if (filtered.indices.length / 3 > MAX_WASM_FINAL_TRIANGLES) {
    throw new Error('WASM 最终有效表面超过 1,200 万三角形，请改用更大的目标叶子体素。');
  }
  const positions = Float32Array.from(filtered.positions);
  const indices = Uint32Array.from(filtered.indices);
  const actualResolution = Math.max(...plan.dimensions);
  const physicalSpacing = input.sceneUnitMillimeters
    ? ` / ${(plan.spacing * input.sceneUnitMillimeters).toFixed(3)} mm leaf`
    : '';
  return {
    mesh: {
      positions,
      normals: calculateVertexNormals(positions, indices),
      colors: Uint8Array.from(filtered.colors),
      indices,
    },
    brackets: new Float32Array(0),
    spacing: plan.spacing,
    activeBrickCount: brickCount,
    backend: `WASM Gaussian alpha wrap ${actualResolution}³ virtual${physicalSpacing}, 1.5-voxel anisotropic envelope, streamed sparse 16³ bricks (${brickCount.toLocaleString()} active, 1 Z layer registry) + Visual Hull + welded standard Marching Cubes${clusterVoxelSize >= 1 ? ` + adaptive ${clusterVoxelSize} voxel vertex clustering` : ''}`,
  };
}

async function refineGofSurface(
  input: GS2MeshGaussianFieldInput,
  extraction: GofSurfaceExtraction,
  iterations = 8,
): Promise<GS2MeshData> {
  const vertexCount = extraction.mesh.positions.length / 3;
  if (extraction.brackets.length !== vertexCount * 6) {
    throw new Error('GOF 高精度回投缺少完整的等值面交边。');
  }
  const device = await requestReusableGpuDevice();
  const topologyResolution = topologyResolutionFor(input.fieldResolution);
  const { minimum, dimensions, spacing } = robustFieldBounds(input, topologyResolution);
  const hull = buildVisualHull(input, 256);
  const sparse = buildRayTileGaussianData(input, minimum, dimensions, spacing, hull.resolution);
  const batchCapacity = Math.min(GOF_REFINEMENT_BATCH_VERTICES, Math.max(1, vertexCount));
  const positions = new Float32Array(vertexCount * 3);
  const buffers: GPUBuffer[] = [];
  try {
    const params = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const gaussians = createGpuBuffer(device, sparse.gaussians, GPUBufferUsage.STORAGE);
    const tileOffsets = createGpuBuffer(device, sparse.blockOffsets, GPUBufferUsage.STORAGE);
    const tileGaussianIds = createGpuBuffer(device, sparse.blockGaussianIds, GPUBufferUsage.STORAGE);
    const views = createGpuBuffer(device, hull.views, GPUBufferUsage.STORAGE);
    const masks = createGpuBuffer(device, hull.masks, GPUBufferUsage.STORAGE);
    const brackets = device.createBuffer({
      size: batchCapacity * 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const output = device.createBuffer({
      size: batchCapacity * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const readback = device.createBuffer({
      size: batchCapacity * 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    buffers.push(params, gaussians, tileOffsets, tileGaussianIds, views, masks, brackets, output, readback);
    const module = device.createShaderModule({ code: GOF_EDGE_REFINEMENT_SHADER });
    const compilation = await module.getCompilationInfo();
    const shaderErrors = compilation.messages.filter((message) => message.type === 'error');
    if (shaderErrors.length) throw new Error(`GOF 高精度 shader 编译失败：${shaderErrors[0].message}`);
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [params, gaussians, tileOffsets, tileGaussianIds, views, masks, brackets, output].map((buffer, binding) => ({
        binding,
        resource: { buffer },
      })),
    });
    for (let batchStart = 0; batchStart < vertexCount; batchStart += batchCapacity) {
      const currentCount = Math.min(batchCapacity, vertexCount - batchStart);
      const packedBrackets = new Float32Array(currentCount * 8);
      for (let localIndex = 0; localIndex < currentCount; localIndex += 1) {
        const source = (batchStart + localIndex) * 6;
        const target = localIndex * 8;
        packedBrackets.set(extraction.brackets.subarray(source, source + 3), target);
        packedBrackets.set(extraction.brackets.subarray(source + 3, source + 6), target + 4);
      }
      const paramsBuffer = new ArrayBuffer(48);
      const paramsU32 = new Uint32Array(paramsBuffer);
      const paramsF32 = new Float32Array(paramsBuffer);
      paramsU32.set([currentCount, hull.viewCount, hull.resolution, Math.max(1, Math.min(8, iterations))], 0);
      paramsU32.set([sparse.blockDimensions[0], sparse.blockDimensions[1], sparse.blockSize, 0], 4);
      paramsF32.set([input.isoLevel, 0, 0, 0], 8);
      device.queue.writeBuffer(params, 0, paramsBuffer);
      device.queue.writeBuffer(brackets, 0, packedBrackets);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(currentCount / 64));
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, currentCount * 16);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ, 0, currentCount * 16);
      const packedPositions = new Float32Array(readback.getMappedRange(0, currentCount * 16));
      for (let localIndex = 0; localIndex < currentCount; localIndex += 1) {
        const target = (batchStart + localIndex) * 3;
        positions[target] = packedPositions[localIndex * 4];
        positions[target + 1] = packedPositions[localIndex * 4 + 1];
        positions[target + 2] = packedPositions[localIndex * 4 + 2];
      }
      readback.unmap();
      // #WDD-gpt 2026-08-15 - Reuse one 65K-vertex projection buffer so high-resolution meshes never require a second full GPU copy.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    // #WDD-gpt 2026-08-15 - Eight exact GOF bisections reduce edge-local surface quantization by 256x without a cubic memory increase.
    return {
      positions,
      normals: calculateVertexNormals(positions, extraction.mesh.indices),
      colors: extraction.mesh.colors,
      indices: extraction.mesh.indices,
    };
  } finally {
    for (const buffer of buffers) buffer.destroy();
    device.destroy();
  }
}

export function splatOpacityField(
  core: GS2MeshOpacityCoreExports,
  input: GS2MeshGaussianFieldInput,
  requestId: number,
  progressStage: GS2MeshOpacityWorkerStage = 'matching',
): FieldGrid {
  const { minimum, dimensions, spacing } = robustFieldBounds(input);
  const [dimX, dimY, dimZ] = dimensions;
  const voxelCount = dimX * dimY * dimZ;
  core.reset();
  const fieldPointer = core.alloc(voxelCount * Float32Array.BYTES_PER_ELEMENT);
  const bestPointer = core.alloc(voxelCount * Float32Array.BYTES_PER_ELEMENT);
  const winnerPointer = core.alloc(voxelCount * Uint32Array.BYTES_PER_ELEMENT);
  const field = new Float32Array(core.memory.buffer, fieldPointer, voxelCount);
  const best = new Float32Array(core.memory.buffer, bestPointer, voxelCount);
  const winner = new Uint32Array(core.memory.buffer, winnerPointer, voxelCount);
  field.fill(0);
  best.fill(0);
  winner.fill(0);

  const count = input.positions.length / 3;
  for (let index = 0; index < count; index += 1) {
    const positionOffset = index * 3;
    const rotationOffset = index * 4;
    const centerX = (input.positions[positionOffset] - minimum[0]) / spacing;
    const centerY = (input.positions[positionOffset + 1] - minimum[1]) / spacing;
    const centerZ = (input.positions[positionOffset + 2] - minimum[2]) / spacing;
    if (centerX < -16 || centerY < -16 || centerZ < -16
      || centerX > dimX + 15 || centerY > dimY + 15 || centerZ > dimZ + 15) continue;

    // #WDD-gpt 2026-08-15 - Keep the WebGPU preview and WASM refinement on the same oriented Gaussian kernel sizing.
    const [scaleX, scaleY, scaleZ] = effectiveScales(input, index, spacing);
    const radius = Math.min(24, Math.max(2, Math.ceil(Math.max(scaleX, scaleY, scaleZ) * 3 / spacing)));
    const minX = Math.max(0, Math.floor(centerX - radius));
    const maxX = Math.min(dimX - 1, Math.ceil(centerX + radius));
    const minY = Math.max(0, Math.floor(centerY - radius));
    const maxY = Math.min(dimY - 1, Math.ceil(centerY + radius));
    const minZ = Math.max(0, Math.floor(centerZ - radius));
    const maxZ = Math.min(dimZ - 1, Math.ceil(centerZ + radius));
    if (minX > maxX || minY > maxY || minZ > maxZ) continue;

    const x = input.rotations[rotationOffset];
    const y = input.rotations[rotationOffset + 1];
    const z = input.rotations[rotationOffset + 2];
    const w = input.rotations[rotationOffset + 3];
    const r00 = 1 - 2 * (y * y + z * z);
    const r01 = 2 * (x * y - z * w);
    const r02 = 2 * (x * z + y * w);
    const r10 = 2 * (x * y + z * w);
    const r11 = 1 - 2 * (x * x + z * z);
    const r12 = 2 * (y * z - x * w);
    const r20 = 2 * (x * z - y * w);
    const r21 = 2 * (y * z + x * w);
    const r22 = 1 - 2 * (x * x + y * y);
    core.opacity_splat(
      fieldPointer,
      bestPointer,
      winnerPointer,
      dimX,
      dimY,
      minX,
      maxX,
      minY,
      maxY,
      minZ,
      maxZ,
      centerX,
      centerY,
      centerZ,
      r00 * spacing / scaleX,
      r10 * spacing / scaleX,
      r20 * spacing / scaleX,
      r01 * spacing / scaleY,
      r11 * spacing / scaleY,
      r21 * spacing / scaleY,
      r02 * spacing / scaleZ,
      r12 * spacing / scaleZ,
      r22 * spacing / scaleZ,
      input.opacities[index],
      index,
    );
    if ((index & 1023) === 0) report(requestId, progressStage, index / Math.max(1, count));
  }
  pinFieldBorder(field, dimX, dimY, dimZ);
  report(requestId, progressStage, 1);
  return { field, winner, dimX, dimY, dimZ, minimum, spacing };
}

function normalize(x: number, y: number, z: number): [number, number, number] {
  const length = Math.hypot(x, y, z);
  return length > 1e-12 ? [x / length, y / length, z / length] : [0, 1, 0];
}

function filterComponents(
  positions: number[],
  colors: number[],
  indices: number[],
  brackets: number[] = [],
): { positions: number[]; colors: number[]; indices: number[]; brackets: number[] } {
  const vertexCount = positions.length / 3;
  const parent = new Int32Array(vertexCount);
  const rank = new Uint8Array(vertexCount);
  for (let index = 0; index < vertexCount; index += 1) parent[index] = index;
  const find = (value: number): number => {
    let root = value;
    while (parent[root] !== root) root = parent[root];
    while (parent[value] !== value) {
      const next = parent[value];
      parent[value] = root;
      value = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    let leftRoot = find(left);
    let rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    if (rank[leftRoot] < rank[rightRoot]) [leftRoot, rightRoot] = [rightRoot, leftRoot];
    parent[rightRoot] = leftRoot;
    if (rank[leftRoot] === rank[rightRoot]) rank[leftRoot] += 1;
  };
  for (let offset = 0; offset < indices.length; offset += 3) {
    union(indices[offset], indices[offset + 1]);
    union(indices[offset], indices[offset + 2]);
  }
  const triangleCounts = new Map<number, number>();
  let largest = 0;
  for (let offset = 0; offset < indices.length; offset += 3) {
    const root = find(indices[offset]);
    const count = (triangleCounts.get(root) ?? 0) + 1;
    triangleCounts.set(root, count);
    largest = Math.max(largest, count);
  }
  const minimumTriangles = Math.max(24, Math.floor(largest * 0.0015));
  const keep = new Set([...triangleCounts].filter(([, count]) => count >= minimumTriangles).map(([root]) => root));
  const remap = new Int32Array(vertexCount);
  remap.fill(-1);
  const filteredPositions: number[] = [];
  const filteredColors: number[] = [];
  const filteredIndices: number[] = [];
  const filteredBrackets: number[] = [];
  for (let offset = 0; offset < indices.length; offset += 3) {
    if (!keep.has(find(indices[offset]))) continue;
    for (let corner = 0; corner < 3; corner += 1) {
      const oldIndex = indices[offset + corner];
      let nextIndex = remap[oldIndex];
      if (nextIndex < 0) {
        nextIndex = filteredPositions.length / 3;
        remap[oldIndex] = nextIndex;
        filteredPositions.push(
          positions[oldIndex * 3],
          positions[oldIndex * 3 + 1],
          positions[oldIndex * 3 + 2],
        );
        filteredColors.push(
          colors[oldIndex * 4],
          colors[oldIndex * 4 + 1],
          colors[oldIndex * 4 + 2],
          colors[oldIndex * 4 + 3],
        );
        if (brackets.length) {
          filteredBrackets.push(
            brackets[oldIndex * 6],
            brackets[oldIndex * 6 + 1],
            brackets[oldIndex * 6 + 2],
            brackets[oldIndex * 6 + 3],
            brackets[oldIndex * 6 + 4],
            brackets[oldIndex * 6 + 5],
          );
        }
      }
      filteredIndices.push(nextIndex);
    }
  }
  return {
    positions: filteredPositions,
    colors: filteredColors,
    indices: filteredIndices,
    brackets: filteredBrackets,
  };
}

function calculateVertexNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = indices[offset] * 3;
    const b = indices[offset + 1] * 3;
    const c = indices[offset + 2] * 3;
    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    for (const vertex of [a, b, c]) {
      normals[vertex] += nx;
      normals[vertex + 1] += ny;
      normals[vertex + 2] += nz;
    }
  }
  for (let offset = 0; offset < normals.length; offset += 3) {
    const [x, y, z] = normalize(normals[offset], normals[offset + 1], normals[offset + 2]);
    normals[offset] = x;
    normals[offset + 1] = y;
    normals[offset + 2] = z;
  }
  return normals;
}

function calculateAngleWeightedNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let offset = 0; offset < indices.length; offset += 3) {
    const vertices = [indices[offset], indices[offset + 1], indices[offset + 2]];
    const points = vertices.map((vertex) => [
      positions[vertex * 3],
      positions[vertex * 3 + 1],
      positions[vertex * 3 + 2],
    ] as const);
    const firstEdge = [points[1][0] - points[0][0], points[1][1] - points[0][1], points[1][2] - points[0][2]] as const;
    const secondEdge = [points[2][0] - points[0][0], points[2][1] - points[0][1], points[2][2] - points[0][2]] as const;
    const face = normalize(
      firstEdge[1] * secondEdge[2] - firstEdge[2] * secondEdge[1],
      firstEdge[2] * secondEdge[0] - firstEdge[0] * secondEdge[2],
      firstEdge[0] * secondEdge[1] - firstEdge[1] * secondEdge[0],
    );
    for (let corner = 0; corner < 3; corner += 1) {
      const center = points[corner];
      const left = points[(corner + 1) % 3];
      const right = points[(corner + 2) % 3];
      const leftX = left[0] - center[0];
      const leftY = left[1] - center[1];
      const leftZ = left[2] - center[2];
      const rightX = right[0] - center[0];
      const rightY = right[1] - center[1];
      const rightZ = right[2] - center[2];
      const denominator = Math.max(1e-20, Math.hypot(leftX, leftY, leftZ) * Math.hypot(rightX, rightY, rightZ));
      const angle = Math.acos(Math.max(-1, Math.min(1, (leftX * rightX + leftY * rightY + leftZ * rightZ) / denominator)));
      const normalOffset = vertices[corner] * 3;
      normals[normalOffset] += face[0] * angle;
      normals[normalOffset + 1] += face[1] * angle;
      normals[normalOffset + 2] += face[2] * angle;
    }
  }
  for (let offset = 0; offset < normals.length; offset += 3) {
    const normal = normalize(normals[offset], normals[offset + 1], normals[offset + 2]);
    normals.set(normal, offset);
  }
  return normals;
}

export function smoothFeaturePreservingMesh(
  mesh: GS2MeshData,
  targetSpacing: number,
  requestedIterations: number,
): GS2MeshData {
  const iterations = Math.max(0, Math.min(5, Math.round(requestedIterations)));
  const vertexCount = mesh.positions.length / 3;
  if (!iterations || vertexCount < 4) return mesh;
  const counts = new Uint32Array(vertexCount);
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    counts[mesh.indices[offset]] += 2;
    counts[mesh.indices[offset + 1]] += 2;
    counts[mesh.indices[offset + 2]] += 2;
  }
  const offsets = new Uint32Array(vertexCount + 1);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) offsets[vertex + 1] = offsets[vertex] + counts[vertex];
  const cursors = offsets.slice(0, vertexCount);
  const neighbours = new Uint32Array(offsets[vertexCount]);
  const connect = (first: number, second: number): void => {
    neighbours[cursors[first]] = second;
    cursors[first] += 1;
  };
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const a = mesh.indices[offset];
    const b = mesh.indices[offset + 1];
    const c = mesh.indices[offset + 2];
    connect(a, b); connect(a, c);
    connect(b, a); connect(b, c);
    connect(c, a); connect(c, b);
  }
  const anchors = mesh.positions;
  let positions = mesh.positions.slice();
  const spatialSigma = Math.max(1e-8, targetSpacing * 2.5);
  const inverseSpatialVariance = 1 / (2 * spatialSigma * spatialSigma);
  const inverseNormalVariance = 1 / (2 * 0.18 * 0.18);
  const maximumNeighbourDistanceSquared = (targetSpacing * 4.5) ** 2;
  const maximumStep = targetSpacing * 0.25;
  const maximumDrift = targetSpacing * 0.5;
  const creaseCosine = Math.cos(35 * Math.PI / 180);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const normals = calculateVertexNormals(positions, mesh.indices);
    const next = positions.slice();
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const positionOffset = vertex * 3;
      const nx = normals[positionOffset];
      const ny = normals[positionOffset + 1];
      const nz = normals[positionOffset + 2];
      let weightedHeight = 0;
      let weightSum = 0;
      for (let cursor = offsets[vertex]; cursor < offsets[vertex + 1]; cursor += 1) {
        const neighbour = neighbours[cursor];
        const neighbourOffset = neighbour * 3;
        const normalDot = nx * normals[neighbourOffset]
          + ny * normals[neighbourOffset + 1]
          + nz * normals[neighbourOffset + 2];
        if (normalDot < creaseCosine) continue;
        const dx = positions[neighbourOffset] - positions[positionOffset];
        const dy = positions[neighbourOffset + 1] - positions[positionOffset + 1];
        const dz = positions[neighbourOffset + 2] - positions[positionOffset + 2];
        const distanceSquared = dx * dx + dy * dy + dz * dz;
        if (distanceSquared > maximumNeighbourDistanceSquared) continue;
        const height = dx * nx + dy * ny + dz * nz;
        const normalDifference = 1 - Math.max(-1, Math.min(1, normalDot));
        const weight = Math.exp(-distanceSquared * inverseSpatialVariance)
          * Math.exp(-normalDifference * normalDifference * inverseNormalVariance);
        weightedHeight += height * weight;
        weightSum += weight;
      }
      if (weightSum <= 1e-8) continue;
      const displacement = Math.max(-maximumStep, Math.min(maximumStep, weightedHeight / weightSum * 0.45));
      let candidateX = positions[positionOffset] + nx * displacement;
      let candidateY = positions[positionOffset + 1] + ny * displacement;
      let candidateZ = positions[positionOffset + 2] + nz * displacement;
      const anchorX = candidateX - anchors[positionOffset];
      const anchorY = candidateY - anchors[positionOffset + 1];
      const anchorZ = candidateZ - anchors[positionOffset + 2];
      const drift = Math.hypot(anchorX, anchorY, anchorZ);
      if (drift > maximumDrift) {
        const scale = maximumDrift / drift;
        candidateX = anchors[positionOffset] + anchorX * scale;
        candidateY = anchors[positionOffset + 1] + anchorY * scale;
        candidateZ = anchors[positionOffset + 2] + anchorZ * scale;
      }
      next[positionOffset] = candidateX;
      next[positionOffset + 1] = candidateY;
      next[positionOffset + 2] = candidateZ;
    }
    positions = next;
  }
  const finalNormals = calculateAngleWeightedNormals(positions, mesh.indices);
  let colors = mesh.colors.slice();
  const inverseColorVariance = 1 / (2 * 45 * 45);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const nextColors = colors.slice();
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const positionOffset = vertex * 3;
      const colorOffset = vertex * 4;
      let red = colors[colorOffset] * 2;
      let green = colors[colorOffset + 1] * 2;
      let blue = colors[colorOffset + 2] * 2;
      let weightSum = 2;
      for (let cursor = offsets[vertex]; cursor < offsets[vertex + 1]; cursor += 1) {
        const neighbour = neighbours[cursor];
        const neighbourPositionOffset = neighbour * 3;
        const normalDot = finalNormals[positionOffset] * finalNormals[neighbourPositionOffset]
          + finalNormals[positionOffset + 1] * finalNormals[neighbourPositionOffset + 1]
          + finalNormals[positionOffset + 2] * finalNormals[neighbourPositionOffset + 2];
        if (normalDot < creaseCosine) continue;
        const neighbourColorOffset = neighbour * 4;
        const redDifference = colors[neighbourColorOffset] - colors[colorOffset];
        const greenDifference = colors[neighbourColorOffset + 1] - colors[colorOffset + 1];
        const blueDifference = colors[neighbourColorOffset + 2] - colors[colorOffset + 2];
        const weight = Math.exp(-(
          redDifference * redDifference
          + greenDifference * greenDifference
          + blueDifference * blueDifference
        ) * inverseColorVariance);
        red += colors[neighbourColorOffset] * weight;
        green += colors[neighbourColorOffset + 1] * weight;
        blue += colors[neighbourColorOffset + 2] * weight;
        weightSum += weight;
      }
      nextColors[colorOffset] = Math.round(red / weightSum);
      nextColors[colorOffset + 1] = Math.round(green / weightSum);
      nextColors[colorOffset + 2] = Math.round(blue / weightSum);
      nextColors[colorOffset + 3] = 255;
    }
    colors = nextColors;
  }
  // #WDD-gpt 2026-08-15 - Bilateral geometry and vertex-color filtering are capped in space and stop across 35-degree creases.
  return {
    positions,
    normals: finalNormals,
    colors,
    indices: mesh.indices,
  };
}

function blendGofConstrainedMesh(
  smoothed: GS2MeshData,
  projected: GS2MeshData,
  gofWeight = 0.65,
): GS2MeshData {
  const positions = new Float32Array(smoothed.positions.length);
  for (let offset = 0; offset < positions.length; offset += 1) {
    positions[offset] = smoothed.positions[offset] * (1 - gofWeight) + projected.positions[offset] * gofWeight;
  }
  // #WDD-gpt 2026-08-15 - Retain most of the GOF constraint while leaving a bounded portion of the denoised surface instead of snapping all noise back.
  return {
    positions,
    normals: calculateAngleWeightedNormals(positions, smoothed.indices),
    colors: smoothed.colors,
    indices: smoothed.indices,
  };
}

function subdivideMesh(mesh: GS2MeshData): GS2MeshData {
  const positions = Array.from(mesh.positions);
  const colors = Array.from(mesh.colors);
  const indices: number[] = [];
  const sourceVertexCount = mesh.positions.length / 3;
  const edgeMidpoints = new Map<number, number>();
  const midpoint = (first: number, second: number): number => {
    const low = Math.min(first, second);
    const high = Math.max(first, second);
    const key = low * sourceVertexCount + high;
    const cached = edgeMidpoints.get(key);
    if (cached !== undefined) return cached;
    const next = positions.length / 3;
    edgeMidpoints.set(key, next);
    positions.push(
      (mesh.positions[first * 3] + mesh.positions[second * 3]) * 0.5,
      (mesh.positions[first * 3 + 1] + mesh.positions[second * 3 + 1]) * 0.5,
      (mesh.positions[first * 3 + 2] + mesh.positions[second * 3 + 2]) * 0.5,
    );
    colors.push(
      Math.round((mesh.colors[first * 4] + mesh.colors[second * 4]) * 0.5),
      Math.round((mesh.colors[first * 4 + 1] + mesh.colors[second * 4 + 1]) * 0.5),
      Math.round((mesh.colors[first * 4 + 2] + mesh.colors[second * 4 + 2]) * 0.5),
      255,
    );
    return next;
  };
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const a = mesh.indices[offset];
    const b = mesh.indices[offset + 1];
    const c = mesh.indices[offset + 2];
    const ab = midpoint(a, b);
    const bc = midpoint(b, c);
    const ca = midpoint(c, a);
    indices.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  const typedPositions = Float32Array.from(positions);
  const typedIndices = Uint32Array.from(indices);
  return {
    positions: typedPositions,
    normals: calculateVertexNormals(typedPositions, typedIndices),
    colors: Uint8Array.from(colors),
    indices: typedIndices,
  };
}

function normalProjectionBrackets(mesh: GS2MeshData, halfWidth: number): GofSurfaceExtraction {
  const normals = mesh.normals ?? calculateVertexNormals(mesh.positions, mesh.indices);
  const brackets = new Float32Array(mesh.positions.length * 2);
  for (let index = 0; index < mesh.positions.length / 3; index += 1) {
    const positionOffset = index * 3;
    const bracketOffset = index * 6;
    brackets[bracketOffset] = mesh.positions[positionOffset] - normals[positionOffset] * halfWidth;
    brackets[bracketOffset + 1] = mesh.positions[positionOffset + 1] - normals[positionOffset + 1] * halfWidth;
    brackets[bracketOffset + 2] = mesh.positions[positionOffset + 2] - normals[positionOffset + 2] * halfWidth;
    brackets[bracketOffset + 3] = mesh.positions[positionOffset] + normals[positionOffset] * halfWidth;
    brackets[bracketOffset + 4] = mesh.positions[positionOffset + 1] + normals[positionOffset + 1] * halfWidth;
    brackets[bracketOffset + 5] = mesh.positions[positionOffset + 2] + normals[positionOffset + 2] * halfWidth;
  }
  return { mesh, brackets };
}

function precisionSubdivisionRounds(mesh: GS2MeshData, requestedResolution: number): number {
  const triangles = mesh.indices.length / 3;
  const sparseResolution = Math.max(48, Math.min(MAX_SPARSE_FIELD_RESOLUTION, requestedResolution));
  const targetRounds = Math.max(2, Math.ceil(Math.log2(sparseResolution / topologyResolutionFor(sparseResolution))));
  let rounds = 0;
  while (rounds < targetRounds && triangles * (4 ** (rounds + 1)) <= MAX_PROJECTED_TRIANGLES) rounds += 1;
  return rounds;
}

function extractMarchingCubesPartition(
  grid: FieldGrid,
  input: GS2MeshGaussianFieldInput,
): GS2MeshData {
  const { field, winner, dimX, dimY, dimZ, minimum, spacing } = grid;
  const maximum = [
    minimum[0] + spacing * dimX,
    minimum[1] + spacing * dimY,
    minimum[2] + spacing * dimZ,
  ] as const;
  const surface = marchingCubes(
    [dimX, dimY, dimZ],
    (worldX, worldY, worldZ) => {
      const x = Math.max(0, Math.min(dimX - 1, Math.round((worldX - minimum[0]) / spacing)));
      const y = Math.max(0, Math.min(dimY - 1, Math.round((worldY - minimum[1]) / spacing)));
      const z = Math.max(0, Math.min(dimZ - 1, Math.round((worldZ - minimum[2]) / spacing)));
      return field[(z * dimY + y) * dimX + x] - input.isoLevel;
    },
    [minimum, maximum],
  );
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const remap = new Int32Array(surface.positions.length);
  remap.fill(-1);
  const welded = new Map<string, number>();
  const inverseWeld = 1 / Math.max(1e-8, spacing * 1e-4);
  const mapVertex = (oldIndex: number): number => {
    const cached = remap[oldIndex];
    if (cached >= 0) return cached;
    const point = surface.positions[oldIndex];
    const key = `${Math.round(point[0] * inverseWeld)},${Math.round(point[1] * inverseWeld)},${Math.round(point[2] * inverseWeld)}`;
    const existing = welded.get(key);
    if (existing !== undefined) {
      remap[oldIndex] = existing;
      return existing;
    }
    const next = positions.length / 3;
    remap[oldIndex] = next;
    welded.set(key, next);
    positions.push(point[0], point[1], point[2]);
    const x = Math.max(0, Math.min(dimX - 1, Math.round((point[0] - minimum[0]) / spacing)));
    const y = Math.max(0, Math.min(dimY - 1, Math.round((point[1] - minimum[1]) / spacing)));
    const z = Math.max(0, Math.min(dimZ - 1, Math.round((point[2] - minimum[2]) / spacing)));
    const gaussianIndex = Math.min(input.colors.length / 4 - 1, winner[(z * dimY + y) * dimX + x]);
    colors.push(
      input.colors[gaussianIndex * 4],
      input.colors[gaussianIndex * 4 + 1],
      input.colors[gaussianIndex * 4 + 2],
      255,
    );
    return next;
  };
  for (const cell of surface.cells) {
    const first = mapVertex(cell[0]);
    const second = mapVertex(cell[1]);
    const third = mapVertex(cell[2]);
    if (first !== second && second !== third && third !== first) indices.push(first, second, third);
  }
  const typedPositions = Float32Array.from(positions);
  const typedIndices = Uint32Array.from(indices);
  // #WDD-gpt 2026-08-15 - Standard Marching Cubes emits far fewer triangles than six-tetrahedra extraction at the same millimeter samples; global filtering remains deferred until all bricks are welded.
  return {
    positions: typedPositions,
    normals: null,
    colors: Uint8Array.from(colors),
    indices: typedIndices,
  };
}

export function extractMarchingCubesPreview(
  grid: FieldGrid,
  input: GS2MeshGaussianFieldInput,
): GS2MeshData {
  const { field, winner, dimX, dimY, dimZ, minimum, spacing } = grid;
  const maximum = [
    minimum[0] + spacing * dimX,
    minimum[1] + spacing * dimY,
    minimum[2] + spacing * dimZ,
  ] as const;
  const surface = marchingCubes(
    [dimX, dimY, dimZ],
    (worldX, worldY, worldZ) => {
      const x = Math.max(0, Math.min(dimX - 1, Math.round((worldX - minimum[0]) / spacing)));
      const y = Math.max(0, Math.min(dimY - 1, Math.round((worldY - minimum[1]) / spacing)));
      const z = Math.max(0, Math.min(dimZ - 1, Math.round((worldZ - minimum[2]) / spacing)));
      return field[(z * dimY + y) * dimX + x] - input.isoLevel;
    },
    [minimum, maximum],
  );
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const remap = new Int32Array(surface.positions.length);
  remap.fill(-1);
  const welded = new Map<string, number>();
  const inverseWeld = 1 / Math.max(1e-8, spacing * 1e-4);
  const mapVertex = (oldIndex: number): number => {
    const cached = remap[oldIndex];
    if (cached >= 0) return cached;
    const point = surface.positions[oldIndex];
    const key = `${Math.round(point[0] * inverseWeld)},${Math.round(point[1] * inverseWeld)},${Math.round(point[2] * inverseWeld)}`;
    const existing = welded.get(key);
    if (existing !== undefined) {
      remap[oldIndex] = existing;
      return existing;
    }
    const meshIndex = positions.length / 3;
    remap[oldIndex] = meshIndex;
    welded.set(key, meshIndex);
    positions.push(point[0], point[1], point[2]);
    const x = Math.max(0, Math.min(dimX - 1, Math.round((point[0] - minimum[0]) / spacing)));
    const y = Math.max(0, Math.min(dimY - 1, Math.round((point[1] - minimum[1]) / spacing)));
    const z = Math.max(0, Math.min(dimZ - 1, Math.round((point[2] - minimum[2]) / spacing)));
    const gaussianIndex = Math.min(input.colors.length / 4 - 1, winner[(z * dimY + y) * dimX + x]);
    colors.push(
      input.colors[gaussianIndex * 4],
      input.colors[gaussianIndex * 4 + 1],
      input.colors[gaussianIndex * 4 + 2],
      255,
    );
    return meshIndex;
  };
  for (const cell of surface.cells) {
    const a = mapVertex(cell[0]);
    const b = mapVertex(cell[1]);
    const c = mapVertex(cell[2]);
    if (a !== b && b !== c && c !== a) indices.push(a, b, c);
  }
  const filtered = filterComponents(positions, colors, indices);
  if (filtered.indices.length < 30) throw new Error('Visual Hull 占据场没有提取到足够的连续表面。');
  const typedPositions = Float32Array.from(filtered.positions);
  const typedIndices = Uint32Array.from(filtered.indices);
  return {
    positions: typedPositions,
    normals: calculateVertexNormals(typedPositions, typedIndices),
    colors: Uint8Array.from(filtered.colors),
    indices: typedIndices,
  };
}

export function extractSurfaceNetsPreview(
  grid: FieldGrid,
  input: GS2MeshGaussianFieldInput,
): GS2MeshData {
  const { field, winner, dimX, dimY, dimZ, minimum, spacing } = grid;
  const maximum = [
    minimum[0] + spacing * dimX,
    minimum[1] + spacing * dimY,
    minimum[2] + spacing * dimZ,
  ] as const;
  const surface = surfaceNets(
    [dimX, dimY, dimZ],
    (worldX, worldY, worldZ) => {
      const x = Math.max(0, Math.min(dimX - 1, Math.round((worldX - minimum[0]) / spacing)));
      const y = Math.max(0, Math.min(dimY - 1, Math.round((worldY - minimum[1]) / spacing)));
      const z = Math.max(0, Math.min(dimZ - 1, Math.round((worldZ - minimum[2]) / spacing)));
      return field[(z * dimY + y) * dimX + x] - input.isoLevel;
    },
    [minimum, maximum],
  );
  const positions: number[] = [];
  const colors: number[] = [];
  for (const point of surface.positions) {
    positions.push(point[0], point[1], point[2]);
    const x = Math.max(0, Math.min(dimX - 1, Math.round((point[0] - minimum[0]) / spacing)));
    const y = Math.max(0, Math.min(dimY - 1, Math.round((point[1] - minimum[1]) / spacing)));
    const z = Math.max(0, Math.min(dimZ - 1, Math.round((point[2] - minimum[2]) / spacing)));
    const gaussianIndex = Math.min(input.colors.length / 4 - 1, winner[(z * dimY + y) * dimX + x]);
    colors.push(
      input.colors[gaussianIndex * 4],
      input.colors[gaussianIndex * 4 + 1],
      input.colors[gaussianIndex * 4 + 2],
      255,
    );
  }
  const indices: number[] = [];
  for (const cell of surface.cells) {
    if (cell.length < 3) continue;
    const first = cell[0];
    for (let corner = 1; corner + 1 < cell.length; corner += 1) {
      const second = cell[corner];
      const third = cell[corner + 1];
      if (first !== second && second !== third && third !== first) indices.push(first, second, third);
    }
  }
  const filtered = filterComponents(positions, colors, indices);
  if (filtered.indices.length < 30) throw new Error('Surface Nets 快速预览没有提取到足够的连续表面。');
  const typedPositions = Float32Array.from(filtered.positions);
  const typedIndices = Uint32Array.from(filtered.indices);
  // #WDD-gpt 2026-08-15 - Surface Nets creates at most one vertex per intersected preview cell, bounding topology memory before the full metric job begins.
  return {
    positions: typedPositions,
    normals: calculateVertexNormals(typedPositions, typedIndices),
    colors: Uint8Array.from(filtered.colors),
    indices: typedIndices,
  };
}

function extractOpacitySurfaceWithBrackets(
  grid: FieldGrid,
  input: GS2MeshGaussianFieldInput,
  requestId: number,
  filterSmallComponents = true,
  reportSlices = true,
  generateNormals = true,
): GofSurfaceExtraction {
  const { field, winner, dimX, dimY, dimZ, minimum, spacing } = grid;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const brackets: number[] = [];
  const edgeVertices = new Map<number, number>();
  const isoLevel = input.isoLevel;
  const gridIndex = (x: number, y: number, z: number): number => (z * dimY + y) * dimX + x;
  const addEdgeVertex = (
    firstId: number,
    secondId: number,
    first: readonly [number, number, number],
    second: readonly [number, number, number],
  ): CrossingVertex => {
    const low = Math.min(firstId, secondId);
    const high = Math.max(firstId, secondId);
    const key = low * field.length + high;
    let meshIndex = edgeVertices.get(key);
    const firstValue = field[firstId];
    const secondValue = field[secondId];
    const denominator = secondValue - firstValue;
    const interpolation = Math.max(0, Math.min(1, Math.abs(denominator) > 1e-8
      ? (isoLevel - firstValue) / denominator
      : 0.5));
    const x = first[0] + (second[0] - first[0]) * interpolation;
    const y = first[1] + (second[1] - first[1]) * interpolation;
    const z = first[2] + (second[2] - first[2]) * interpolation;
    if (meshIndex === undefined) {
      meshIndex = positions.length / 3;
      edgeVertices.set(key, meshIndex);
      positions.push(minimum[0] + x * spacing, minimum[1] + y * spacing, minimum[2] + z * spacing);
      brackets.push(
        minimum[0] + first[0] * spacing,
        minimum[1] + first[1] * spacing,
        minimum[2] + first[2] * spacing,
        minimum[0] + second[0] * spacing,
        minimum[1] + second[1] * spacing,
        minimum[2] + second[2] * spacing,
      );
      const gaussianIndex = winner[firstValue >= secondValue ? firstId : secondId];
      const colorOffset = Math.min(input.colors.length / 4 - 1, gaussianIndex) * 4;
      colors.push(
        input.colors[colorOffset],
        input.colors[colorOffset + 1],
        input.colors[colorOffset + 2],
        255,
      );
    }
    return { index: meshIndex, x, y, z };
  };
  const addTriangle = (
    first: CrossingVertex,
    second: CrossingVertex,
    third: CrossingVertex,
    desired: readonly [number, number, number],
  ): void => {
    const abx = second.x - first.x;
    const aby = second.y - first.y;
    const abz = second.z - first.z;
    const acx = third.x - first.x;
    const acy = third.y - first.y;
    const acz = third.z - first.z;
    const dot = (aby * acz - abz * acy) * desired[0]
      + (abz * acx - abx * acz) * desired[1]
      + (abx * acy - aby * acx) * desired[2];
    if (dot >= 0) indices.push(first.index, second.index, third.index);
    else indices.push(first.index, third.index, second.index);
  };

  for (let z = 0; z < dimZ - 1; z += 1) {
    for (let y = 0; y < dimY - 1; y += 1) {
      for (let x = 0; x < dimX - 1; x += 1) {
        const cubeIds = CORNERS.map((corner) => gridIndex(x + corner[0], y + corner[1], z + corner[2]));
        const cubeValues = cubeIds.map((id) => field[id]);
        if (cubeValues.every((value) => value < isoLevel)
          || cubeValues.every((value) => value >= isoLevel)) continue;
        const cubePoints = CORNERS.map((corner) => [
          x + corner[0],
          y + corner[1],
          z + corner[2],
        ] as const);
        for (const tetrahedron of TETRAHEDRA) {
          const inside = tetrahedron.map((corner) => cubeValues[corner] >= isoLevel);
          const insideCount = inside.filter(Boolean).length;
          if (insideCount === 0 || insideCount === 4) continue;
          const crossings: CrossingVertex[] = [];
          for (const edge of TETRA_EDGES) {
            if (inside[edge[0]] === inside[edge[1]]) continue;
            const firstCorner = tetrahedron[edge[0]];
            const secondCorner = tetrahedron[edge[1]];
            crossings.push(addEdgeVertex(
              cubeIds[firstCorner],
              cubeIds[secondCorner],
              cubePoints[firstCorner],
              cubePoints[secondCorner],
            ));
          }
          let insideX = 0;
          let insideY = 0;
          let insideZ = 0;
          let outsideX = 0;
          let outsideY = 0;
          let outsideZ = 0;
          for (let corner = 0; corner < 4; corner += 1) {
            const point = cubePoints[tetrahedron[corner]];
            if (inside[corner]) {
              insideX += point[0] / insideCount;
              insideY += point[1] / insideCount;
              insideZ += point[2] / insideCount;
            } else {
              outsideX += point[0] / (4 - insideCount);
              outsideY += point[1] / (4 - insideCount);
              outsideZ += point[2] / (4 - insideCount);
            }
          }
          const desired = normalize(outsideX - insideX, outsideY - insideY, outsideZ - insideZ);
          if (crossings.length === 3) {
            addTriangle(crossings[0], crossings[1], crossings[2], desired);
          } else if (crossings.length === 4) {
            const center = crossings.reduce((sum, vertex) => [
              sum[0] + vertex.x / 4,
              sum[1] + vertex.y / 4,
              sum[2] + vertex.z / 4,
            ], [0, 0, 0]);
            const reference = Math.abs(desired[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
            const u = normalize(
              desired[1] * reference[2] - desired[2] * reference[1],
              desired[2] * reference[0] - desired[0] * reference[2],
              desired[0] * reference[1] - desired[1] * reference[0],
            );
            const v: [number, number, number] = [
              desired[1] * u[2] - desired[2] * u[1],
              desired[2] * u[0] - desired[0] * u[2],
              desired[0] * u[1] - desired[1] * u[0],
            ];
            crossings.sort((left, right) => {
              const leftX = left.x - center[0];
              const leftY = left.y - center[1];
              const leftZ = left.z - center[2];
              const rightX = right.x - center[0];
              const rightY = right.y - center[1];
              const rightZ = right.z - center[2];
              return Math.atan2(leftX * v[0] + leftY * v[1] + leftZ * v[2], leftX * u[0] + leftY * u[1] + leftZ * u[2])
                - Math.atan2(rightX * v[0] + rightY * v[1] + rightZ * v[2], rightX * u[0] + rightY * u[1] + rightZ * u[2]);
            });
            addTriangle(crossings[0], crossings[1], crossings[2], desired);
            addTriangle(crossings[0], crossings[2], crossings[3], desired);
          }
        }
        if (indices.length / 3 > 4_000_000) {
          throw new Error('不透明度场生成的三角形过多，请降低场分辨率。');
        }
      }
    }
    if (reportSlices) report(requestId, 'fusing', (z + 1) / Math.max(1, dimZ - 1));
  }
  const result = filterSmallComponents
    ? filterComponents(positions, colors, indices, brackets)
    : { positions, colors, indices, brackets };
  if (filterSmallComponents && result.indices.length < 30) {
    throw new Error('Gaussian 不透明度场没有提取到足够的连续表面。');
  }
  const typedPositions = Float32Array.from(result.positions);
  const typedIndices = Uint32Array.from(result.indices);
  return {
    mesh: {
      positions: typedPositions,
      normals: generateNormals ? calculateVertexNormals(typedPositions, typedIndices) : null,
      colors: Uint8Array.from(result.colors),
      indices: typedIndices,
    },
    brackets: Float32Array.from(result.brackets),
  };
}

export function extractOpacitySurface(
  grid: FieldGrid,
  input: GS2MeshGaussianFieldInput,
  requestId: number,
): GS2MeshData {
  return extractOpacitySurfaceWithBrackets(grid, input, requestId).mesh;
}

async function reconstruct(request: GS2MeshOpacityWorkerRequest): Promise<WorkerReconstructionResult> {
  const previewStarted = performance.now();
  // #WDD-gpt 2026-08-15 - Confirm message delivery before WebGPU or WASM initialization so a true startup failure is distinguishable from computation OOM.
  report(request.requestId, 'matching', 0.01);
  let core: GS2MeshOpacityCoreExports | null = null;
  const getCore = async (): Promise<GS2MeshOpacityCoreExports> => {
    core ??= await loadCore();
    return core;
  };
  const requestedResolution = Math.max(
    48,
    Math.min(MAX_SPARSE_FIELD_RESOLUTION, Math.round(request.input.fieldResolution)),
  );
  const previewInput = buildPreviewGaussianInput(request.input);
  const previewResolution = PREVIEW_FIELD_RESOLUTION;
  let previewGrid: SparsePreviewField;
  try {
    previewGrid = await computeWebGpuField(previewInput, previewResolution, false);
  } catch {
    previewGrid = {
      ...splatOpacityField(await getCore(), previewInput, request.requestId),
      backend: `WASM bounded preview (${previewInput.positions.length / 3} Gaussian / ${previewResolution}³) + Surface Nets`,
    };
  }
  if (!previewGrid.backend.includes('bounded preview')) {
    previewGrid = {
      ...previewGrid,
      backend: `${previewGrid.backend} · bounded preview (${previewInput.positions.length / 3} Gaussian / ${previewResolution}³)`,
    };
  }
  const preview = extractSurfaceNetsPreview(previewGrid, previewInput);
  const previewResponse: GS2MeshOpacityWorkerResponse = {
    type: 'preview',
    requestId: request.requestId,
    positions: preview.positions,
    normals: preview.normals ?? new Float32Array(preview.positions.length),
    colors: preview.colors,
    indices: preview.indices,
    backend: previewGrid.backend,
    elapsedMs: performance.now() - previewStarted,
  };
  const transferablePreview = previewResponse as Extract<GS2MeshOpacityWorkerResponse, { type: 'preview' }>;
  post(transferablePreview, [
    transferablePreview.positions.buffer,
    transferablePreview.normals.buffer,
    transferablePreview.colors.buffer,
    transferablePreview.indices.buffer,
  ]);
  report(request.requestId, 'fusing', 0);
  try {
    // #WDD-gpt 2026-08-15 - Refine with the GOF ray maximum and minimum-across-views level-set definition entirely in WebGPU.
    if (requestedResolution > MAX_DENSE_TOPOLOGY_RESOLUTION || request.input.targetVoxelSize) {
      let partitioned: SparsePartitionExtraction;
      try {
        // #WDD-gpt 2026-08-15 - High modes evaluate only active 16³ bricks at the true requested spacing and recycle every GPU batch.
        partitioned = await computePartitionedGofSurface(
          request.input,
          requestedResolution,
          request.requestId,
        );
      } catch (webGpuError) {
        // #WDD-gpt 2026-08-15 - Both GPU and WASM paths share the CPU topology accumulator, so retrying the same over-budget surface only doubles peak work.
        if (webGpuError instanceof BrowserTopologyBudgetError) throw webGpuError;
        try {
          // #WDD-gpt 2026-08-15 - Preserve metric spacing on browsers with no adapter by evaluating the same streamed bricks in the bundled WASM core.
          partitioned = await computePartitionedWasmSurface(
            await getCore(),
            request.input,
            requestedResolution,
            request.requestId,
          );
        } catch (wasmError) {
          const webGpuMessage = webGpuError instanceof Error ? webGpuError.message : String(webGpuError);
          const wasmMessage = wasmError instanceof Error ? wasmError.message : String(wasmError);
          throw new Error(`WebGPU 路径不可用（${webGpuMessage}）；WASM 分区回退也失败（${wasmMessage}）。`);
        }
      }
      if (partitioned.backend.startsWith('WASM')) {
        let fallbackMesh = partitioned.mesh;
        const smoothingIterations = request.input.smoothingIterations ?? 0;
        let smoothingBackend = '';
        if (smoothingIterations > 0) {
          fallbackMesh = smoothFeaturePreservingMesh(fallbackMesh, partitioned.spacing, smoothingIterations);
          smoothingBackend = ` + ${smoothingIterations}x bounded bilateral feature smoothing`;
        }
        report(request.requestId, 'fusing', 1);
        return {
          mesh: fallbackMesh,
          backend: `${partitioned.backend}${smoothingBackend} (WebGPU adapter unavailable; metric WASM fallback)`,
        };
      }
      try {
        let refinedMesh = await refineGofSurface(request.input, partitioned);
        const smoothingIterations = request.input.smoothingIterations ?? 0;
        let smoothingBackend = '';
        if (smoothingIterations > 0) {
          const targetSpacing = partitioned.spacing;
          const smoothed = smoothFeaturePreservingMesh(refinedMesh, targetSpacing, smoothingIterations);
          try {
            const projected = await refineGofSurface(
              request.input,
              normalProjectionBrackets(smoothed, Math.max(partitioned.spacing, targetSpacing) * 1.5),
            );
            refinedMesh = blendGofConstrainedMesh(smoothed, projected);
            smoothingBackend = ` + ${smoothingIterations}x bilateral feature smoothing (0.5-voxel drift, 65% GOF constraint)`;
          } catch {
            refinedMesh = smoothed;
            smoothingBackend = ` + ${smoothingIterations}x bounded bilateral feature smoothing`;
          }
        }
        report(request.requestId, 'fusing', 1);
        return {
          mesh: refinedMesh,
          backend: `${partitioned.backend} + batched 8-step GOF edge bisection (256x positional)${smoothingBackend}`,
        };
      } catch {
        return { mesh: partitioned.mesh, backend: `${partitioned.backend} (edge refinement unavailable)` };
      }
    }
    const gofGrid = await computeWebGpuField(request.input, requestedResolution, true);
    const extraction = extractOpacitySurfaceWithBrackets(gofGrid, request.input, request.requestId);
    try {
      let refinedMesh = await refineGofSurface(request.input, extraction);
      const subdivisionRounds = precisionSubdivisionRounds(refinedMesh, requestedResolution);
      if (subdivisionRounds > 0) {
        let subdividedMesh = refinedMesh;
        for (let round = 0; round < subdivisionRounds; round += 1) subdividedMesh = subdivideMesh(subdividedMesh);
        try {
          const halfWidth = gofGrid.spacing * 0.9 / (2 ** subdivisionRounds);
          // #WDD-gpt 2026-08-15 - Four local bisections already exceed the requested 1024³ spacing after three subdivision rounds.
          refinedMesh = await refineGofSurface(
            request.input,
            normalProjectionBrackets(subdividedMesh, halfWidth),
            4,
          );
        } catch {
          // #WDD-gpt 2026-08-15 - Keep the exact coarse topology when projected subdivision exceeds an adapter limit.
        }
      }
      return {
        mesh: refinedMesh,
        backend: `${gofGrid.backend} + 8-step GOF edge bisection (256x positional) + ${4 ** subdivisionRounds}x projected triangles`,
      };
    } catch {
      return { mesh: extraction.mesh, backend: `${gofGrid.backend} (edge refinement unavailable)` };
    }
  } catch (error) {
    // #WDD-gpt 2026-08-15 - Metric requests must never silently degrade to the 160³ WASM fallback and masquerade as millimeter output.
    if (request.input.targetVoxelSize) throw error;
    const grid = request.input.fieldResolution === previewResolution && previewGrid.backend.startsWith('WASM')
      ? previewGrid
      : splatOpacityField(await getCore(), request.input, request.requestId, 'fusing');
    return {
      mesh: extractOpacitySurface(grid, request.input, request.requestId),
      backend: 'WASM Gaussian opacity refinement fallback + Marching Tetrahedra',
    };
  }
}

if (workerScope) {
  workerScope.onmessage = (event: MessageEvent<GS2MeshOpacityWorkerRequest>) => {
    const request = event.data;
    if (request.type !== 'reconstruct-opacity') return;
    void reconstruct(request).then(({ mesh, backend }) => {
      const response: GS2MeshOpacityWorkerResponse = {
        type: 'result',
        requestId: request.requestId,
        positions: mesh.positions,
        normals: mesh.normals ?? new Float32Array(mesh.positions.length),
        colors: mesh.colors,
        indices: mesh.indices,
        backend,
      };
      const result = response as Extract<GS2MeshOpacityWorkerResponse, { type: 'result' }>;
      post(result, [result.positions.buffer, result.normals.buffer, result.colors.buffer, result.indices.buffer]);
    }).catch((error: unknown) => {
      post({
        type: 'error',
        requestId: request.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  };
  // #WDD-gpt 2026-08-15 - The ready handshake proves the module and its frontend-only dependencies loaded before the main thread transfers a full Gaussian frame.
  post({ type: 'ready' });
}
