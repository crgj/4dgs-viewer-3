/// <reference lib="webworker" />

import { Buffer } from 'buffer';
import brotliPromise from 'brotli-wasm';
import { unzlibSync } from 'fflate';
import { FOUR_CGS_HEADER_BYTES, readFourCgsManifest } from './FourCgsContainer';
import type { FourCgsDescriptor, FourCgsManifest, FourCgsSegment } from './FourCgsTypes';

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
let lastDecodeWorkerCount = 1;
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
  dc: 'DC',
  opacity: '透明度',
  lifetime: '生命周期',
  sh: 'SH',
};

function progress(ratio: number, message: string): void {
  self.postMessage({ type: 'progress', ratio, message });
}

function propertyNames(segment: FourCgsSegment): string[] {
  const names: string[] = [];
  for (let bank = 0; bank < segment.bankCounts.position; bank += 1) for (const component of ['x', 'y', 'z']) names.push(`xyz_bank_${bank}_${component}`);
  for (let bank = 0; bank < segment.bankCounts.rotation; bank += 1) for (const component of ['w', 'x', 'y', 'z']) names.push(`rot_bank_${bank}_${component}`);
  for (let bank = 0; bank < segment.bankCounts.colorDc; bank += 1) for (const component of ['0', '1', '2']) names.push(`f_dc_bank_${bank}_${component}`);
  for (let bank = 0; bank < segment.bankCounts.scale; bank += 1) for (const component of ['0', '1', '2']) names.push(`scale_bank_${bank}_${component}`);
  for (let bank = 0; bank < segment.bankCounts.opacity; bank += 1) names.push(`opacity_bank_${bank}`);
  names.push('lifetime_mu', 'lifetime_w');
  for (let coefficient = 0; coefficient < 45; coefficient += 1) names.push(`f_rest_${coefficient}`);
  return names;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function unshuffle16(shuffled: Uint8Array): Uint8Array {
  if (shuffled.length % 2 !== 0) throw new Error('4CGS FP16 shuffle 长度必须为偶数。');
  const values = shuffled.length / 2;
  const raw = new Uint8Array(shuffled.length);
  for (let index = 0; index < values; index += 1) {
    raw[index * 2] = shuffled[index];
    raw[index * 2 + 1] = shuffled[values + index];
  }
  return raw;
}

async function readStreams(file: File, manifest: FourCgsManifest, manifestBytes: number): Promise<Map<string, Buffer>> {
  const brotli = await brotliPromise;
  let offset = FOUR_CGS_HEADER_BYTES + manifestBytes;
  const ranges = manifest.streams.map((entry) => {
    const range = { entry, offset };
    offset += entry.storedBytes;
    return range;
  });
  if (offset !== file.size) throw new Error(`4CGS 末尾存在 ${file.size - offset} 个未登记字节。`);
  let completed = 0;
  // #WDD-gpt 2026-08-16 - 独立流并行读取/哈希；raw 流 stored/raw 相同，只计算一次 SHA-256。
  const decoded = await Promise.all(ranges.map(async ({ entry, offset: streamOffset }) => {
    const stored = new Uint8Array(await file.slice(streamOffset, streamOffset + entry.storedBytes).arrayBuffer());
    const storedDigest = await sha256(stored);
    if (stored.length !== entry.storedBytes || storedDigest !== entry.storedSha256) {
      throw new Error(`4CGS 存储流校验失败：${entry.name}。`);
    }
    let raw: Uint8Array;
    if (entry.compression === 'brotli') raw = brotli.decompress(stored);
    else if (entry.compression === 'brotli-shuffle16') raw = unshuffle16(brotli.decompress(stored));
    else if (entry.compression === 'deflate') raw = unzlibSync(stored);
    else raw = stored;
    const rawDigest = raw === stored ? storedDigest : await sha256(raw);
    if (raw.length !== entry.rawBytes || rawDigest !== entry.rawSha256) {
      throw new Error(`4CGS 原始流校验失败：${entry.name}。`);
    }
    completed += 1;
    progress(0.04 + 0.24 * completed / manifest.streams.length, `正在并行校验 4CGS 流 ${completed}/${manifest.streams.length}`);
    return [entry.name, Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)] as const;
  }));
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
  if (raw.subarray(0, 8).toString('ascii') !== 'C5T1SH01') throw new Error('不支持的 CoReSH-5R 共享流。');
  const slotCount = raw.readUInt32LE(8);
  const instanceCount = raw.readUInt32LE(12);
  const segmentCount = raw.readUInt16LE(16);
  const dimensions = raw.readUInt8(18);
  const levels = raw.readUInt8(19);
  const baseBytes = raw.readUInt32LE(20);
  const maskBytes = raw.readUInt32LE(24);
  const labelBytes = raw.readUInt32LE(28);
  if (slotCount !== manifest.slotCount || segmentCount !== manifest.segments.length || dimensions !== 45 || levels !== 5) {
    throw new Error('4CGS 共享 SH 元数据不一致。');
  }
  const baseOffset = 32;
  const mean = new Float32Array(45);
  for (let dimension = 0; dimension < 45; dimension += 1) mean[dimension] = halfToFloat(raw.readUInt16LE(baseOffset + dimension * 2));
  const codebookOffset = baseOffset + 45 * 2;
  const codebooks = new Float32Array(5 * 256 * 45);
  for (let index = 0; index < codebooks.length; index += 1) codebooks[index] = halfToFloat(raw.readUInt16LE(codebookOffset + index * 2));
  const updateMask = unzlibSync(raw.subarray(baseOffset + baseBytes, baseOffset + baseBytes + maskBytes));
  const updates = unzlibSync(raw.subarray(baseOffset + baseBytes + maskBytes, baseOffset + baseBytes + maskBytes + labelBytes));
  const state = new Uint8Array(slotCount * 5);
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
  // #WDD-gpt 2026-08-16 - CoReSH-5R 只在 Track 码字更新时重建 45D FP16，跨段未更新实例直接复用逐 Track 缓存。
  for (let segmentIndex = 0; segmentIndex < manifest.segments.length; segmentIndex += 1) {
    const stride = indices[segmentIndex].size;
    const rowValues = rows[segmentIndex];
    const restOffset = restOffsets[segmentIndex];
    for (let row = 0; row < activeSlots[segmentIndex].length; row += 1) {
      const slot = activeSlots[segmentIndex][row];
      const stateOffset = slot * 5;
      const shOffset = slot * 45;
      const rowOffset = row * stride + restOffset;
      const updated = (updateMask[instance >>> 3] & (1 << (instance & 7))) !== 0;
      if (updated) {
        state.set(updates.subarray(updateOffset, updateOffset + 5), stateOffset);
        initialized[slot] = 1;
        updateOffset += 5;
      }
      if (!initialized[slot]) throw new Error(`4CGS Track ${slot} 缺少 SH 初始化。`);
      if (updated) {
        const code0 = state[stateOffset] * 45;
        const code1 = (256 + state[stateOffset + 1]) * 45;
        const code2 = (512 + state[stateOffset + 2]) * 45;
        const code3 = (768 + state[stateOffset + 3]) * 45;
        const code4 = (1024 + state[stateOffset + 4]) * 45;
        for (let dimension = 0; dimension < 45; dimension += 1) {
          const bits = floatToHalf(mean[dimension]
            + codebooks[code0 + dimension]
            + codebooks[code1 + dimension]
            + codebooks[code2 + dimension]
            + codebooks[code3 + dimension]
            + codebooks[code4 + dimension]);
          decodedSh[shOffset + dimension] = bits;
          rowValues[rowOffset + dimension] = bits;
        }
      } else {
        for (let dimension = 0; dimension < 45; dimension += 1) {
          rowValues[rowOffset + dimension] = decodedSh[shOffset + dimension];
        }
      }
      instance += 1;
    }
  }
  if (instance !== instanceCount || updateOffset !== updates.length) throw new Error('4CGS 共享 SH 长度不一致。');
}

