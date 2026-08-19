/// <reference lib="webworker" />

import { Buffer } from 'buffer';
import { unzlibSync } from 'fflate';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { FOUR_CGS_HEADER_BYTES, readFourCgsManifest } from './FourCgsContainer';
import type { FourCgsDescriptor, FourCgsManifest, FourCgsSegment } from './FourCgsTypes';
import { createFourCgsCanonicalRaw4D, fourCgsDecodedPropertyNames } from './FourCgsRaw4D';
import { raw4DBundleMetadata, raw4DBundleStreamName } from './FourCgsRaw4DBundle';

interface OpenRequest {
  readonly type: 'open';
  readonly requestId: number;
  readonly file: File;
}

interface SegmentRequest {
  readonly type: 'segment';
  readonly requestId: number;
  readonly segmentIndex: number;
}

type WorkerRequest = OpenRequest | SegmentRequest;
type RowBuffer = ArrayBuffer | SharedArrayBuffer;

let activeManifest: FourCgsManifest | null = null;
let activeSourceName = '';
let decodedRows: Uint16Array[] = [];
let decodedNames: string[][] = [];
let decodedRaw4DBundle: Uint8Array[] = [];
let lastDecodeWorkerCount = 1;
let lastStreamWorkerCount = 1;
let lastAttributeTasksMs: Readonly<Record<string, number>> = {};

interface AttributeTaskTiming {
  readonly task: string;
  readonly elapsedMs: number;
  readonly workerCount: number;
}

const ATTRIBUTE_TASK_LABELS: Readonly<Record<string, string>> = {
  position: '位置',
  rotation: '旋转',
  scale: '缩放',
  scale0: '缩放 X',
  scale1: '缩放 Y',
  scale2: '缩放 Z',
  dc: 'DC',
  opacity: '透明度',
  lifetime: '生命周期',
  sh: 'SH',
};

function progress(ratio: number, message: string): void {
  self.postMessage({ type: 'progress', ratio, message });
}

function propertyNames(segment: FourCgsSegment): string[] {
  return fourCgsDecodedPropertyNames(segment);
}

async function readStreams(file: File, manifest: FourCgsManifest, manifestBytes: number): Promise<Map<string, Buffer>> {
  let offset = FOUR_CGS_HEADER_BYTES + manifestBytes;
  const ranges = manifest.streams.map((entry) => {
    const range = { entry, offset };
    offset += entry.storedBytes;
    return range;
  });
  if (offset !== file.size) throw new Error(`4CGS 末尾存在 ${file.size - offset} 个未登记字节。`);
  const hardwareConcurrency = navigator.hardwareConcurrency || 4;
  // #WDD-gpt 2026-08-16 - 流读取、SHA 与 Brotli 必须在独立 Worker 真并行；总控 Worker 内 Promise.all 仍会串行执行同步 WASM。
  const concurrency = raw4DBundleMetadata(manifest)
    ? Math.min(2, ranges.length)
    : Math.min(ranges.length, Math.max(2, Math.min(4, Math.floor(hardwareConcurrency / 4))));
  lastStreamWorkerCount = Math.max(1, concurrency);
  const workers = Array.from({ length: concurrency }, () => (
    new Worker(new URL('./fourcgs-stream.worker.ts', import.meta.url), { type: 'module' })
  ));
  const decoded = new Array<readonly [string, Buffer]>(ranges.length);
  let completed = 0;
  let nextRange = 0;
  let requestId = 0;
  const decodeRange = (worker: Worker, rangeIndex: number): Promise<void> => new Promise((resolve, reject) => {
    const range = ranges[rangeIndex];
    const id = ++requestId;
    const cleanup = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    };
    const onMessage = (event: MessageEvent<{
      readonly type: 'result' | 'error'; readonly requestId: number; readonly name?: string;
      readonly bytes?: ArrayBuffer; readonly elapsedMs?: number; readonly message?: string;
    }>) => {
      if (event.data.requestId !== id) return;
      cleanup();
      if (event.data.type === 'error' || !event.data.bytes || !event.data.name) {
        reject(new Error(event.data.message ?? `4CGS 流 ${range.entry.name} Worker 失败。`));
        return;
      }
      decoded[rangeIndex] = [event.data.name, Buffer.from(event.data.bytes)];
      completed += 1;
      progress(
        0.04 + 0.24 * completed / manifest.streams.length,
        `${concurrency} 个 Stream Worker · ${completed}/${manifest.streams.length} 流完成 · ${range.entry.name} ${((event.data.elapsedMs ?? 0) / 1000).toFixed(2)} 秒`,
      );
      resolve();
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      reject(new Error(event.message || `4CGS 流 ${range.entry.name} Worker 崩溃。`));
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage({ requestId: id, file, offset: range.offset, entry: range.entry });
  });
  const runLane = async (worker: Worker) => {
    while (nextRange < ranges.length) {
      const rangeIndex = nextRange++;
      await decodeRange(worker, rangeIndex);
    }
  };
  progress(0.04, `正在启动 ${concurrency} 个 Stream Worker 并行读取、校验和解压`);
  try {
    await Promise.all(workers.map(runLane));
  } finally {
    workers.forEach((worker) => worker.terminate());
  }
  return new Map(decoded);
}

