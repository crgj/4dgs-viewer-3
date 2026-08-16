/// <reference lib="webworker" />

import wasmUrl from './wasm/gs2mesh_core.wasm?url';
import { foregroundMask, rgbaToGray } from './GS2MeshBrowserStereo';
import {
  createSurfacePointIndex,
  fillSmallBoundaryHoles,
  isNearSurface,
  refineDisparities,
  type SurfacePointIndex,
} from './GS2MeshGeometryCleanup';
import type { GS2MeshCamera, GS2MeshCaptureResult, GS2MeshData } from './GS2MeshTypes';
import type {
  GS2MeshWorkerRequest,
  GS2MeshWorkerResponse,
  GS2MeshWorkerStage,
} from './GS2MeshWorkerProtocol';

interface DecodedImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8ClampedArray;
}

interface GS2MeshCoreExports extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  readonly reset: () => void;
  readonly alloc: (bytes: number) => number;
  readonly census: (gray: number, output: number, width: number, height: number) => void;
  readonly stereo_match_grid: (
    left: number,
    right: number,
    foreground: number,
    width: number,
    height: number,
    xStart: number,
    yStart: number,
    step: number,
    columns: number,
    rows: number,
    minimum: number,
    maximum: number,
    output: number,
  ) => void;
}

interface StereoGrid {
  readonly xStart: number;
  readonly yStart: number;
  readonly step: number;
  readonly columns: number;
  readonly rows: number;
  readonly disparities: Uint16Array;
  readonly foreground: Uint8Array;
}

interface VoxelStore {
  readonly lookup: Map<string, number>;
  readonly sumX: number[];
  readonly sumY: number[];
  readonly sumZ: number[];
  readonly sumRed: number[];
  readonly sumGreen: number[];
  readonly sumBlue: number[];
  readonly count: number[];
  readonly viewSupport: number[];
  readonly lastView: number[];
  readonly triangles: number[];
  readonly triangleKeys: Set<string>;
}

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
let corePromise: Promise<GS2MeshCoreExports> | null = null;

function post(message: GS2MeshWorkerResponse, transfer: Transferable[] = []): void {
  workerScope.postMessage(message, transfer);
}

function report(requestId: number, stage: GS2MeshWorkerStage, progress: number): void {
  post({ type: 'progress', requestId, stage, progress });
}

async function loadCore(): Promise<GS2MeshCoreExports> {
  if (!corePromise) {
    corePromise = (async () => {
      const response = await fetch(wasmUrl);
      if (!response.ok) throw new Error(`无法加载 GS2Mesh WASM 核心（HTTP ${response.status}）。`);
      const result = await WebAssembly.instantiate(await response.arrayBuffer(), {});
      return result.instance.exports as GS2MeshCoreExports;
    })();
  }
  return corePromise;
}

async function decodeImage(blob: Blob): Promise<DecodedImage> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('浏览器无法创建 GS2Mesh Worker 图像画布。');
    context.drawImage(bitmap, 0, 0);
    return {
      width: bitmap.width,
      height: bitmap.height,
      rgba: context.getImageData(0, 0, bitmap.width, bitmap.height).data,
    };
  } finally {
    bitmap.close();
  }
}

function allocateCore(core: GS2MeshCoreExports, bytes: number): number {
  const pointer = core.alloc(bytes);
  if (pointer <= 0) throw new Error('GS2Mesh WASM 内存分配失败。');
  return pointer;
}

