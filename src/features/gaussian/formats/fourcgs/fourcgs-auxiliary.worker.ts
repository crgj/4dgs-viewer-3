import { prepareSharedSh, decodeSharedShPartition, type PreparedSharedSh } from './FourCgsSharedSh';
/// <reference lib="webworker" />

import { Buffer } from 'buffer';
import type { FourCgsManifest, FourCgsSegment } from './FourCgsTypes';
import { fourCgsDecodedPropertyNames } from './FourCgsRaw4D';

type AuxiliaryTask = 'opacity' | 'lifetime' | 'sh';

interface DecodeRequest {
  readonly task: AuxiliaryTask;
  readonly manifest: FourCgsManifest;
  readonly activeSlotBuffers: readonly SharedArrayBuffer[];
  readonly rowBuffers: readonly SharedArrayBuffer[];
  readonly streams: Readonly<Record<string, ArrayBuffer>>;
}

function propertyNames(segment: FourCgsSegment): string[] {
  return fourCgsDecodedPropertyNames(segment);
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

export function decodeSharedSh(raw: Buffer, manifest: FourCgsManifest, activeSlots: readonly Int32Array[], rows: readonly Uint16Array[],
  indices: readonly Map<string, number>[], halfToFloat: (bits: number) => number, floatToHalf: (value: number) => number): void {
  decodeSharedShPartition(prepareSharedSh(raw, manifest, halfToFloat), manifest, activeSlots, rows, indices, floatToHalf);
}
const shWorkers: Worker[] = [];
async function decodeShPartitions(prepared: PreparedSharedSh, request: DecodeRequest, count: number) {
  await Promise.all(Array.from({ length: count }, (_, partitionIndex) => new Promise<void>((resolve, reject) => {
    const worker = shWorkers.pop() ?? new Worker(new URL('./fourcgs-sh-partition.worker.ts', import.meta.url), { type: 'module' });
    const finish = (success: boolean) => { worker.onmessage = null; worker.onerror = null; if (success && shWorkers.length < 3) shWorkers.push(worker); else worker.terminate(); };
    worker.onmessage = ({ data }) => { finish(data.type === 'result'); if (data.type === 'result') resolve(); else reject(new Error(data.message)); };
    worker.onerror = event => { finish(false); reject(new Error(event.message || 'SH partition worker failed')); };
    worker.postMessage({ prepared, manifest: request.manifest, activeSlotBuffers: request.activeSlotBuffers,
      rowBuffers: request.rowBuffers, partitionIndex, partitionCount: count });
  })));
}

async function decode(request: DecodeRequest): Promise<number> {
  (globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;
  const names = request.manifest.segments.map(propertyNames);
  const indices = names.map((items) => new Map(items.map((name, index) => [name, index])));
  const activeSlots = request.activeSlotBuffers.map((buffer, index) => new Int32Array(buffer, 0, request.manifest.segments[index].gaussianCount));
  const rows = request.rowBuffers.map((buffer, index) => new Uint16Array(buffer, 0, request.manifest.segments[index].gaussianCount * names[index].length));
  if (request.task === 'lifetime') {
    temporalDecode(new Uint8Array(request.streams.lifetime_mu), request.manifest, activeSlots, request.manifest.segments.map(() => ['lifetime_mu']), rows, indices, request.manifest.losslessEntropy?.temporalModes?.lifetime_mu ?? 'xor');
    temporalDecode(new Uint8Array(request.streams.lifetime_w), request.manifest, activeSlots, request.manifest.segments.map(() => ['lifetime_w']), rows, indices, request.manifest.losslessEntropy?.temporalModes?.lifetime_w ?? 'xor');
    return 1;
  }
  if (request.task === 'sh') {
    const prs = await import('../../../../../scripts/fourcgs-prs-codec.mjs');
    const count = globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined'
      && (navigator.hardwareConcurrency || 4) >= 16 && request.manifest.slotCount < 8_000_000 ? 3 : 1;
    const prepared = prepareSharedSh(Buffer.from(request.streams.coresh5r_shared), request.manifest, prs.halfToFloat, count > 1);
    if (count > 1) await decodeShPartitions(prepared, request, count);
    else decodeSharedShPartition(prepared, request.manifest, activeSlots, rows, indices, prs.floatToHalf);
    return count > 1 ? count + 1 : 1;
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
  return 1;
}

self.addEventListener('message', (event: MessageEvent<DecodeRequest>) => {
  const startedAt = performance.now();
  void decode(event.data).then(
    (workerCount) => self.postMessage({ type: 'result', workerCount, task: event.data.task, elapsedMs: performance.now() - startedAt }),
    (error: unknown) => self.postMessage({
      type: 'error',
      task: event.data.task,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
});

export {};