function createActiveSlots(manifest: FourCgsManifest, rawMask: Uint8Array, shared: boolean): Int32Array[] {
  return manifest.segments.map((segment, segmentIndex) => {
    const buffer: RowBuffer = shared ? new SharedArrayBuffer(segment.gaussianCount * 4) : new ArrayBuffer(segment.gaussianCount * 4);
    const slots = new Int32Array(buffer);
    let activeCount = 0;
    for (let slot = 0; slot < manifest.slotCount; slot += 1) {
      const bit = segmentIndex * manifest.slotCount + slot;
      if ((rawMask[bit >>> 3] & (1 << (bit & 7))) !== 0) slots[activeCount++] = slot;
    }
    if (activeCount !== segment.gaussianCount) throw new Error(`4CGS ${segment.name} 活跃点数量不一致。`);
    return slots;
  });
}

function temporalDecode(
  raw: Uint8Array,
  manifest: FourCgsManifest,
  activeSlots: readonly Int32Array[],
  namesBySegment: readonly string[][],
  rows: readonly Uint16Array[],
  indices: readonly Map<string, number>[],
  mode: 'xor' | 'delta' | 'zigzag' = 'xor',
): void {
  const values = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  const state = new Uint16Array(manifest.slotCount);
  const initialized = new Uint8Array(manifest.slotCount);
  let source = 0;
  for (let segmentIndex = 0; segmentIndex < manifest.segments.length; segmentIndex += 1) {
    const stride = indices[segmentIndex].size;
    for (const name of namesBySegment[segmentIndex]) {
      const property = indices[segmentIndex].get(name);
      if (property === undefined) throw new Error(`4CGS 输出属性缺失：${name}。`);
      for (let row = 0; row < activeSlots[segmentIndex].length; row += 1) {
        const slot = activeSlots[segmentIndex][row];
        const coded = values[source++];
        let value = coded;
        if (initialized[slot]) {
          if (mode === 'xor') value = coded ^ state[slot];
          else if (mode === 'delta') value = (state[slot] + (coded < 0x8000 ? coded : coded - 0x10000)) & 0xffff;
          else value = (state[slot] + (coded & 1 ? -(coded + 1) / 2 : coded / 2)) & 0xffff;
        }
        state[slot] = value;
        initialized[slot] = 1;
        rows[segmentIndex][row * stride + property] = value;
      }
    }
  }
  if (source !== values.length) throw new Error(`4CGS 时间流剩余 ${values.length - source} 个值。`);
}