function computeStereoGrid(
  core: GS2MeshCoreExports,
  left: DecodedImage,
  right: DecodedImage,
  camera: GS2MeshCamera,
): StereoGrid {
  if (left.width !== right.width || left.height !== right.height) {
    throw new Error('GS2Mesh 左右双目图像尺寸不一致。');
  }
  const { width, height } = left;
  const pixels = width * height;
  const step = Math.max(1, Math.ceil(width / 280));
  const minimum = Math.max(2, Math.floor(camera.fx / 30));
  const maximum = Math.max(minimum + 2, Math.min(160, Math.floor(width * 0.3), Math.ceil(camera.fx / 2.5)));
  const xStart = Math.max(3 + minimum, 4);
  const yStart = 4;
  const columns = Math.max(0, Math.floor((width - 4 - xStart) / step) + 1);
  const rows = Math.max(0, Math.floor((height - 4 - yStart) / step) + 1);
  if (columns < 2 || rows < 2) throw new Error('GS2Mesh 采集图像过小，无法构造双目深度网格。');

  const leftGray = rgbaToGray(left.rgba);
  const rightGray = rgbaToGray(right.rgba);
  const foreground = foregroundMask(left.rgba, width, height);
  core.reset();
  const leftGrayPointer = allocateCore(core, pixels);
  const rightGrayPointer = allocateCore(core, pixels);
  const foregroundPointer = allocateCore(core, pixels);
  const leftCensusPointer = allocateCore(core, pixels * 4);
  const rightCensusPointer = allocateCore(core, pixels * 4);
  const outputPointer = allocateCore(core, columns * rows * 2);
  const heap = new Uint8Array(core.memory.buffer);
  heap.set(leftGray, leftGrayPointer);
  heap.set(rightGray, rightGrayPointer);
  heap.set(foreground, foregroundPointer);
  core.census(leftGrayPointer, leftCensusPointer, width, height);
  core.census(rightGrayPointer, rightCensusPointer, width, height);
  core.stereo_match_grid(
    leftCensusPointer,
    rightCensusPointer,
    foregroundPointer,
    width,
    height,
    xStart,
    yStart,
    step,
    columns,
    rows,
    minimum,
    maximum,
    outputPointer,
  );
  const gridForeground = new Uint8Array(columns * rows);
  for (let row = 0; row < rows; row += 1) {
    const pixelY = yStart + row * step;
    for (let column = 0; column < columns; column += 1) {
      const pixelX = xStart + column * step;
      gridForeground[row * columns + column] = foreground[pixelY * width + pixelX];
    }
  }
  const rawDisparities = new Uint16Array(core.memory.buffer, outputPointer, columns * rows).slice();
  return {
    xStart,
    yStart,
    step,
    columns,
    rows,
    disparities: refineDisparities(rawDisparities, gridForeground, columns, rows),
    foreground: gridForeground,
  };
}

function createVoxelStore(): VoxelStore {
  return {
    lookup: new Map(),
    sumX: [], sumY: [], sumZ: [],
    sumRed: [], sumGreen: [], sumBlue: [],
    count: [], viewSupport: [], lastView: [],
    triangles: [], triangleKeys: new Set(),
  };
}

function addVoxel(
  store: VoxelStore,
  voxelSize: number,
  x: number,
  y: number,
  z: number,
  red: number,
  green: number,
  blue: number,
  viewIndex: number,
): number {
  const key = `${Math.floor(x / voxelSize)},${Math.floor(y / voxelSize)},${Math.floor(z / voxelSize)}`;
  const existing = store.lookup.get(key);
  if (existing !== undefined) {
    store.sumX[existing] += x;
    store.sumY[existing] += y;
    store.sumZ[existing] += z;
    store.sumRed[existing] += red;
    store.sumGreen[existing] += green;
    store.sumBlue[existing] += blue;
    store.count[existing] += 1;
    if (store.lastView[existing] !== viewIndex) {
      store.lastView[existing] = viewIndex;
      store.viewSupport[existing] += 1;
    }
    return existing;
  }
  const index = store.count.length;
  store.lookup.set(key, index);
  store.sumX.push(x);
  store.sumY.push(y);
  store.sumZ.push(z);
  store.sumRed.push(red);
  store.sumGreen.push(green);
  store.sumBlue.push(blue);
  store.count.push(1);
  store.viewSupport.push(1);
  store.lastView.push(viewIndex);
  return index;
}

function addTriangle(store: VoxelStore, first: number, second: number, third: number): void {
  if (first < 0 || second < 0 || third < 0 || first === second || second === third || first === third) return;
  const sorted = [first, second, third].sort((left, right) => left - right);
  const key = `${sorted[0]},${sorted[1]},${sorted[2]}`;
  if (store.triangleKeys.has(key)) return;
  store.triangleKeys.add(key);
  store.triangles.push(first, second, third);
}

