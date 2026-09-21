import type { Raw4DAsset } from '../raw4d/Raw4DTypes';

const WORKGROUP_SIZE = 256;
const MINIMUM_ALPHA_GPU_POINTS = 65_536;
const TARGET_CHUNK_BYTES = 64 * 1024 * 1024;

const CROP_REDUCTION_SHADER = /* wgsl */ `
struct Params {
  pointCount: u32,
  stride: u32,
  bankCount: u32,
  reserved: u32,
}

@group(0) @binding(0) var<storage, read> sourceWords: array<u32>;
@group(0) @binding(1) var<storage, read> positionIndices: array<u32>;
@group(0) @binding(2) var<storage, read_write> bounds: array<atomic<u32>>;
@group(0) @binding(3) var<uniform> params: Params;

fn sourceHalf(valueIndex: u32) -> u32 {
  let packed = sourceWords[valueIndex >> 1u];
  return (packed >> ((valueIndex & 1u) * 16u)) & 0xffffu;
}

fn orderedHalf(bits: u32) -> u32 {
  return select(bits ^ 0x8000u, (~bits) & 0xffffu, (bits & 0x8000u) != 0u);
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let local = id.x;
  let bank = id.y;
  if (local >= params.pointCount || bank >= params.bankCount) {
    return;
  }
  let row = local * params.stride;
  for (var axis = 0u; axis < 3u; axis += 1u) {
    let bits = sourceHalf(row + positionIndices[bank * 3u + axis]);
    if ((bits & 0x7c00u) == 0x7c00u) {
      atomicOr(&bounds[6], 1u);
      continue;
    }
    let ordered = orderedHalf(bits);
    atomicMin(&bounds[axis], ordered);
    atomicMax(&bounds[3u + axis], ordered);
  }
}
`;

const ALPHA_WITNESS_SHADER = /* wgsl */ `
struct Params {
  pointCount: u32,
  opacityBankCount: u32,
  frameCount: u32,
  sourceEncoding: u32,
  threshold: f32,
  bakedTiming: u32,
  reserved0: u32,
  reserved1: u32,
}

struct FrameSpan {
  left: u32,
  right: u32,
  alpha: f32,
  reserved: u32,
}

@group(0) @binding(0) var<storage, read> sourceWords: array<u32>;
@group(0) @binding(1) var<storage, read> spans: array<FrameSpan>;
@group(0) @binding(2) var<storage, read_write> witnesses: array<u32>;
@group(0) @binding(3) var<uniform> params: Params;

fn sourceValue(column: u32, point: u32) -> f32 {
  let valueIndex = column * params.pointCount + point;
  if (params.sourceEncoding == 1u) {
    return bitcast<f32>(sourceWords[valueIndex]);
  }
  let packed = sourceWords[valueIndex >> 1u];
  let shift = (valueIndex & 1u) * 16u;
  let bits = (packed >> shift) & 0xffffu;
  return unpack2x16float(bits).x;
}

fn sigmoid(value: f32) -> f32 {
  if (value >= 0.0) {
    return 1.0 / (1.0 + exp(-value));
  }
  let exponential = exp(value);
  return exponential / (1.0 + exponential);
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let point = id.x;
  if (point >= params.pointCount) {
    return;
  }
  let lifetimeMu = sourceValue(params.opacityBankCount, point);
  let lifetimeW = sourceValue(params.opacityBankCount + 1u, point);
  for (var frame = 0u; frame < params.frameCount; frame += 1u) {
    let span = spans[frame];
    let left = sourceValue(span.left, point);
    let right = sourceValue(span.right, point);
    var opacityValue = left;
    if (span.alpha > 0.0 && left != right) {
      opacityValue = left + (right - left) * span.alpha;
    }
    let opacity = sigmoid(opacityValue);
    var gate = 1.0;
    if (params.bakedTiming == 0u) {
      let f = f32(frame);
      gate = sigmoid(10.0 * (f - (lifetimeMu - lifetimeW)))
        * sigmoid(10.0 * ((lifetimeMu + lifetimeW) - f));
    }
    if (opacity * gate >= params.threshold) {
      witnesses[point] = frame + 1u;
      return;
    }
  }
}
`;