function mixRqTrack(
  raw: Buffer,
  manifest: FourCgsManifest,
  activeSlots: readonly Int32Array[],
  rows: readonly Uint16Array[],
  indices: readonly Map<string, number>[],
  decodeMixRq: (encoded: Buffer) => any,
  decodeMixRqWindows: (encoded: Buffer) => any[],
  decodeScalarRq: (encoded: Buffer) => any,
  decodeTemporalRq: (encoded: Buffer, activeSlots: readonly Int32Array[]) => any,
  decodeOpacityHybrid: (encoded: Buffer) => any,
): void {
  const magic = raw.subarray(0, 8).toString('ascii');
  let bits: Uint16Array;
  let dimensions: number;
  let observationCount: number;
  if (magic === 'MIXWIN01') {
    const windows = decodeMixRqWindows(raw);
    dimensions = windows[0]?.metrics.dimensions ?? 0;
    observationCount = windows.reduce((sum, window) => sum + window.metrics.observationCount, 0);
    bits = new Uint16Array(windows.reduce((sum, window) => sum + window.bits.length, 0));
    let offset = 0;
    for (const window of windows) {
      bits.set(window.bits, offset);
      offset += window.bits.length;
    }
  } else {
    // #WDD-gpt 2026-08-16 - V2.5 Opacity 的后三个时间 bank 逐位无损，首 bank 仍走有界 Scalar RQ。
    const decoded = magic === 'OPHYB001'
      ? decodeOpacityHybrid(raw)
      : (magic === 'MIXSC001'
          ? decodeScalarRq(raw)
          : (magic === 'TMRQ0001' ? decodeTemporalRq(raw, activeSlots) : decodeMixRq(raw)));
    ({ bits } = decoded);
    ({ dimensions, observationCount } = decoded.metrics);
  }
  const expectedDimensions = manifest.segments[0].bankCounts.opacity;
  const expectedObservations = activeSlots.reduce((sum, slots) => sum + slots.length, 0);
  if (dimensions !== expectedDimensions || observationCount !== expectedObservations) throw new Error('4CGS Opacity MixRQ 布局不一致。');
  let observation = 0;
  for (let segmentIndex = 0; segmentIndex < manifest.segments.length; segmentIndex += 1) {
    const stride = indices[segmentIndex].size;
    for (let row = 0; row < activeSlots[segmentIndex].length; row += 1) {
      for (let bank = 0; bank < dimensions; bank += 1) {
        rows[segmentIndex][row * stride + indices[segmentIndex].get(`opacity_bank_${bank}`)!] = bits[observation * dimensions + bank];
      }
      observation += 1;
    }
  }
}

