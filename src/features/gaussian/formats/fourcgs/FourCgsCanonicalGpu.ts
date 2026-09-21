import type { Raw4DAsset } from '../raw4d/Raw4DTypes';
import { validateDecodedRaw4DRows } from '../raw4d/Raw4DParser';
import { createFourCgsCanonicalAssetFromColumnMajor } from './FourCgsCanonicalAsset';
import type { FourCgsSegment } from './FourCgsTypes';
import { fourCgsCanonicalRaw4DHeader, fourCgsCanonicalRaw4DMapping } from './FourCgsRaw4D';

const WORKGROUP_SIZE = 256;
const MINIMUM_GPU_PAYLOAD_BYTES = 4 * 1024 * 1024;
const TARGET_CHUNK_BYTES = 64 * 1024 * 1024;

const CANONICAL_EXPAND_SHADER = /* wgsl */ `
struct Params {
  inputStride: u32,
  outputStride: u32,
  rowCount: u32,
  outputValueCount: u32,
  outputWordCount: u32,
  columnMajor: u32,
}

@group(0) @binding(0) var<storage, read> sourceWords: array<u32>;
@group(0) @binding(1) var<storage, read> mapping: array<i32>;
@group(0) @binding(2) var<storage, read_write> outputWords: array<u32>;
@group(0) @binding(3) var<uniform> params: Params;

fn sourceHalf(outputIndex: u32) -> u32 {
  if (outputIndex >= params.outputValueCount) { return 0u; }
  var row = outputIndex / params.outputStride;
  var property = outputIndex - row * params.outputStride;
  if (params.columnMajor != 0u) {
    property = outputIndex / params.rowCount;
    row = outputIndex - property * params.rowCount;
  }
  let sourceProperty = mapping[property];
  if (sourceProperty < 0) { return 0u; }
  let sourceIndex = row * params.inputStride + u32(sourceProperty);
  let packed = sourceWords[sourceIndex >> 1u];
  let shift = (sourceIndex & 1u) * 16u;
  return (packed >> shift) & 0xffffu;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let wordIndex = id.x;
  if (wordIndex >= params.outputWordCount) { return; }
  let first = sourceHalf(wordIndex * 2u);
  let second = sourceHalf(wordIndex * 2u + 1u);
  outputWords[wordIndex] = first | (second << 16u);
}
`;

interface CanonicalGpuRuntime {
  readonly device: GPUDevice;
  readonly pipeline: GPUComputePipeline;
}

export interface FourCgsCanonicalGpuChunk {
  readonly firstRow: number;
  readonly rowCount: number;
  readonly sourceBytes: number;
  readonly outputBytes: number;
}

let runtimePromise: Promise<CanonicalGpuRuntime | null> | null = null;
let gpuDisabled = false;
let gpuQueue: Promise<void> = Promise.resolve();