const MEMORY_COMPACTION_SHADER = /* wgsl */ `
struct Params {
  sourcePointCount: u32,
  propertyCount: u32,
  keptPointCount: u32,
  outputValueCount: u32,
  outputWordCount: u32,
  reserved: u32,
}

@group(0) @binding(0) var<storage, read> sourceWords: array<u32>;
@group(0) @binding(1) var<storage, read> keptIndices: array<u32>;
@group(0) @binding(2) var<storage, read_write> outputWords: array<u32>;
@group(0) @binding(3) var<uniform> params: Params;

fn sourceHalf(outputIndex: u32) -> u32 {
  if (outputIndex >= params.outputValueCount) { return 0u; }
  let destination = outputIndex / params.propertyCount;
  let property = outputIndex - destination * params.propertyCount;
  let sourcePoint = keptIndices[destination];
  let sourceIndex = property * params.sourcePointCount + sourcePoint;
  let packed = sourceWords[sourceIndex >> 1u];
  return (packed >> ((sourceIndex & 1u) * 16u)) & 0xffffu;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let wordIndex = id.x;
  if (wordIndex >= params.outputWordCount) { return; }
  outputWords[wordIndex] = sourceHalf(wordIndex * 2u) | (sourceHalf(wordIndex * 2u + 1u) << 16u);
}
`;

interface ExportGpuRuntime {
  readonly device: GPUDevice;
  readonly cropPipeline: GPUComputePipeline;
  readonly alphaPipeline: GPUComputePipeline;
  readonly compactionPipeline: GPUComputePipeline;
}

export interface FourCgsExportGpuSegment {
  readonly count: number;
  readonly propertyNames: readonly string[];
  readonly propertyIndex: ReadonlyMap<string, number>;
  readonly rows: Uint16Array;
}

export interface FourCgsExportGpuCropBits {
  readonly minimum: readonly [number, number, number];
  readonly maximum: readonly [number, number, number];
}

export interface FourCgsExportGpuAlphaWitnesses {
  readonly frames: Uint32Array;
  readonly elapsedMs: number;
}

export interface FourCgsExportGpuCompaction {
  readonly rows: Uint16Array;
  readonly elapsedMs: number;
}

export interface FourCgsExportGpuChunk {
  readonly firstPoint: number;
  readonly pointCount: number;
  readonly sourceBytes: number;
  readonly outputBytes: number;
}

function alignedGpuBytes(bytes: number): number {
  return Math.ceil(bytes / 4) * 4;
}

// #WDD-gpt 2026-09-20 - 裁剪与 Alpha 扫描共用按点分块规划，严格受单 binding、buffer 和 dispatch 三重上限约束。
export function planFourCgsExportGpuChunks(
  pointCount: number,
  sourceBytesPerPoint: number,
  outputBytesPerPoint: number,
  maxBufferBytes: number,
  maxComputeWorkgroups: number,
): FourCgsExportGpuChunk[] {
  if (!Number.isSafeInteger(pointCount) || pointCount < 0
    || !Number.isSafeInteger(sourceBytesPerPoint) || sourceBytesPerPoint <= 0
    || !Number.isSafeInteger(outputBytesPerPoint) || outputBytesPerPoint < 0
    || !Number.isFinite(maxBufferBytes) || maxBufferBytes < 4
    || !Number.isSafeInteger(maxComputeWorkgroups) || maxComputeWorkgroups <= 0) return [];
  let pointsPerChunk = Math.min(
    pointCount,
    Math.floor(maxBufferBytes / sourceBytesPerPoint),
    outputBytesPerPoint === 0 ? pointCount : Math.floor(maxBufferBytes / outputBytesPerPoint),
    maxComputeWorkgroups * WORKGROUP_SIZE,
  );
  while (pointsPerChunk > 0
    && (alignedGpuBytes(pointsPerChunk * sourceBytesPerPoint) > maxBufferBytes
      || alignedGpuBytes(pointsPerChunk * outputBytesPerPoint) > maxBufferBytes)) pointsPerChunk -= 1;
  if (pointCount > 0 && pointsPerChunk <= 0) return [];
  const chunks: FourCgsExportGpuChunk[] = [];
  for (let firstPoint = 0; firstPoint < pointCount; firstPoint += pointsPerChunk) {
    const chunkPointCount = Math.min(pointsPerChunk, pointCount - firstPoint);
    chunks.push({
      firstPoint,
      pointCount: chunkPointCount,
      sourceBytes: alignedGpuBytes(chunkPointCount * sourceBytesPerPoint),
      outputBytes: alignedGpuBytes(chunkPointCount * outputBytesPerPoint),
    });
  }
  return chunks;
}