function decodeSharedSh(
  raw: Buffer,
  manifest: FourCgsManifest,
  activeSlots: readonly Int32Array[],
  rows: readonly Uint16Array[],
  indices: readonly Map<string, number>[],
  halfToFloat: (bits: number) => number,
  floatToHalf: (value: number) => number,
): void {
  const magic = raw.subarray(0, 8).toString('ascii');
  if (magic !== 'C5T1SH01' && magic !== 'C5T2SH01') throw new Error('不支持的共享 SH 流。');
  const slotCount = raw.readUInt32LE(8);
  const instanceCount = raw.readUInt32LE(12);
  const segmentCount = raw.readUInt16LE(16);
  const dimensions = raw.readUInt8(18);
  const levels = raw.readUInt8(19);
  const baseBytes = raw.readUInt32LE(20);
  const maskBytes = raw.readUInt32LE(24);
  const labelBytes = raw.readUInt32LE(28);
  const headerBytes = magic === 'C5T2SH01' ? 40 : 32;
  const exceptionMaskBytes = magic === 'C5T2SH01' ? raw.readUInt32LE(32) : 0;
  const exceptionValueBytes = magic === 'C5T2SH01' ? raw.readUInt32LE(36) : 0;
  if (slotCount !== manifest.slotCount || segmentCount !== manifest.segments.length || dimensions !== 45
    || levels < 1 || levels > 32 || (magic === 'C5T1SH01' && levels !== 5)
    || baseBytes !== 45 * 2 + levels * 256 * 45 * 2) {
    throw new Error('4CGS 共享 SH 元数据不一致。');
  }
  const baseOffset = headerBytes;
  const mean = new Float32Array(45);
  for (let dimension = 0; dimension < 45; dimension += 1) mean[dimension] = halfToFloat(raw.readUInt16LE(baseOffset + dimension * 2));
  const codebookOffset = baseOffset + 45 * 2;
  const codebooks = new Float32Array(levels * 256 * 45);
  for (let index = 0; index < codebooks.length; index += 1) codebooks[index] = halfToFloat(raw.readUInt16LE(codebookOffset + index * 2));
  const maskOffset = baseOffset + baseBytes;
  const labelOffset = maskOffset + maskBytes;
  const exceptionMaskOffset = labelOffset + labelBytes;
  const exceptionValueOffset = exceptionMaskOffset + exceptionMaskBytes;
  const updateMask = unzlibSync(raw.subarray(maskOffset, labelOffset));
  const updates = unzlibSync(raw.subarray(labelOffset, exceptionMaskOffset));
  const exceptionMask = magic === 'C5T2SH01'
    ? unzlibSync(raw.subarray(exceptionMaskOffset, exceptionValueOffset))
    : new Uint8Array(Math.ceil(instanceCount / 8));
  const exceptionValues = magic === 'C5T2SH01'
    ? unzlibSync(raw.subarray(exceptionValueOffset, exceptionValueOffset + exceptionValueBytes))
    : new Uint8Array(0);
  if (updateMask.byteLength !== Math.ceil(instanceCount / 8) || updates.byteLength % levels !== 0
    || exceptionMask.byteLength !== Math.ceil(instanceCount / 8) || exceptionValues.byteLength % (45 * 2) !== 0
    || exceptionValueOffset + exceptionValueBytes !== raw.byteLength) {
    throw new Error('4CGS 共享 SH 压缩载荷长度不一致。');
  }
  const state = new Uint8Array(slotCount * levels);
  const initialized = new Uint8Array(slotCount);
  const decodedSh = new Uint16Array(slotCount * 45);
  const restOffsets = indices.map((properties, segmentIndex) => {
    const first = properties.get('f_rest_0');
    if (first === undefined) throw new Error(`4CGS 第 ${segmentIndex + 1} 段缺少 SH 属性。`);
    for (let dimension = 1; dimension < 45; dimension += 1) {
      if (properties.get(`f_rest_${dimension}`) !== first + dimension) throw new Error(`4CGS 第 ${segmentIndex + 1} 段 SH 属性不连续。`);
    }
    return first;
  });
  let instance = 0;
  let updateOffset = 0;
  let exceptionOffset = 0;
  // #WDD-gpt 2026-08-16 - 共享 SH 解码支持输入自训练的 5/10/15 级模板及逐实例稀疏 FP16 质量修正。
  for (let segmentIndex = 0; segmentIndex < manifest.segments.length; segmentIndex += 1) {
    const stride = indices[segmentIndex].size;
    const rowValues = rows[segmentIndex];
    const restOffset = restOffsets[segmentIndex];
    for (let row = 0; row < activeSlots[segmentIndex].length; row += 1) {
      const slot = activeSlots[segmentIndex][row];
      const stateOffset = slot * levels;
      const shOffset = slot * 45;
      const rowOffset = row * stride + restOffset;
      const updated = (updateMask[instance >>> 3] & (1 << (instance & 7))) !== 0;
      if (updated) {
        state.set(updates.subarray(updateOffset, updateOffset + levels), stateOffset);
        initialized[slot] = 1;
        updateOffset += levels;
      }
      if (!initialized[slot]) throw new Error(`4CGS Track ${slot} 缺少 SH 初始化。`);
      if (updated) {
        for (let dimension = 0; dimension < 45; dimension += 1) {
          let value = mean[dimension];
          for (let level = 0; level < levels; level += 1) {
            value += codebooks[(level * 256 + state[stateOffset + level]) * 45 + dimension];
          }
          const bits = floatToHalf(value);
          decodedSh[shOffset + dimension] = bits;
          rowValues[rowOffset + dimension] = bits;
        }
      } else {
        for (let dimension = 0; dimension < 45; dimension += 1) {
          rowValues[rowOffset + dimension] = decodedSh[shOffset + dimension];
        }
      }
      if (exceptionMask[instance >>> 3] & (1 << (instance & 7))) {
        for (let dimension = 0; dimension < 45; dimension += 1) {
          rowValues[rowOffset + dimension] = exceptionValues[exceptionOffset]
            | (exceptionValues[exceptionOffset + 1] << 8);
          exceptionOffset += 2;
        }
      }
      instance += 1;
    }
  }
  if (instance !== instanceCount || updateOffset !== updates.length || exceptionOffset !== exceptionValues.length) {
    throw new Error('4CGS 共享 SH 长度不一致。');
  }
}

