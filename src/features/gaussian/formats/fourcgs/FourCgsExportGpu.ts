import type { Raw4DAsset } from '../raw4d/Raw4DTypes';

const WORKGROUP_SIZE = 256;
const MINIMUM_ALPHA_GPU_POINTS = 65_536;

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

interface ExportGpuRuntime {
  readonly device: GPUDevice;
  readonly cropPipeline: GPUComputePipeline;
  readonly alphaPipeline: GPUComputePipeline;
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
  const [cropPipeline, alphaPipeline] = await Promise.all([
    device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: cropModule, entryPoint: 'main' },
    }),
    device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: alphaModule, entryPoint: 'main' },
    }),
  ]);
  return { device, cropPipeline, alphaPipeline };
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

async function reduceSegment(
  gpu: ExportGpuRuntime,
  segment: FourCgsExportGpuSegment,
): Promise<FourCgsExportGpuCropBits | null> {
  const { device, cropPipeline } = gpu;
  const source = packedSource(segment.rows);
  const indices = positionIndices(segment);
  const bankCount = indices.length / 3;
  const workgroups = Math.ceil(segment.count / WORKGROUP_SIZE);
  if (source.byteLength > device.limits.maxStorageBufferBindingSize
    || source.byteLength > device.limits.maxBufferSize
    || workgroups > device.limits.maxComputeWorkgroupsPerDimension
    || bankCount > device.limits.maxComputeWorkgroupsPerDimension) {
    return null;
  }
  const initialBounds = new Uint32Array([
    0xffff_ffff, 0xffff_ffff, 0xffff_ffff,
    0, 0, 0,
    0,
  ]);
  const sourceBuffer = device.createBuffer({
    label: '4CGS export crop source',
    size: source.byteLength,
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
  const params = new Uint32Array([segment.count, segment.propertyNames.length, bankCount, 0]);
  const paramsBuffer = device.createBuffer({
    label: '4CGS export crop params',
    size: params.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  try {
    device.queue.writeBuffer(sourceBuffer, 0, source);
    device.queue.writeBuffer(indexBuffer, 0, indices);
    device.queue.writeBuffer(boundsBuffer, 0, initialBounds);
    device.queue.writeBuffer(paramsBuffer, 0, params);
    const bindGroup = device.createBindGroup({
      layout: cropPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: sourceBuffer } },
        { binding: 1, resource: { buffer: indexBuffer } },
        { binding: 2, resource: { buffer: boundsBuffer } },
        { binding: 3, resource: { buffer: paramsBuffer } },
      ],
    });
    const encoder = device.createCommandEncoder({ label: '4CGS export crop reduction' });
    const pass = encoder.beginComputePass();
    pass.setPipeline(cropPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(workgroups, bankCount);
    pass.end();
    encoder.copyBufferToBuffer(boundsBuffer, 0, readback, 0, initialBounds.byteLength);
    device.queue.submit([encoder.finish()]);
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

// #WDD-gpt 2026-09-20 - 导出包围盒只归约 FP16 Position 位模式；分段顺序提交并仅回读 24 字节，设备缺失或限额不足时让调用方安全回退 CPU。
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

function packedAlphaColumns(asset: Raw4DAsset): Uint32Array | null {
  if (asset.opacity.encoding !== asset.sourceEncoding) return null;
  const columns = [...asset.opacity.values, asset.lifetimeMu, asset.lifetimeW];
  if (asset.sourceEncoding === 'float16') {
    if (columns.some((column) => !(column instanceof Uint16Array))) return null;
    const values = new Uint16Array(columns.length * asset.splatCount + ((columns.length * asset.splatCount) & 1));
    columns.forEach((column, index) => values.set(column as Uint16Array, index * asset.splatCount));
    return new Uint32Array(values.buffer);
  }
  if (columns.some((column) => !(column instanceof Float32Array))) return null;
  const values = new Float32Array(columns.length * asset.splatCount);
  columns.forEach((column, index) => values.set(column as Float32Array, index * asset.splatCount));
  return new Uint32Array(values.buffer);
}

async function alphaWitnessesOnGpu(
  gpu: ExportGpuRuntime,
  asset: Raw4DAsset,
  threshold: number,
): Promise<FourCgsExportGpuAlphaWitnesses | null> {
  const { device, alphaPipeline } = gpu;
  if (asset.splatCount < MINIMUM_ALPHA_GPU_POINTS || asset.totalFrames < 2) return null;
  const source = packedAlphaColumns(asset);
  if (!source) return null;
  const spans = alphaFrameSpans(asset);
  const outputBytes = asset.splatCount * Uint32Array.BYTES_PER_ELEMENT;
  const workgroups = Math.ceil(asset.splatCount / WORKGROUP_SIZE);
  if (source.byteLength > device.limits.maxStorageBufferBindingSize
    || source.byteLength > device.limits.maxBufferSize
    || spans.byteLength > device.limits.maxStorageBufferBindingSize
    || outputBytes > device.limits.maxStorageBufferBindingSize
    || outputBytes > device.limits.maxBufferSize
    || workgroups > device.limits.maxComputeWorkgroupsPerDimension) {
    return null;
  }
  const sourceBuffer = device.createBuffer({
    label: '4CGS export alpha source', size: source.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const spanBuffer = device.createBuffer({
    label: '4CGS export alpha spans', size: spans.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const outputBuffer = device.createBuffer({
    label: '4CGS export alpha witnesses', size: outputBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    label: '4CGS export alpha readback', size: outputBytes,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const paramsBuffer = device.createBuffer({
    label: '4CGS export alpha params', size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const params = new ArrayBuffer(32);
  const paramsView = new DataView(params);
  paramsView.setUint32(0, asset.splatCount, true);
  paramsView.setUint32(4, asset.opacity.values.length, true);
  paramsView.setUint32(8, asset.totalFrames, true);
  paramsView.setUint32(12, asset.sourceEncoding === 'float32' ? 1 : 0, true);
  paramsView.setFloat32(16, threshold, true);
  paramsView.setUint32(20, asset.opacityTiming === 'baked' ? 1 : 0, true);
  try {
    const startedAt = performance.now();
    device.queue.writeBuffer(sourceBuffer, 0, source);
    device.queue.writeBuffer(spanBuffer, 0, spans);
    device.queue.writeBuffer(paramsBuffer, 0, params);
    const encoder = device.createCommandEncoder({ label: '4CGS export alpha witness scan' });
    const pass = encoder.beginComputePass();
    pass.setPipeline(alphaPipeline);
    pass.setBindGroup(0, device.createBindGroup({
      layout: alphaPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: sourceBuffer } },
        { binding: 1, resource: { buffer: spanBuffer } },
        { binding: 2, resource: { buffer: outputBuffer } },
        { binding: 3, resource: { buffer: paramsBuffer } },
      ],
    }));
    pass.dispatchWorkgroups(workgroups);
    pass.end();
    encoder.copyBufferToBuffer(outputBuffer, 0, readback, 0, outputBytes);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const frames = new Uint32Array(readback.getMappedRange()).slice();
    readback.unmap();
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

// #WDD-gpt 2026-09-20 - GPU 只给出“可能可见”的具体整数帧，CPU 必须复算该帧后才能跳过全帧扫描，确保 GPU 数学近似不会改变 Alpha 剪除结果。
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