let runtimePromise: Promise<ExportGpuRuntime | null> | null = null;
let gpuDisabled = false;
let gpuQueue: Promise<void> = Promise.resolve();

async function createRuntime(): Promise<ExportGpuRuntime | null> {
  if (gpuDisabled || typeof navigator === 'undefined' || !navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  device.lost.then(() => {
    gpuDisabled = true;
    runtimePromise = null;
  }).catch(() => undefined);
  const cropModule = device.createShaderModule({ code: CROP_REDUCTION_SHADER });
  const alphaModule = device.createShaderModule({ code: ALPHA_WITNESS_SHADER });
  const compactionModule = device.createShaderModule({ code: MEMORY_COMPACTION_SHADER });
  const [cropPipeline, alphaPipeline, compactionPipeline] = await Promise.all([
    device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: cropModule, entryPoint: 'main' },
    }),
    device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: alphaModule, entryPoint: 'main' },
    }),
    device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: compactionModule, entryPoint: 'main' },
    }),
  ]);
  return { device, cropPipeline, alphaPipeline, compactionPipeline };
}

async function runtime(): Promise<ExportGpuRuntime | null> {
  runtimePromise ??= createRuntime().catch(() => {
    gpuDisabled = true;
    return null;
  });
  return await runtimePromise;
}

function packedSource(rows: Uint16Array): Uint32Array {
  if (rows.length % 2 === 0 && rows.byteOffset % Uint32Array.BYTES_PER_ELEMENT === 0) {
    return new Uint32Array(rows.buffer, rows.byteOffset, rows.length / 2);
  }
  const padded = new Uint16Array(rows.length + (rows.length % 2));
  padded.set(rows);
  return new Uint32Array(padded.buffer);
}

function positionIndices(segment: FourCgsExportGpuSegment): Uint32Array {
  const indices: number[] = [];
  for (let bank = 0;; bank += 1) {
    const x = segment.propertyIndex.get(`xyz_bank_${bank}_x`);
    const y = segment.propertyIndex.get(`xyz_bank_${bank}_y`);
    const z = segment.propertyIndex.get(`xyz_bank_${bank}_z`);
    if (x === undefined && y === undefined && z === undefined) break;
    if (x === undefined || y === undefined || z === undefined) {
      throw new Error(`4CGS Position bank ${bank} 属性不完整。`);
    }
    indices.push(x, y, z);
  }
  if (indices.length === 0) throw new Error('4CGS 导出缺少 Position bank。');
  return Uint32Array.from(indices);
}

function deletedAt(words: Uint32Array, point: number): boolean {
  return Boolean(words[point >>> 5] & (1 << (point & 31)));
}