function transferableCopy(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function runAttributeWorker(
  task: 'position' | 'rotation' | 'scale' | 'scale0' | 'scale1' | 'scale2' | 'dc',
  stream: Buffer,
  manifest: FourCgsManifest,
  activeSlots: readonly Int32Array[],
  rows: readonly Uint16Array[],
  parallelism = 1,
): Promise<AttributeTaskTiming> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./fourcgs-attribute.worker.ts', import.meta.url), { type: 'module' });
    const finish = () => worker.terminate();
    worker.addEventListener('message', (event: MessageEvent<{ type: string; task: string; elapsedMs?: number; workerCount?: number; message?: string }>) => {
      finish();
      if (event.data.type === 'error') reject(new Error(event.data.message ?? `4CGS ${task} Worker 失败。`));
      else resolve({ task: event.data.task, elapsedMs: event.data.elapsedMs ?? 0, workerCount: event.data.workerCount ?? 1 });
    }, { once: true });
    worker.addEventListener('error', (event) => {
      finish();
      reject(new Error(event.message || `4CGS ${task} Worker 崩溃。`));
    }, { once: true });
    const streamBuffer = transferableCopy(stream);
    worker.postMessage({
      task,
      manifest,
      activeSlotBuffers: activeSlots.map((slots) => slots.buffer),
      rowBuffers: rows.map((row) => row.buffer),
      stream: streamBuffer,
      parallelism,
    }, [streamBuffer]);
  });
}

function runAuxiliaryWorker(
  task: 'opacity' | 'lifetime' | 'sh',
  streamNames: readonly string[],
  streams: Map<string, Buffer>,
  manifest: FourCgsManifest,
  activeSlots: readonly Int32Array[],
  rows: readonly Uint16Array[],
): Promise<AttributeTaskTiming> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./fourcgs-auxiliary.worker.ts', import.meta.url), { type: 'module' });
    const finish = () => worker.terminate();
    worker.addEventListener('message', (event: MessageEvent<{ type: string; task: string; elapsedMs?: number; message?: string }>) => {
      finish();
      if (event.data.type === 'error') reject(new Error(event.data.message ?? `4CGS ${task} Worker 失败。`));
      else resolve({ task: event.data.task, elapsedMs: event.data.elapsedMs ?? 0, workerCount: 1 });
    }, { once: true });
    worker.addEventListener('error', (event) => {
      finish();
      reject(new Error(event.message || `4CGS ${task} Worker 崩溃。`));
    }, { once: true });
    const streamBuffers: Record<string, ArrayBuffer> = {};
    const transfer: ArrayBuffer[] = [];
    for (const streamName of streamNames) {
      const buffer = transferableCopy(streams.get(streamName)!);
      streamBuffers[streamName] = buffer;
      transfer.push(buffer);
    }
    worker.postMessage({
      task,
      manifest,
      activeSlotBuffers: activeSlots.map((slots) => slots.buffer),
      rowBuffers: rows.map((row) => row.buffer),
      streams: streamBuffers,
    }, transfer);
  });
}