function integrateGrid(
  store: VoxelStore,
  capture: GS2MeshCaptureResult,
  camera: GS2MeshCamera,
  baseline: number,
  image: DecodedImage,
  grid: StereoGrid,
  surfaceIndex: SurfacePointIndex | null,
  viewIndex: number,
): void {
  const vertexGrid = new Int32Array(grid.columns * grid.rows);
  vertexGrid.fill(-1);
  const depths = new Float32Array(grid.columns * grid.rows);
  const voxelSize = Math.max(capture.sceneRadius / 180, 1e-6);
  const margin = capture.sceneRadius * 0.04;
  const minimumDepth = baseline * 2.5;
  const maximumDepth = baseline * 30;
  for (let row = 0; row < grid.rows; row += 1) {
    const pixelY = grid.yStart + row * grid.step;
    for (let column = 0; column < grid.columns; column += 1) {
      const gridIndex = row * grid.columns + column;
      const disparity = grid.disparities[gridIndex];
      if (disparity === 0) continue;
      const depth = camera.fx * baseline / disparity;
      if (!Number.isFinite(depth) || depth < minimumDepth || depth > maximumDepth) continue;
      const pixelX = grid.xStart + column * grid.step;
      const cameraX = (pixelX - camera.cx) * depth / camera.fx;
      const cameraY = (pixelY - camera.cy) * depth / camera.fy;
      const worldX = camera.position[0] + camera.right[0] * cameraX - camera.up[0] * cameraY + camera.forward[0] * depth;
      const worldY = camera.position[1] + camera.right[1] * cameraX - camera.up[1] * cameraY + camera.forward[1] * depth;
      const worldZ = camera.position[2] + camera.right[2] * cameraX - camera.up[2] * cameraY + camera.forward[2] * depth;
      if (
        worldX < capture.boundsMin[0] - margin || worldX > capture.boundsMax[0] + margin
        || worldY < capture.boundsMin[1] - margin || worldY > capture.boundsMax[1] + margin
        || worldZ < capture.boundsMin[2] - margin || worldZ > capture.boundsMax[2] + margin
      ) continue;
      if (!isNearSurface(surfaceIndex, worldX, worldY, worldZ)) continue;
      const colorOffset = (pixelY * image.width + pixelX) * 4;
      vertexGrid[gridIndex] = addVoxel(
        store,
        voxelSize,
        worldX,
        worldY,
        worldZ,
        image.rgba[colorOffset],
        image.rgba[colorOffset + 1],
        image.rgba[colorOffset + 2],
        viewIndex,
      );
      depths[gridIndex] = depth;
    }
  }

  for (let row = 0; row < grid.rows - 1; row += 1) {
    for (let column = 0; column < grid.columns - 1; column += 1) {
      const first = row * grid.columns + column;
      const right = first + 1;
      const below = first + grid.columns;
      const diagonal = below + 1;
      const tryTriangle = (a: number, b: number, c: number): void => {
        if (vertexGrid[a] < 0 || vertexGrid[b] < 0 || vertexGrid[c] < 0) return;
        const near = Math.min(depths[a], depths[b], depths[c]);
        const far = Math.max(depths[a], depths[b], depths[c]);
        if (far - near > Math.max(baseline * 1.25, near * 0.1)) return;
        addTriangle(store, vertexGrid[a], vertexGrid[b], vertexGrid[c]);
      };
      tryTriangle(first, below, right);
      tryTriangle(right, below, diagonal);
    }
  }
}

function find(parent: Int32Array, value: number): number {
  let root = value;
  while (parent[root] !== root) root = parent[root];
  let current = value;
  while (parent[current] !== current) {
    const next = parent[current];
    parent[current] = root;
    current = next;
  }
  return root;
}

function unite(parent: Int32Array, sizes: Int32Array, left: number, right: number): void {
  let leftRoot = find(parent, left);
  let rightRoot = find(parent, right);
  if (leftRoot === rightRoot) return;
  if (sizes[leftRoot] < sizes[rightRoot]) [leftRoot, rightRoot] = [rightRoot, leftRoot];
  parent[rightRoot] = leftRoot;
  sizes[leftRoot] += sizes[rightRoot];
}

function calculateNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index] * 3;
    const b = indices[index + 1] * 3;
    const c = indices[index + 2] * 3;
    const abX = positions[b] - positions[a];
    const abY = positions[b + 1] - positions[a + 1];
    const abZ = positions[b + 2] - positions[a + 2];
    const acX = positions[c] - positions[a];
    const acY = positions[c + 1] - positions[a + 1];
    const acZ = positions[c + 2] - positions[a + 2];
    const normalX = abY * acZ - abZ * acY;
    const normalY = abZ * acX - abX * acZ;
    const normalZ = abX * acY - abY * acX;
    for (const vertex of [a, b, c]) {
      normals[vertex] += normalX;
      normals[vertex + 1] += normalY;
      normals[vertex + 2] += normalZ;
    }
  }
  for (let index = 0; index < normals.length; index += 3) {
    const length = Math.hypot(normals[index], normals[index + 1], normals[index + 2]) || 1;
    normals[index] /= length;
    normals[index + 1] /= length;
    normals[index + 2] /= length;
  }
  return normals;
}