async function compactMemoryRowsOnGpu(
  gpu: ExportGpuRuntime,
  columns: readonly Uint16Array[],
  deletionWords: Uint32Array,
  pointCount: number,
  outputPointCount: number,
): Promise<FourCgsExportGpuCompaction | null> {
  if (columns.length === 0 || pointCount <= 0 || outputPointCount <= 0
    || deletionWords.length !== Math.ceil(pointCount / 32)
    || columns.some((column) => column.length !== pointCount)) return null;
  const { device, compactionPipeline } = gpu;
  const maxBufferBytes = Math.min(TARGET_CHUNK_BYTES, device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
  const propertyCount = columns.length;
  const rowsPerDispatch = Math.floor(
    device.limits.maxComputeWorkgroupsPerDimension * WORKGROUP_SIZE * 2 / propertyCount,
  );
  const pointsPerChunk = Math.min(
    pointCount,
    Math.floor(maxBufferBytes / (propertyCount * Uint16Array.BYTES_PER_ELEMENT)),
    Math.floor(maxBufferBytes / Uint32Array.BYTES_PER_ELEMENT),
    rowsPerDispatch,
  );
  if (pointsPerChunk <= 0) return null;
  const sourceBufferBytes = alignedGpuBytes(pointsPerChunk * propertyCount * Uint16Array.BYTES_PER_ELEMENT);
  const outputBufferBytes = sourceBufferBytes;
  const sourceBuffer = device.createBuffer({ label: '4CGS export compact chunk columns', size: sourceBufferBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const keptBuffer = device.createBuffer({ label: '4CGS export compact kept indices',
    size: alignedGpuBytes(pointsPerChunk * Uint32Array.BYTES_PER_ELEMENT),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const outputBuffer = device.createBuffer({ label: '4CGS export compact chunk rows', size: outputBufferBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ label: '4CGS export compact chunk readback', size: outputBufferBytes,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const paramsBuffer = device.createBuffer({ label: '4CGS export compact params', size: 24,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const rows = new Uint16Array(globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined'
    ? new SharedArrayBuffer(outputPointCount * propertyCount * Uint16Array.BYTES_PER_ELEMENT)
    : new ArrayBuffer(outputPointCount * propertyCount * Uint16Array.BYTES_PER_ELEMENT));
  let destinationPoint = 0;
  const startedAt = performance.now();
  try {
    const bindGroup = device.createBindGroup({
      layout: compactionPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: sourceBuffer } },
        { binding: 1, resource: { buffer: keptBuffer } },
        { binding: 2, resource: { buffer: outputBuffer } },
        { binding: 3, resource: { buffer: paramsBuffer } },
      ],
    });
    for (let firstPoint = 0; firstPoint < pointCount; firstPoint += pointsPerChunk) {
      const chunkPointCount = Math.min(pointsPerChunk, pointCount - firstPoint);
      const kept = new Uint32Array(chunkPointCount);
      let keptCount = 0;
      for (let local = 0; local < chunkPointCount; local += 1) {
        if (!deletedAt(deletionWords, firstPoint + local)) kept[keptCount++] = local;
      }
      if (keptCount === 0) continue;
      const sourceValueCount = chunkPointCount * propertyCount;
      const sourceValues = new Uint16Array(sourceValueCount + (sourceValueCount & 1));
      for (let property = 0; property < propertyCount; property += 1) {
        sourceValues.set(columns[property].subarray(firstPoint, firstPoint + chunkPointCount), property * chunkPointCount);
      }
      const outputValueCount = keptCount * propertyCount;
      const outputWordCount = Math.ceil(outputValueCount / 2);
      const outputBytes = outputWordCount * Uint32Array.BYTES_PER_ELEMENT;
      device.queue.writeBuffer(sourceBuffer, 0, new Uint32Array(sourceValues.buffer));
      device.queue.writeBuffer(keptBuffer, 0, kept.subarray(0, keptCount));
      device.queue.writeBuffer(paramsBuffer, 0, new Uint32Array([
        chunkPointCount, propertyCount, keptCount, outputValueCount, outputWordCount, 0,
      ]));
      const encoder = device.createCommandEncoder({ label: '4CGS export compact memory chunk' });
      const pass = encoder.beginComputePass();
      pass.setPipeline(compactionPipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(outputWordCount / WORKGROUP_SIZE));
      pass.end();
      encoder.copyBufferToBuffer(outputBuffer, 0, readback, 0, outputBytes);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ, 0, outputBytes);
      const chunkRows = new Uint16Array(readback.getMappedRange(0, outputBytes), 0, outputValueCount);
      const samples = keptCount === 1 ? [0] : [0, Math.floor(keptCount / 2), keptCount - 1];
      for (const sample of samples) {
        const sourcePoint = firstPoint + kept[sample];
        for (let property = 0; property < propertyCount; property += 1) {
          if (chunkRows[sample * propertyCount + property] !== columns[property][sourcePoint]) {
            throw new Error(`4CGS WebGPU compaction verification failed at ${sourcePoint}/${property}.`);
          }
        }
      }
      rows.set(chunkRows, destinationPoint * propertyCount);
      destinationPoint += keptCount;
      readback.unmap();
    }
    if (destinationPoint !== outputPointCount) throw new Error('4CGS WebGPU compaction point count mismatch.');
    return { rows, elapsedMs: performance.now() - startedAt };
  } finally {
    if (readback.mapState === 'mapped') readback.unmap();
    sourceBuffer.destroy(); keptBuffer.destroy(); outputBuffer.destroy(); readback.destroy(); paramsBuffer.destroy();
  }
}

// #WDD-gpt 2026-09-20 - FP16 Canonical RAM 由 WebGPU 分块完成删除压实与 SoA→row-major 转置；逐块位级抽样失败或设备异常时返回 null 走原 CPU 路径。
export async function compactFourCgsMemoryRowsGpu(
  columns: readonly Uint16Array[],
  deletionWords: Uint32Array,
  pointCount: number,
  outputPointCount: number,
): Promise<FourCgsExportGpuCompaction | null> {
  const gpu = await runtime();
  if (!gpu) return null;
  let resolveTurn!: () => void;
  const previous = gpuQueue;
  gpuQueue = new Promise<void>((resolve) => { resolveTurn = resolve; });
  await previous;
  try { return await compactMemoryRowsOnGpu(gpu, columns, deletionWords, pointCount, outputPointCount); }
  catch { gpuDisabled = true; runtimePromise = null; return null; }
  finally { resolveTurn(); }
}

async function reduceSegment(
  gpu: ExportGpuRuntime,
  segment: FourCgsExportGpuSegment,
): Promise<FourCgsExportGpuCropBits | null> {
  const { device, cropPipeline } = gpu;
  const indices = positionIndices(segment);
  const bankCount = indices.length / 3;
  const maxBufferBytes = Math.min(TARGET_CHUNK_BYTES, device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
  const chunks = planFourCgsExportGpuChunks(
    segment.count, segment.propertyNames.length * Uint16Array.BYTES_PER_ELEMENT, 0,
    maxBufferBytes, device.limits.maxComputeWorkgroupsPerDimension,
  );
  if (chunks.length === 0 || bankCount > device.limits.maxComputeWorkgroupsPerDimension) return null;
  const initialBounds = new Uint32Array([
    0xffff_ffff, 0xffff_ffff, 0xffff_ffff,
    0, 0, 0,
    0,
  ]);
  const sourceBuffer = device.createBuffer({
    label: '4CGS export crop chunk source',
    size: Math.max(...chunks.map((chunk) => chunk.sourceBytes)),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const indexBuffer = device.createBuffer({
    label: '4CGS export crop indices',
    size: indices.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const boundsBuffer = device.createBuffer({
    label: '4CGS export crop bounds',
    size: initialBounds.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });
  const readback = device.createBuffer({
    label: '4CGS export crop readback',
    size: initialBounds.byteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const paramsBuffer = device.createBuffer({
    label: '4CGS export crop params',
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  try {
    device.queue.writeBuffer(indexBuffer, 0, indices);
    device.queue.writeBuffer(boundsBuffer, 0, initialBounds);
    const bindGroup = device.createBindGroup({
      layout: cropPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: sourceBuffer } },
        { binding: 1, resource: { buffer: indexBuffer } },
        { binding: 2, resource: { buffer: boundsBuffer } },
        { binding: 3, resource: { buffer: paramsBuffer } },
      ],
    });
    for (const chunk of chunks) {
      const first = chunk.firstPoint * segment.propertyNames.length;
      const source = packedSource(segment.rows.subarray(first, first + chunk.pointCount * segment.propertyNames.length));
      device.queue.writeBuffer(sourceBuffer, 0, source);
      device.queue.writeBuffer(paramsBuffer, 0, new Uint32Array([
        chunk.pointCount, segment.propertyNames.length, bankCount, 0,
      ]));
      const encoder = device.createCommandEncoder({ label: '4CGS export crop chunk reduction' });
      const pass = encoder.beginComputePass();
      pass.setPipeline(cropPipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(chunk.pointCount / WORKGROUP_SIZE), bankCount);
      pass.end();
      device.queue.submit([encoder.finish()]);
    }
    const readbackEncoder = device.createCommandEncoder({ label: '4CGS export crop bounds readback' });
    readbackEncoder.copyBufferToBuffer(boundsBuffer, 0, readback, 0, initialBounds.byteLength);
    device.queue.submit([readbackEncoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const result = new Uint32Array(readback.getMappedRange()).slice();
    readback.unmap();
    if (result[6] !== 0) throw new Error('4CGS Position 含有非有限 FP16 数。');
    return {
      minimum: [result[0], result[1], result[2]],
      maximum: [result[3], result[4], result[5]],
    };
  } finally {
    if (readback.mapState === 'mapped') readback.unmap();
    sourceBuffer.destroy();
    indexBuffer.destroy();
    boundsBuffer.destroy();
    readback.destroy();
    paramsBuffer.destroy();
  }
}

// #WDD-gpt 2026-09-20 - 导出包围盒按 64MiB 上限分块归约 FP16 Position 位模式；任意大段均只回读 28 字节，异常时安全回退 CPU。
export async function computeFourCgsExportCropGpu(
  segments: readonly FourCgsExportGpuSegment[],
): Promise<FourCgsExportGpuCropBits | null> {
  const gpu = await runtime();
  if (!gpu) return null;
  let resolveTurn!: () => void;
  const previous = gpuQueue;
  gpuQueue = new Promise<void>((resolve) => { resolveTurn = resolve; });
  await previous;
  try {
    const minimum = [0xffff_ffff, 0xffff_ffff, 0xffff_ffff];
    const maximum = [0, 0, 0];
    for (const segment of segments) {
      const bounds = await reduceSegment(gpu, segment);
      if (!bounds) return null;
      for (let axis = 0; axis < 3; axis += 1) {
        minimum[axis] = Math.min(minimum[axis], bounds.minimum[axis]);
        maximum[axis] = Math.max(maximum[axis], bounds.maximum[axis]);
      }
    }
    return {
      minimum: minimum as [number, number, number],
      maximum: maximum as [number, number, number],
    };
  } catch {
    gpuDisabled = true;
    runtimePromise = null;
    return null;
  } finally {
    resolveTurn();
  }
}

export function fourCgsUnorderedHalf(ordered: number): number {
  return ordered & 0x8000 ? ordered ^ 0x8000 : (~ordered) & 0xffff;
}

function alphaFrameSpans(asset: Raw4DAsset): ArrayBuffer {
  const buffer = new ArrayBuffer(asset.totalFrames * 16);
  const view = new DataView(buffer);
  for (let frame = 0; frame < asset.totalFrames; frame += 1) {
    let left = 0;
    let right = 0;
    let alpha = 0;
    if (asset.opacity.keyframes.length > 1 && frame > asset.opacity.keyframes[0]) {
      const last = asset.opacity.keyframes.length - 1;
      if (frame >= asset.opacity.keyframes[last]) {
        left = last;
        right = last;
      } else {
        for (right = 1; right < asset.opacity.keyframes.length; right += 1) {
          if (frame <= asset.opacity.keyframes[right]) {
            left = right - 1;
            alpha = (frame - asset.opacity.keyframes[left])
              / (asset.opacity.keyframes[right] - asset.opacity.keyframes[left]);
            break;
          }
        }
      }
    }
    const offset = frame * 16;
    view.setUint32(offset, left, true);
    view.setUint32(offset + 4, right, true);
    view.setFloat32(offset + 8, alpha, true);
  }
  return buffer;
}

function packedAlphaColumns(asset: Raw4DAsset, firstPoint: number, pointCount: number): Uint32Array | null {
  if (asset.opacity.encoding !== asset.sourceEncoding) return null;
  const columns = [...asset.opacity.values, asset.lifetimeMu, asset.lifetimeW];
  if (asset.sourceEncoding === 'float16') {
    if (columns.some((column) => !(column instanceof Uint16Array))) return null;
    const valueCount = columns.length * pointCount;
    const values = new Uint16Array(valueCount + (valueCount & 1));
    columns.forEach((column, index) => values.set(
      (column as Uint16Array).subarray(firstPoint, firstPoint + pointCount), index * pointCount,
    ));
    return new Uint32Array(values.buffer);
  }
  if (columns.some((column) => !(column instanceof Float32Array))) return null;
  const values = new Float32Array(columns.length * pointCount);
  columns.forEach((column, index) => values.set(
    (column as Float32Array).subarray(firstPoint, firstPoint + pointCount), index * pointCount,
  ));
  return new Uint32Array(values.buffer);
}

async function alphaWitnessesOnGpu(
  gpu: ExportGpuRuntime,
  asset: Raw4DAsset,
  threshold: number,
): Promise<FourCgsExportGpuAlphaWitnesses | null> {
  const { device, alphaPipeline } = gpu;
  if (asset.splatCount < MINIMUM_ALPHA_GPU_POINTS || asset.totalFrames < 2) return null;
  const spans = alphaFrameSpans(asset);
  const columnCount = asset.opacity.values.length + 2;
  const valueBytes = asset.sourceEncoding === 'float32' ? Float32Array.BYTES_PER_ELEMENT : Uint16Array.BYTES_PER_ELEMENT;
  const maxBufferBytes = Math.min(TARGET_CHUNK_BYTES, device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
  if (spans.byteLength > maxBufferBytes) return null;
  const chunks = planFourCgsExportGpuChunks(
    asset.splatCount, columnCount * valueBytes, Uint32Array.BYTES_PER_ELEMENT,
    maxBufferBytes, device.limits.maxComputeWorkgroupsPerDimension,
  );
  if (chunks.length === 0) return null;
  const sourceBuffer = device.createBuffer({
    label: '4CGS export alpha chunk source', size: Math.max(...chunks.map((chunk) => chunk.sourceBytes)),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const spanBuffer = device.createBuffer({
    label: '4CGS export alpha spans', size: spans.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const outputBuffer = device.createBuffer({
    label: '4CGS export alpha chunk witnesses', size: Math.max(...chunks.map((chunk) => chunk.outputBytes)),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });
  const readback = device.createBuffer({
    label: '4CGS export alpha chunk readback', size: Math.max(...chunks.map((chunk) => chunk.outputBytes)),
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const paramsBuffer = device.createBuffer({
    label: '4CGS export alpha params', size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  try {
    const startedAt = performance.now();
    device.queue.writeBuffer(spanBuffer, 0, spans);
    const bindGroup = device.createBindGroup({
      layout: alphaPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: sourceBuffer } },
        { binding: 1, resource: { buffer: spanBuffer } },
        { binding: 2, resource: { buffer: outputBuffer } },
        { binding: 3, resource: { buffer: paramsBuffer } },
      ],
    });
    const frames = new Uint32Array(asset.splatCount);
    for (const chunk of chunks) {
      const source = packedAlphaColumns(asset, chunk.firstPoint, chunk.pointCount);
      if (!source) return null;
      const params = new ArrayBuffer(32);
      const paramsView = new DataView(params);
      paramsView.setUint32(0, chunk.pointCount, true);
      paramsView.setUint32(4, asset.opacity.values.length, true);
      paramsView.setUint32(8, asset.totalFrames, true);
      paramsView.setUint32(12, asset.sourceEncoding === 'float32' ? 1 : 0, true);
      paramsView.setFloat32(16, threshold, true);
      paramsView.setUint32(20, asset.opacityTiming === 'baked' ? 1 : 0, true);
      device.queue.writeBuffer(sourceBuffer, 0, source);
      device.queue.writeBuffer(paramsBuffer, 0, params);
      const encoder = device.createCommandEncoder({ label: '4CGS export alpha witness chunk scan' });
      encoder.clearBuffer(outputBuffer, 0, chunk.outputBytes);
      const pass = encoder.beginComputePass();
      pass.setPipeline(alphaPipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(chunk.pointCount / WORKGROUP_SIZE));
      pass.end();
      encoder.copyBufferToBuffer(outputBuffer, 0, readback, 0, chunk.outputBytes);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ, 0, chunk.outputBytes);
      frames.set(new Uint32Array(readback.getMappedRange(0, chunk.outputBytes), 0, chunk.pointCount), chunk.firstPoint);
      readback.unmap();
    }
    return { frames, elapsedMs: performance.now() - startedAt };
  } finally {
    if (readback.mapState === 'mapped') readback.unmap();
    sourceBuffer.destroy();
    spanBuffer.destroy();
    outputBuffer.destroy();
    readback.destroy();
    paramsBuffer.destroy();
  }
}

// #WDD-gpt 2026-09-20 - GPU 分块给出“可能可见”的整数帧，CPU 仍复算 witness；大资产不再因单 buffer 超限回退全量 CPU 扫描。
export async function computeFourCgsEffectiveAlphaWitnessesGpu(
  asset: Raw4DAsset,
  threshold: number,
): Promise<FourCgsExportGpuAlphaWitnesses | null> {
  if (threshold <= 0 || asset.splatCount < MINIMUM_ALPHA_GPU_POINTS || asset.totalFrames < 2) return null;
  const gpu = await runtime();
  if (!gpu) return null;
  let resolveTurn!: () => void;
  const previous = gpuQueue;
  gpuQueue = new Promise<void>((resolve) => { resolveTurn = resolve; });
  await previous;
  try {
    return await alphaWitnessesOnGpu(gpu, asset, threshold);
  } catch {
    gpuDisabled = true;
    runtimePromise = null;
    return null;
  } finally {
    resolveTurn();
  }
}