async function createRuntime(): Promise<CanonicalGpuRuntime | null> {
  if (gpuDisabled || typeof navigator === 'undefined' || !navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  device.lost.then(() => {
    gpuDisabled = true;
    runtimePromise = null;
  }).catch(() => undefined);
  const module = device.createShaderModule({ code: CANONICAL_EXPAND_SHADER });
  const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  return { device, pipeline };
}

async function runtime(): Promise<CanonicalGpuRuntime | null> {
  runtimePromise ??= createRuntime().catch(() => {
    gpuDisabled = true;
    return null;
  });
  return await runtimePromise;
}

function packedBytes(valueCount: number): number {
  return Math.ceil(valueCount / 2) * Uint32Array.BYTES_PER_ELEMENT;
}

// #WDD-gpt 2026-09-20 - 大片段按整行规划到有界 GPU 缓冲区，避免超过设备单 storage binding 或单次 dispatch 上限后整段退回 CPU。
export function planFourCgsCanonicalGpuChunks(
  pointCount: number,
  inputStride: number,
  outputStride: number,
  maxBufferBytes: number,
  maxComputeWorkgroups: number,
): FourCgsCanonicalGpuChunk[] {
  if (!Number.isSafeInteger(pointCount) || pointCount < 0
    || !Number.isSafeInteger(inputStride) || inputStride <= 0
    || !Number.isSafeInteger(outputStride) || outputStride <= 0
    || !Number.isFinite(maxBufferBytes) || maxBufferBytes < 4
    || !Number.isSafeInteger(maxComputeWorkgroups) || maxComputeWorkgroups <= 0) return [];
  const dispatchValueLimit = maxComputeWorkgroups * WORKGROUP_SIZE * 2;
  let rowsPerChunk = Math.min(
    pointCount,
    Math.floor(maxBufferBytes / (inputStride * Uint16Array.BYTES_PER_ELEMENT)),
    Math.floor(maxBufferBytes / (outputStride * Uint16Array.BYTES_PER_ELEMENT)),
    Math.floor(dispatchValueLimit / outputStride),
  );
  while (rowsPerChunk > 0
    && (packedBytes(rowsPerChunk * inputStride) > maxBufferBytes
      || packedBytes(rowsPerChunk * outputStride) > maxBufferBytes)) rowsPerChunk -= 1;
  if (pointCount > 0 && rowsPerChunk <= 0) return [];
  const chunks: FourCgsCanonicalGpuChunk[] = [];
  for (let firstRow = 0; firstRow < pointCount; firstRow += rowsPerChunk) {
    const rowCount = Math.min(rowsPerChunk, pointCount - firstRow);
    chunks.push({ firstRow, rowCount,
      sourceBytes: packedBytes(rowCount * inputStride),
      outputBytes: packedBytes(rowCount * outputStride),
    });
  }
  return chunks;
}

function packedSource(decodedRows: Uint16Array): Uint32Array {
  if (decodedRows.length % 2 === 0 && decodedRows.byteOffset % Uint32Array.BYTES_PER_ELEMENT === 0) {
    return new Uint32Array(decodedRows.buffer, decodedRows.byteOffset, decodedRows.length / 2);
  }
  const padded = new Uint16Array(decodedRows.length + (decodedRows.length % 2));
  padded.set(decodedRows);
  return new Uint32Array(padded.buffer);
}

async function expandOnGpu(
  gpu: CanonicalGpuRuntime,
  segment: FourCgsSegment,
  decodedNames: readonly string[],
  decodedRows: Uint16Array,
  columnMajor: boolean,
  shared: boolean,
): Promise<{ names: readonly string[]; values: Uint16Array } | null> {
  const { device, pipeline } = gpu;
  const { names, mapping } = fourCgsCanonicalRaw4DMapping(segment, decodedNames);
  if (decodedRows.length !== segment.gaussianCount * decodedNames.length) {
    throw new Error(`4CGS decoded row length mismatch for ${segment.name}.`);
  }
  const outputValueCount = segment.gaussianCount * names.length;
  if (outputValueCount * Uint16Array.BYTES_PER_ELEMENT < MINIMUM_GPU_PAYLOAD_BYTES) return null;
  const maxBufferBytes = Math.min(TARGET_CHUNK_BYTES, device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
  const chunks = planFourCgsCanonicalGpuChunks(
    segment.gaussianCount, decodedNames.length, names.length, maxBufferBytes,
    device.limits.maxComputeWorkgroupsPerDimension,
  );
  if (chunks.length === 0) return null;
  const outputBufferSize = Math.max(...chunks.map((chunk) => chunk.outputBytes));
  const sourceBufferSize = Math.max(...chunks.map((chunk) => chunk.sourceBytes));
  const sourceBuffer = device.createBuffer({ label: '4CGS canonical chunk source', size: sourceBufferSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const mappingBuffer = device.createBuffer({ label: '4CGS canonical mapping', size: mapping.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const outputBuffer = device.createBuffer({ label: '4CGS canonical chunk output', size: outputBufferSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ label: '4CGS canonical chunk readback', size: outputBufferSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const paramsBuffer = device.createBuffer({ label: '4CGS canonical params', size: 24,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const values = new Uint16Array(shared
    ? new SharedArrayBuffer(outputValueCount * Uint16Array.BYTES_PER_ELEMENT)
    : new ArrayBuffer(outputValueCount * Uint16Array.BYTES_PER_ELEMENT));
  try {
    device.queue.writeBuffer(mappingBuffer, 0, mapping);
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: sourceBuffer } },
        { binding: 1, resource: { buffer: mappingBuffer } },
        { binding: 2, resource: { buffer: outputBuffer } },
        { binding: 3, resource: { buffer: paramsBuffer } },
      ],
    });
    for (const chunk of chunks) {
      const first = chunk.firstRow * decodedNames.length;
      const source = packedSource(decodedRows.subarray(first, first + chunk.rowCount * decodedNames.length));
      const chunkValueCount = chunk.rowCount * names.length;
      const params = new Uint32Array([decodedNames.length, names.length, chunk.rowCount,
        chunkValueCount, Math.ceil(chunkValueCount / 2), columnMajor ? 1 : 0]);
      device.queue.writeBuffer(sourceBuffer, 0, source);
      device.queue.writeBuffer(paramsBuffer, 0, params);
      const encoder = device.createCommandEncoder({ label: '4CGS canonical chunk expansion' });
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(Math.ceil(chunkValueCount / 2) / WORKGROUP_SIZE));
      pass.end();
      encoder.copyBufferToBuffer(outputBuffer, 0, readback, 0, chunk.outputBytes);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ, 0, chunk.outputBytes);
      const chunkValues = new Uint16Array(readback.getMappedRange(0, chunk.outputBytes), 0, chunkValueCount);
      if (columnMajor) {
        for (let property = 0; property < names.length; property += 1) {
          values.set(chunkValues.subarray(property * chunk.rowCount, (property + 1) * chunk.rowCount),
            property * segment.gaussianCount + chunk.firstRow);
        }
      } else values.set(chunkValues, chunk.firstRow * names.length);
      readback.unmap();
    }
    return { names, values };
  } finally {
    if (readback.mapState === 'mapped') readback.unmap();
    sourceBuffer.destroy(); mappingBuffer.destroy(); outputBuffer.destroy(); readback.destroy(); paramsBuffer.destroy();
  }
}

function verifyColumnMajorSamples(
  pointCount: number,
  decodedNames: readonly string[],
  decodedRows: Uint16Array,
  names: readonly string[],
  values: Uint16Array,
  mapping: Int32Array,
): void {
  const sampleCount = Math.min(1024, pointCount);
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const point = sampleCount <= 1 ? 0 : Math.floor(sample * (pointCount - 1) / (sampleCount - 1));
    for (let property = 0; property < names.length; property += 1) {
      const sourceProperty = mapping[property];
      const expected = sourceProperty < 0 ? 0 : decodedRows[point * decodedNames.length + sourceProperty];
      if (values[property * pointCount + point] !== expected) {
        throw new Error(`4CGS WebGPU canonical verification failed at point ${point}, property ${names[property]}.`);
      }
    }
  }
}

async function withGpuTurn<T>(operation: (gpu: CanonicalGpuRuntime) => Promise<T>): Promise<T | null> {
  const gpu = await runtime();
  if (!gpu) return null;
  let resolveTurn!: () => void;
  const previous = gpuQueue;
  gpuQueue = new Promise<void>((resolve) => { resolveTurn = resolve; });
  await previous;
  try { return await operation(gpu); }
  catch { gpuDisabled = true; runtimePromise = null; return null; }
  finally { resolveTurn(); }
}

// #WDD-gpt 2026-09-20 - GPU 分块展开仍生成与旧路径逐位一致的 row-major RAW4D；设备异常返回 null，由调用方无缝回退 CPU。
export async function createFourCgsCanonicalRaw4DGpu(
  segment: FourCgsSegment,
  decodedNames: readonly string[],
  decodedRows: Uint16Array,
): Promise<Uint8Array | null> {
  const expanded = await withGpuTurn((gpu) => expandOnGpu(gpu, segment, decodedNames, decodedRows, false, false));
  if (!expanded) return null;
  const header = fourCgsCanonicalRaw4DHeader(segment, expanded.names);
  const output = new Uint8Array(header.byteLength + expanded.values.byteLength);
  output.set(header);
  output.set(new Uint8Array(expanded.values.buffer, expanded.values.byteOffset, expanded.values.byteLength), header.byteLength);
  return output;
}

// #WDD-gpt 2026-09-20 - 前景导入由 WebGPU 分块直接生成运行时列式 backing；CPU 先做语义校验、GPU 后做均匀抽样逐位校验，任一失败即安全回退。
export async function createFourCgsCanonicalAssetGpu(
  segment: FourCgsSegment,
  decodedNames: readonly string[],
  decodedRows: Uint16Array,
  shared = false,
  cpuBudgetBytes = Number.MAX_SAFE_INTEGER,
): Promise<Raw4DAsset | null> {
  if (decodedRows.byteLength > cpuBudgetBytes || decodedRows.byteLength < MINIMUM_GPU_PAYLOAD_BYTES) return null;
  validateDecodedRaw4DRows(decodedRows, decodedNames);
  const expanded = await withGpuTurn((gpu) => expandOnGpu(gpu, segment, decodedNames, decodedRows, true, shared));
  if (!expanded) return null;
  try {
    const { mapping } = fourCgsCanonicalRaw4DMapping(segment, decodedNames);
    verifyColumnMajorSamples(segment.gaussianCount, decodedNames, decodedRows, expanded.names, expanded.values, mapping);
    return createFourCgsCanonicalAssetFromColumnMajor(segment, expanded.names, expanded.values);
  } catch {
    gpuDisabled = true;
    runtimePromise = null;
    return null;
  }
}