function transferableCopy(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function runAttributeWorker(
  task: 'position' | 'rotation' | 'scale' | 'dc',
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
  const rotationParallelism = useAuxiliaryWorkers && hardwareConcurrency >= 16
    ? Math.min(4, Math.max(2, Math.floor((hardwareConcurrency - 8) / 4)))
    : 1;
  lastDecodeWorkerCount = useAuxiliaryWorkers
    ? 8 + (rotationParallelism > 1 ? rotationParallelism : 0)
    : shared ? 5 : 1;
  progress(0.32, useAuxiliaryWorkers
    ? `正在使用 ${lastDecodeWorkerCount - 1} 个子 Worker 并行解码全部属性`
    : shared ? '正在并行解码 Position / Rotation / Scale / DC' : '正在兼容模式解码 4CGS 属性');

  if (shared) {
    const workers = [
      runAttributeWorker('position', streams.get('prs_position')!, manifest, activeSlots, decodedRows),
      runAttributeWorker('rotation', streams.get('so3_rotation')!, manifest, activeSlots, decodedRows, rotationParallelism),
      runAttributeWorker('scale', streams.get('tattr_scale')!, manifest, activeSlots, decodedRows),
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
      ? ['position', 'rotation', 'scale', 'dc', 'opacity', 'lifetime', 'sh']
      : ['position', 'rotation', 'scale', 'dc'];
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
    const scale = await structuredCodec.decodeV22ScaleReaders(streams.get('tattr_scale')!);
    attributeCodec.decodeTemporalAttributeReaders(scale.metadata, scale.readers, manifest, activeSlots, decodedRows, indices);
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

function raw4dHeader(segment: FourCgsSegment, names: readonly string[]): Uint8Array {
  const lines = [
    'ply',
    'format binary_little_endian 1.0',
    `comment total_frames ${segment.totalFrames}`,
    'comment xyz_bank_keyframe_stride 3',
    'comment rot_bank_keyframe_stride 30',
    'comment features_dc_bank_keyframe_stride 30',
    'comment scaling_bank_keyframe_stride 10',
    'comment opacity_bank_keyframe_stride 10',
    'comment fp16_quantized 1',
    ...names.map((name) => `comment fp16_property ${name}`),
    `element vertex ${segment.gaussianCount}`,
    ...names.map((name) => `property ushort ${name}`),
    'end_header',
  ];
  return new TextEncoder().encode(`${lines.join('\n')}\n`);
}

async function open(file: File): Promise<FourCgsDescriptor> {
  const totalStartedAt = performance.now();
  progress(0.01, '正在读取 4CGS V2.4 清单');
  const { manifest, manifestBytes } = await readFourCgsManifest(file);
  const streamStartedAt = performance.now();
  const streams = await readStreams(file, manifest, manifestBytes);
  const streamReadMs = performance.now() - streamStartedAt;
  const attributeStartedAt = performance.now();
  await decodeAttributes(manifest, streams);
  const attributeDecodeMs = performance.now() - attributeStartedAt;
  activeManifest = manifest;
  activeSourceName = file.name;
  progress(1, '4CGS V2.4 已解码');
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
    crossOriginIsolated: globalThis.crossOriginIsolated,
    decodeTimings: {
      streamReadMs,
      attributeDecodeMs,
      totalMs: performance.now() - totalStartedAt,
      workerCount: lastDecodeWorkerCount,
      hardwareConcurrency: navigator.hardwareConcurrency || 4,
      attributeTasksMs: lastAttributeTasksMs,
    },
  };
}

function segmentBytes(segmentIndex: number): { name: string; bytes: ArrayBuffer } {
  if (!activeManifest || !decodedRows[segmentIndex] || !decodedNames[segmentIndex]) throw new Error('4CGS 尚未完成解码或段号无效。');
  const segment = activeManifest.segments[segmentIndex];
  const header = raw4dHeader(segment, decodedNames[segmentIndex]);
  const payload = new Uint8Array(decodedRows[segmentIndex].buffer, decodedRows[segmentIndex].byteOffset, decodedRows[segmentIndex].byteLength);
  const output = new Uint8Array(header.length + payload.length);
  output.set(header);
  output.set(payload, header.length);
  return { name: segment.name, bytes: output.buffer };
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
