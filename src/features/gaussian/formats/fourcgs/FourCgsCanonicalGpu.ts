import type { FourCgsSegment } from './FourCgsTypes';
import {
  fourCgsCanonicalRaw4DHeader,
  fourCgsCanonicalRaw4DMapping,
} from './FourCgsRaw4D';

const WORKGROUP_SIZE = 256;
const MINIMUM_GPU_PAYLOAD_BYTES = 4 * 1024 * 1024;

const CANONICAL_EXPAND_SHADER = /* wgsl */ `
struct Params {
  inputStride: u32,
  outputStride: u32,
  outputValueCount: u32,
  outputWordCount: u32,
}

@group(0) @binding(0) var<storage, read> sourceWords: array<u32>;
@group(0) @binding(1) var<storage, read> mapping: array<i32>;
@group(0) @binding(2) var<storage, read_write> outputWords: array<u32>;
@group(0) @binding(3) var<uniform> params: Params;

fn sourceHalf(outputIndex: u32) -> u32 {
  if (outputIndex >= params.outputValueCount) {
    return 0u;
  }
  let row = outputIndex / params.outputStride;
  let property = outputIndex - row * params.outputStride;
  let sourceProperty = mapping[property];
  if (sourceProperty < 0) {
    return 0u;
  }
  let sourceIndex = row * params.inputStride + u32(sourceProperty);
  let packed = sourceWords[sourceIndex >> 1u];
  let shift = (sourceIndex & 1u) * 16u;
  return (packed >> shift) & 0xffffu;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let wordIndex = id.x;
  if (wordIndex >= params.outputWordCount) {
    return;
  }
  let first = sourceHalf(wordIndex * 2u);
  let second = sourceHalf(wordIndex * 2u + 1u);
  outputWords[wordIndex] = first | (second << 16u);
}
`;

interface CanonicalGpuRuntime {
  readonly device: GPUDevice;
  readonly pipeline: GPUComputePipeline;
}

let runtimePromise: Promise<CanonicalGpuRuntime | null> | null = null;
let gpuDisabled = false;
let gpuQueue: Promise<void> = Promise.resolve();

async function createRuntime(): Promise<CanonicalGpuRuntime | null> {
  if (gpuDisabled || !navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  device.lost.then(() => {
    gpuDisabled = true;
    runtimePromise = null;
  }).catch(() => undefined);
  const module = device.createShaderModule({ code: CANONICAL_EXPAND_SHADER });
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });
  return { device, pipeline };
}

async function runtime(): Promise<CanonicalGpuRuntime | null> {
  runtimePromise ??= createRuntime().catch(() => {
    gpuDisabled = true;
    return null;
  });
  return await runtimePromise;
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
): Promise<Uint8Array | null> {
  const { device, pipeline } = gpu;
  const { names, mapping } = fourCgsCanonicalRaw4DMapping(segment, decodedNames);
  if (decodedRows.length !== segment.gaussianCount * decodedNames.length) {
    throw new Error(`4CGS decoded row length mismatch for ${segment.name}.`);
  }
  const outputValueCount = segment.gaussianCount * names.length;
  const payloadBytes = outputValueCount * Uint16Array.BYTES_PER_ELEMENT;
  if (payloadBytes < MINIMUM_GPU_PAYLOAD_BYTES) return null;
  const outputWordCount = Math.ceil(outputValueCount / 2);
  const outputBufferBytes = outputWordCount * Uint32Array.BYTES_PER_ELEMENT;
  const source = packedSource(decodedRows);
  if (source.byteLength > device.limits.maxStorageBufferBindingSize
    || outputBufferBytes > device.limits.maxStorageBufferBindingSize
    || Math.max(source.byteLength, outputBufferBytes) > device.limits.maxBufferSize) {
    return null;
  }

  const sourceBuffer = device.createBuffer({
    label: '4CGS canonical source', size: source.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const mappingBuffer = device.createBuffer({
    label: '4CGS canonical mapping', size: mapping.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const outputBuffer = device.createBuffer({
    label: '4CGS canonical output', size: outputBufferBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    label: '4CGS canonical readback', size: outputBufferBytes,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const params = new Uint32Array([
    decodedNames.length,
    names.length,
    outputValueCount,
    outputWordCount,
  ]);
  const paramsBuffer = device.createBuffer({
    label: '4CGS canonical params', size: params.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  try {
    device.queue.writeBuffer(sourceBuffer, 0, source);
    device.queue.writeBuffer(mappingBuffer, 0, mapping);
    device.queue.writeBuffer(paramsBuffer, 0, params);
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: sourceBuffer } },
        { binding: 1, resource: { buffer: mappingBuffer } },
        { binding: 2, resource: { buffer: outputBuffer } },
        { binding: 3, resource: { buffer: paramsBuffer } },
      ],
    });
    const encoder = device.createCommandEncoder({ label: '4CGS canonical expansion' });
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(outputWordCount / WORKGROUP_SIZE));
    pass.end();
    encoder.copyBufferToBuffer(outputBuffer, 0, readback, 0, outputBufferBytes);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const payload = new Uint8Array(readback.getMappedRange(), 0, payloadBytes);
    const header = fourCgsCanonicalRaw4DHeader(segment, names);
    const output = new Uint8Array(header.byteLength + payloadBytes);
    output.set(header);
    output.set(payload, header.byteLength);
    readback.unmap();
    return output;
  } finally {
    if (readback.mapState === 'mapped') readback.unmap();
    sourceBuffer.destroy();
    mappingBuffer.destroy();
    outputBuffer.destroy();
    readback.destroy();
    paramsBuffer.destroy();
  }
}

// #WDD-gpt 2026-09-20 - 大片段优先由 WebGPU 并行完成 FP16 列展开；设备缺失、限额不足或执行失败时返回 null 让调用方无缝回退 CPU。
export async function createFourCgsCanonicalRaw4DGpu(
  segment: FourCgsSegment,
  decodedNames: readonly string[],
  decodedRows: Uint16Array,
): Promise<Uint8Array | null> {
  const gpu = await runtime();
  if (!gpu) return null;
  let resolveTurn!: () => void;
  const previous = gpuQueue;
  gpuQueue = new Promise<void>((resolve) => { resolveTurn = resolve; });
  await previous;
  try {
    return await expandOnGpu(gpu, segment, decodedNames, decodedRows);
  } catch {
    gpuDisabled = true;
    runtimePromise = null;
    return null;
  } finally {
    resolveTurn();
  }
}
