/// <reference lib="webworker" />

import { Buffer } from 'buffer';
import { unzlibSync } from 'fflate';
import type { FourCgsManifest, FourCgsSegment } from './FourCgsTypes';

type AuxiliaryTask = 'opacity' | 'lifetime' | 'sh';

interface DecodeRequest {
  readonly task: AuxiliaryTask;
  readonly manifest: FourCgsManifest;
  readonly activeSlotBuffers: readonly SharedArrayBuffer[];
  readonly rowBuffers: readonly SharedArrayBuffer[];
  readonly streams: Readonly<Record<string, ArrayBuffer>>;
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
    // #WDD-gpt 2026-08-16 - 辅助 Worker 与主解码路径共同识别 V2.5 混合透明度流，避免线程数不同导致结果漂移。
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

async function decode(request: DecodeRequest): Promise<void> {
  (globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;
  const names = request.manifest.segments.map(propertyNames);
  const indices = names.map((items) => new Map(items.map((name, index) => [name, index])));
  const activeSlots = request.activeSlotBuffers.map((buffer, index) => new Int32Array(buffer, 0, request.manifest.segments[index].gaussianCount));
  const rows = request.rowBuffers.map((buffer, index) => new Uint16Array(buffer, 0, request.manifest.segments[index].gaussianCount * names[index].length));
  if (request.task === 'lifetime') {
    temporalDecode(new Uint8Array(request.streams.lifetime_mu), request.manifest, activeSlots, request.manifest.segments.map(() => ['lifetime_mu']), rows, indices, request.manifest.losslessEntropy?.temporalModes?.lifetime_mu ?? 'xor');
    temporalDecode(new Uint8Array(request.streams.lifetime_w), request.manifest, activeSlots, request.manifest.segments.map(() => ['lifetime_w']), rows, indices, request.manifest.losslessEntropy?.temporalModes?.lifetime_w ?? 'xor');
    return;
  }
  if (request.task === 'sh') {
    const prs = await import('../../../../../scripts/fourcgs-prs-codec.mjs');
    decodeSharedSh(Buffer.from(request.streams.coresh5r_shared), request.manifest, activeSlots, rows, indices, prs.halfToFloat, prs.floatToHalf);
    return;
  }
  const [mix, scalarRq, temporalRq, opacityHybrid] = await Promise.all([
    import('../../../../../scripts/fourcgs-mixrq-codec.mjs'),
    import('../../../../../scripts/fourcgs-scalar-rq-codec.mjs'),
    import('../../../../../scripts/fourcgs-temporal-rq-codec.mjs'),
    import('../../../../../scripts/fourcgs-opacity-hybrid-codec.mjs'),
  ]);
  mixRqTrack(
    Buffer.from(request.streams.mixsc_opacity), request.manifest, activeSlots, rows, indices,
    mix.decodeMixRq, mix.decodeMixRqWindows, scalarRq.decodeScalarRq, temporalRq.decodeTemporalRq, opacityHybrid.decodeOpacityHybrid,
  );
}

self.addEventListener('message', (event: MessageEvent<DecodeRequest>) => {
  const startedAt = performance.now();
  void decode(event.data).then(
    () => self.postMessage({ type: 'result', task: event.data.task, elapsedMs: performance.now() - startedAt }),
    (error: unknown) => self.postMessage({
      type: 'error',
      task: event.data.task,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
});

export {};