function finalizeMesh(store: VoxelStore, capture: GS2MeshCaptureResult): GS2MeshData {
  if (store.triangles.length < 30) throw new Error('WASM 双目没有生成足够的有效三角形；请增大基线、增加视角或让目标占据更多画面。');
  const vertexCount = store.count.length;
  const parent = new Int32Array(vertexCount);
  const sizes = new Int32Array(vertexCount);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    parent[vertex] = vertex;
    sizes[vertex] = 1;
  }
  for (let index = 0; index < store.triangles.length; index += 3) {
    unite(parent, sizes, store.triangles[index], store.triangles[index + 1]);
    unite(parent, sizes, store.triangles[index], store.triangles[index + 2]);
  }
  const componentTriangles = new Int32Array(vertexCount);
  let largestComponent = 0;
  for (let index = 0; index < store.triangles.length; index += 3) {
    const root = find(parent, store.triangles[index]);
    componentTriangles[root] += 1;
    largestComponent = Math.max(largestComponent, componentTriangles[root]);
  }
  const minimumComponent = Math.max(6, Math.floor(largestComponent * 0.0003));
  let crossViewTriangles = 0;
  if (capture.pairs.length >= 3) {
    for (let index = 0; index < store.triangles.length; index += 3) {
      if (
        store.viewSupport[store.triangles[index]] >= 2
        || store.viewSupport[store.triangles[index + 1]] >= 2
        || store.viewSupport[store.triangles[index + 2]] >= 2
      ) crossViewTriangles += 1;
    }
  }
  const requireCrossViewSupport = crossViewTriangles >= Math.max(10, store.triangles.length / 3 * 0.02);
  const remap = new Int32Array(vertexCount);
  remap.fill(-1);
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const mapVertex = (source: number): number => {
    if (remap[source] >= 0) return remap[source];
    const target = positions.length / 3;
    remap[source] = target;
    const divisor = store.count[source];
    positions.push(store.sumX[source] / divisor, store.sumY[source] / divisor, store.sumZ[source] / divisor);
    colors.push(
      Math.round(store.sumRed[source] / divisor),
      Math.round(store.sumGreen[source] / divisor),
      Math.round(store.sumBlue[source] / divisor),
      255,
    );
    return target;
  };
  for (let index = 0; index < store.triangles.length; index += 3) {
    const first = store.triangles[index];
    if (componentTriangles[find(parent, first)] < minimumComponent) continue;
    if (
      requireCrossViewSupport
      && store.viewSupport[first] < 2
      && store.viewSupport[store.triangles[index + 1]] < 2
      && store.viewSupport[store.triangles[index + 2]] < 2
    ) continue;
    indices.push(mapVertex(first), mapVertex(store.triangles[index + 1]), mapVertex(store.triangles[index + 2]));
  }
  if (indices.length < 30) throw new Error('GS2Mesh 多视角融合后没有保留足够的连通三角形。');
  // #WDD-gpt 2026-08-15 - 仅封闭尺寸受限的内部边界环，保留物体外轮廓和真实的大开口。
  fillSmallBoundaryHoles(positions, colors, indices, capture.sceneRadius * 0.06);
  const positionArray = Float32Array.from(positions);
  const indexArray = Uint32Array.from(indices);
  return {
    positions: positionArray,
    normals: calculateNormals(positionArray, indexArray),
    colors: Uint8Array.from(colors),
    indices: indexArray,
  };
}

async function reconstruct(request: GS2MeshWorkerRequest): Promise<GS2MeshData> {
  const core = await loadCore();
  const store = createVoxelStore();
  const surfaceIndex = createSurfacePointIndex(request.capture.surfacePoints, request.capture.sceneRadius);
  report(request.requestId, 'matching', 0);
  for (let index = 0; index < request.capture.pairs.length; index += 1) {
    const pair = request.capture.pairs[index];
    const [left, right] = await Promise.all([decodeImage(pair.left), decodeImage(pair.right)]);
    const grid = computeStereoGrid(core, left, right, pair.leftCamera);
    integrateGrid(store, request.capture, pair.leftCamera, pair.baseline, left, grid, surfaceIndex, index);
    report(request.requestId, 'matching', (index + 1) / request.capture.pairs.length);
  }
  report(request.requestId, 'fusing', 0.2);
  const mesh = finalizeMesh(store, request.capture);
  report(request.requestId, 'fusing', 1);
  return mesh;
}

workerScope.onmessage = (event: MessageEvent<GS2MeshWorkerRequest>) => {
  const request = event.data;
  if (request.type !== 'reconstruct') return;
  void reconstruct(request).then((mesh) => {
    const response: GS2MeshWorkerResponse = {
      type: 'result',
      requestId: request.requestId,
      positions: mesh.positions,
      normals: mesh.normals ?? new Float32Array(mesh.positions.length),
      colors: mesh.colors,
      indices: mesh.indices,
    };
    const result = response as Extract<GS2MeshWorkerResponse, { type: 'result' }>;
    post(response, [result.positions.buffer, result.normals.buffer, result.colors.buffer, result.indices.buffer]);
  }).catch((error: unknown) => {
    post({
      type: 'error',
      requestId: request.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  });
};

export {};