async function decodeAttributes(manifest: FourCgsManifest, streams: Map<string, Buffer>): Promise<void> {
  (globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;
  const shared = typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated;
  decodedNames = manifest.segments.map(propertyNames);
  const indices = decodedNames.map((items) => new Map(items.map((name, index) => [name, index])));
  const activeSlots = createActiveSlots(manifest, streams.get('active_masks')!, shared);
  decodedRows = manifest.segments.map((segment, index) => {
    const bytes = segment.gaussianCount * decodedNames[index].length * 2;
    const buffer: RowBuffer = shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
    return new Uint16Array(buffer);
  });
  const hardwareConcurrency = navigator.hardwareConcurrency || 4;
  const useAuxiliaryWorkers = shared && hardwareConcurrency >= 8;
  const scaleTasks = ['tattr_scale_0', 'tattr_scale_1', 'tattr_scale_2'].every((name) => streams.has(name))
    ? (['scale0', 'scale1', 'scale2'] as const)
    : (['scale'] as const);
  const rotationParallelism = useAuxiliaryWorkers && hardwareConcurrency >= 16
    ? Math.min(4, Math.max(2, Math.floor((hardwareConcurrency - 8) / 4)))
    : 1;
  const attributeTaskCount = 3 + scaleTasks.length;
  lastDecodeWorkerCount = shared
    ? 1 + attributeTaskCount + (useAuxiliaryWorkers ? 3 : 0) + (rotationParallelism > 1 ? rotationParallelism : 0)
    : 1;
  progress(0.32, useAuxiliaryWorkers
    ? `正在使用 ${lastDecodeWorkerCount - 1} 个子 Worker 并行解码全部属性`
    : shared ? '正在并行解码 Position / Rotation / Scale / DC' : '正在兼容模式解码 4CGS 属性');

  if (shared) {
    const workers = [
      runAttributeWorker('position', streams.get('prs_position')!, manifest, activeSlots, decodedRows),
      runAttributeWorker('rotation', streams.get('so3_rotation')!, manifest, activeSlots, decodedRows, rotationParallelism),
      ...scaleTasks.map((task) => runAttributeWorker(
        task,
        streams.get(task === 'scale' ? 'tattr_scale' : `tattr_scale_${task.slice(-1)}`)!,
        manifest,
        activeSlots,
        decodedRows,
      )),
      runAttributeWorker('dc', streams.get('tattr_dc')!, manifest, activeSlots, decodedRows),
    ];
    if (useAuxiliaryWorkers) {
      workers.push(
        runAuxiliaryWorker('opacity', ['mixsc_opacity'], streams, manifest, activeSlots, decodedRows),
        runAuxiliaryWorker('lifetime', ['lifetime_mu', 'lifetime_w'], streams, manifest, activeSlots, decodedRows),
        runAuxiliaryWorker('sh', ['coresh5r_shared'], streams, manifest, activeSlots, decodedRows),
      );
    } else {
      const [prs, mix, scalarRq, temporalRq, opacityHybrid] = await Promise.all([
        import('../../../../../scripts/fourcgs-prs-codec.mjs'),
        import('../../../../../scripts/fourcgs-mixrq-codec.mjs'),
        import('../../../../../scripts/fourcgs-scalar-rq-codec.mjs'),
        import('../../../../../scripts/fourcgs-temporal-rq-codec.mjs'),
        import('../../../../../scripts/fourcgs-opacity-hybrid-codec.mjs'),
      ]);
      mixRqTrack(
        streams.get('mixsc_opacity')!, manifest, activeSlots, decodedRows, indices,
        mix.decodeMixRq, mix.decodeMixRqWindows, scalarRq.decodeScalarRq, temporalRq.decodeTemporalRq, opacityHybrid.decodeOpacityHybrid,
      );
      temporalDecode(streams.get('lifetime_mu')!, manifest, activeSlots, manifest.segments.map(() => ['lifetime_mu']), decodedRows, indices, manifest.losslessEntropy?.temporalModes?.lifetime_mu ?? 'xor');
      temporalDecode(streams.get('lifetime_w')!, manifest, activeSlots, manifest.segments.map(() => ['lifetime_w']), decodedRows, indices, manifest.losslessEntropy?.temporalModes?.lifetime_w ?? 'xor');
      decodeSharedSh(streams.get('coresh5r_shared')!, manifest, activeSlots, decodedRows, indices, prs.halfToFloat, prs.floatToHalf);
    }
    const taskOrder = useAuxiliaryWorkers
      ? ['position', 'rotation', ...scaleTasks, 'dc', 'opacity', 'lifetime', 'sh']
      : ['position', 'rotation', ...scaleTasks, 'dc'];
    const completed = new Set<string>();
    const workerStartedAt = performance.now();
    let trackingActive = true;
    const reportWorkerProgress = () => {
      if (!trackingActive) return;
      const remaining = taskOrder.filter((task) => !completed.has(task));
      const visibleTasks = remaining.slice(0, 3).map((task) => ATTRIBUTE_TASK_LABELS[task] ?? task).join('、');
      const remainingLabel = remaining.length > 3 ? `${visibleTasks}等 ${remaining.length} 项` : visibleTasks || '收尾';
      const elapsedSeconds = ((performance.now() - workerStartedAt) / 1000).toFixed(1);
      progress(
        0.32 + 0.56 * completed.size / taskOrder.length,
        `${lastDecodeWorkerCount - 1} 个子 Worker · ${completed.size}/${taskOrder.length} 项完成 · 正在处理 ${remainingLabel} · ${elapsedSeconds} 秒`,
      );
    };
    // #WDD-gpt 2026-08-16 - 子 Worker 解码期间持续回报完成数、剩余属性和耗时，避免 3~4 秒无更新被误判为界面卡死。
    const trackedWorkers = workers.map((worker) => worker.then((timing) => {
      completed.add(timing.task);
      reportWorkerProgress();
      return timing;
    }));
    reportWorkerProgress();
    const heartbeat = globalThis.setInterval(reportWorkerProgress, 400);
    let timings: AttributeTaskTiming[];
    try {
      timings = await Promise.all(trackedWorkers);
    } finally {
      trackingActive = false;
      globalThis.clearInterval(heartbeat);
    }
    lastDecodeWorkerCount = 1 + taskOrder.length
      + timings.reduce((sum, timing) => sum + Math.max(0, timing.workerCount - 1), 0);
    lastAttributeTasksMs = Object.fromEntries(timings.map((timing) => [timing.task, timing.elapsedMs]));
  } else {
    lastAttributeTasksMs = {};
    const [prs, mix, scalarRq, temporalRq, opacityHybrid, rotationCodec, attributeCodec, structuredCodec] = await Promise.all([
      import('../../../../../scripts/fourcgs-prs-codec.mjs'),
      import('../../../../../scripts/fourcgs-mixrq-codec.mjs'),
      import('../../../../../scripts/fourcgs-scalar-rq-codec.mjs'),
      import('../../../../../scripts/fourcgs-temporal-rq-codec.mjs'),
      import('../../../../../scripts/fourcgs-opacity-hybrid-codec.mjs'),
      import('../../../../../scripts/fourcgs-so3-temporal-codec.mjs'),
      import('../../../../../scripts/fourcgs-temporal-attribute-codec.mjs'),
      import('../../../../../scripts/fourcgs-v21-lossless-codec.mjs'),
    ]);
    const position = await structuredCodec.decodeV21PositionContexts(streams.get('prs_position')!);
    prs.decodePositionContextStreams(position.contexts, manifest, activeSlots, decodedRows, indices);
    const rotation = await structuredCodec.decodeV22StructuredParts('so3_rotation', streams.get('so3_rotation')!);
    rotationCodec.decodeSo3RotationStreams(rotation.metadata, rotation.streams, manifest, activeSlots, decodedRows, indices);
    for (const task of scaleTasks) {
      const streamName = task === 'scale' ? 'tattr_scale' : `tattr_scale_${task.slice(-1)}`;
      const scale = await structuredCodec.decodeV22ScaleReaders(streams.get(streamName)!, streamName);
      attributeCodec.decodeTemporalAttributeReaders(scale.metadata, scale.readers, manifest, activeSlots, decodedRows, indices);
    }
    const dc = await structuredCodec.decodeV22StructuredParts('tattr_dc', streams.get('tattr_dc')!);
    attributeCodec.decodeTemporalAttributeStreams(dc.metadata, dc.streams, manifest, activeSlots, decodedRows, indices);
    mixRqTrack(
      streams.get('mixsc_opacity')!, manifest, activeSlots, decodedRows, indices,
      mix.decodeMixRq, mix.decodeMixRqWindows, scalarRq.decodeScalarRq, temporalRq.decodeTemporalRq, opacityHybrid.decodeOpacityHybrid,
    );
    temporalDecode(streams.get('lifetime_mu')!, manifest, activeSlots, manifest.segments.map(() => ['lifetime_mu']), decodedRows, indices, manifest.losslessEntropy?.temporalModes?.lifetime_mu ?? 'xor');
    temporalDecode(streams.get('lifetime_w')!, manifest, activeSlots, manifest.segments.map(() => ['lifetime_w']), decodedRows, indices, manifest.losslessEntropy?.temporalModes?.lifetime_w ?? 'xor');
    decodeSharedSh(streams.get('coresh5r_shared')!, manifest, activeSlots, decodedRows, indices, prs.halfToFloat, prs.floatToHalf);
  }
  progress(0.92, '4CGS 属性解码完成，正在准备首段');
}

async function open(file: File): Promise<FourCgsDescriptor> {
  const totalStartedAt = performance.now();
  progress(0.01, '正在读取 4CGS V2.4 清单');
  const { manifest, manifestBytes } = await readFourCgsManifest(file);
  const streamStartedAt = performance.now();
  const streams = await readStreams(file, manifest, manifestBytes);
  const streamReadMs = performance.now() - streamStartedAt;
  const attributeStartedAt = performance.now();
  const bundle = raw4DBundleMetadata(manifest);
  if (bundle) {
    progress(0.82, '正在校验本次拖入 RAW4D 的逐段原始 SHA-256');
    decodedRows = [];
    decodedNames = [];
    decodedRaw4DBundle = manifest.segments.map((_segment, segmentIndex) => {
      const source = new Uint8Array(bundle.sourceByteLengths[segmentIndex]);
      const sourceHasher = nobleSha256.create();
      let destination = 0;
      for (let chunkIndex = 0; chunkIndex < bundle.segmentChunkCounts[segmentIndex]; chunkIndex += 1) {
        const streamName = raw4DBundleStreamName(segmentIndex, chunkIndex);
        const padded = streams.get(streamName);
        if (!padded) throw new Error(`4CGS RAW4D Bundle 缺少第 ${segmentIndex + 1} 段第 ${chunkIndex + 1} 块。`);
        const byteLength = Math.min(bundle.chunkBytes, source.byteLength - destination);
        const chunk = padded.subarray(0, byteLength);
        source.set(chunk, destination);
        sourceHasher.update(chunk);
        destination += byteLength;
        streams.delete(streamName);
      }
      if (destination !== source.byteLength || bytesToHex(sourceHasher.digest()) !== bundle.sourceSha256[segmentIndex]) {
        throw new Error(`4CGS RAW4D Bundle 第 ${segmentIndex + 1} 段原始 SHA-256 校验失败。`);
      }
      return source;
    });
    lastDecodeWorkerCount = 1;
    lastAttributeTasksMs = {};
    progress(0.92, 'RAW4D 无损段恢复完成，正在准备首段');
  } else {
    decodedRaw4DBundle = [];
    await decodeAttributes(manifest, streams);
  }
  const attributeDecodeMs = performance.now() - attributeStartedAt;
  activeManifest = manifest;
  activeSourceName = file.name;
  progress(1, bundle ? '动态 RAW4D 4CGS 已无损解码' : '4CGS V2.4 已解码');
  return {
    sourceName: file.name,
    sourceBytes: file.size,
    codecName: manifest.codecName,
    firstFrame: manifest.firstFrame,
    lastFrame: manifest.lastFrame,
    totalFrames: manifest.uniqueFrameCount,
    slotCount: manifest.slotCount,
    segments: manifest.segments,
    sceneTransform: manifest.metadata?.sceneTransform,
    cameraBookmarks: manifest.metadata?.cameraBookmarks,
    crossOriginIsolated: globalThis.crossOriginIsolated,
    decodeTimings: {
      streamReadMs,
      streamWorkerCount: lastStreamWorkerCount,
      attributeDecodeMs,
      totalMs: performance.now() - totalStartedAt,
      workerCount: lastDecodeWorkerCount,
      hardwareConcurrency: navigator.hardwareConcurrency || 4,
      attributeTasksMs: lastAttributeTasksMs,
    },
  };
}

function segmentBytes(segmentIndex: number): { name: string; bytes: ArrayBuffer } {
  if (!activeManifest) throw new Error('4CGS 尚未完成解码。');
  const segment = activeManifest.segments[segmentIndex];
  const bundle = raw4DBundleMetadata(activeManifest);
  if (bundle) {
    const source = decodedRaw4DBundle[segmentIndex];
    if (!segment || !source) throw new Error('4CGS RAW4D Bundle 段号无效。');
    // #WDD-gpt 2026-08-16 - 每次请求复制后再 transfer，避免播放回访同一段时缓存 ArrayBuffer 已被 detached。
    const copy = new Uint8Array(source.byteLength);
    copy.set(source);
    return { name: segment.name, bytes: copy.buffer };
  }
  if (!segment || !decodedRows[segmentIndex] || !decodedNames[segmentIndex]) throw new Error('4CGS 尚未完成解码或段号无效。');
  const output = createFourCgsCanonicalRaw4D(segment, decodedNames[segmentIndex], decodedRows[segmentIndex]);
  return { name: segment.name, bytes: output.buffer as ArrayBuffer };
}

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  const operation: Promise<void> = request.type === 'open'
    ? open(request.file).then((value) => self.postMessage({ type: 'result', requestId: request.requestId, value }))
    : Promise.resolve(segmentBytes(request.segmentIndex)).then((value) => {
      self.postMessage({ type: 'result', requestId: request.requestId, value }, [value.bytes]);
    });
  void operation.catch(
    (error: unknown) => self.postMessage({
      type: 'error',
      requestId: request.requestId,
      message: error instanceof Error ? error.message : String(error),
      sourceName: activeSourceName,
    }),
  );
});

export {};
