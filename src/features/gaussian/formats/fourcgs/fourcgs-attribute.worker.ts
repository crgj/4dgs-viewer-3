/// <reference lib="webworker" />

import { Buffer } from 'buffer';
import type { FourCgsManifest, FourCgsSegment } from './FourCgsTypes';
import { fourCgsDecodedPropertyNames } from './FourCgsRaw4D';

type AttributeTask = 'position' | 'rotation' | 'scale' | 'scale0' | 'scale1' | 'scale2' | 'dc';

interface DecodeRequest {
  readonly task: AttributeTask;
  readonly manifest: FourCgsManifest;
  readonly activeSlotBuffers: readonly SharedArrayBuffer[];
  readonly rowBuffers: readonly SharedArrayBuffer[];
  readonly stream: ArrayBuffer;
  readonly parallelism?: number;
}

function propertyNames(segment: FourCgsSegment): string[] {
  return fourCgsDecodedPropertyNames(segment);
}

// #WDD-gpt 2026-09-20 - 复用完成的旋转分区线程；结果返回即释放任务闭包中的共享视图。
const rotationWorkers: Worker[] = [];
async function decodeRotationPartitions(
  prepared: unknown,
  request: DecodeRequest,
  partitionCount: number,
): Promise<Record<string, unknown>> {
  const partitions = Array.from({ length: partitionCount }, (_, partitionIndex) => new Promise<Record<string, number>>((resolve, reject) => {
    const worker = rotationWorkers.pop() ?? new Worker(new URL('./fourcgs-rotation-partition.worker.ts', import.meta.url), { type: 'module' });
    const finish = (success: boolean) => { worker.onmessage = null; worker.onerror = null; if (success && rotationWorkers.length < 4) rotationWorkers.push(worker); else worker.terminate(); };
    worker.onmessage = (event: MessageEvent<{ type: string; metrics?: Record<string, number>; message?: string }>) => {
      finish(event.data.type !== 'error');
      if (event.data.type === 'error') reject(new Error(event.data.message ?? `Rotation 分区 ${partitionIndex + 1} 解码失败。`));
      else resolve(event.data.metrics ?? {});
    };
    worker.onerror = (event) => { finish(false); reject(new Error(event.message || `Rotation 分区 ${partitionIndex + 1} Worker 崩溃。`)); };
    worker.postMessage({
      prepared,
      manifest: request.manifest,
      activeSlotBuffers: request.activeSlotBuffers,
      rowBuffers: request.rowBuffers,
      partitionIndex,
      partitionCount,
    });
  }));
  const metrics = await Promise.all(partitions);
  return {
    observationCount: metrics.reduce((sum, value) => sum + (value.observationCount ?? 0), 0),
    appliedExceptions: metrics[0]?.appliedExceptions ?? 0,
    stepDegrees: metrics[0]?.stepDegrees ?? 0,
    workerCount: partitionCount + 1,
  };
}


async function decode(request: DecodeRequest): Promise<unknown> {
  // #WDD-gpt 2026-08-16 - 离线解码器使用 Buffer 读二进制；Worker 只注入浏览器 Buffer，不开放任何 Node 文件或进程能力。
  (globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;
  const names = request.manifest.segments.map(propertyNames);
  const indices = names.map((items) => new Map(items.map((name, index) => [name, index])));
  const activeSlots = request.activeSlotBuffers.map((buffer, index) => new Int32Array(buffer, 0, request.manifest.segments[index].gaussianCount));
  const rows = request.rowBuffers.map((buffer, index) => new Uint16Array(buffer, 0, request.manifest.segments[index].gaussianCount * names[index].length));
  const stream = Buffer.from(request.stream);
  if (request.task === 'position') {
    const [prs, structuredCodec] = await Promise.all([
      import('../../../../../scripts/fourcgs-prs-codec.mjs'),
      import('../../../../../scripts/fourcgs-v21-lossless-codec.mjs'),
    ]);
    const direct = await structuredCodec.decodeV21PositionContexts(stream);
    return prs.decodePositionContextStreams(direct.contexts, request.manifest, activeSlots, rows, indices);
  }
  if (request.task.startsWith('scale')) {
    const [attributeCodec, structuredCodec] = await Promise.all([
      import('../../../../../scripts/fourcgs-temporal-attribute-codec.mjs'),
      import('../../../../../scripts/fourcgs-v21-lossless-codec.mjs'),
    ]);
    const streamName = request.task === 'scale' ? 'tattr_scale' : `tattr_scale_${request.task.slice(-1)}`;
    const direct = await structuredCodec.decodeV22ScaleReaders(stream, streamName);
    return attributeCodec.decodeTemporalAttributeReaders(direct.metadata, direct.readers, request.manifest, activeSlots, rows, indices);
  }
  if (request.task === 'rotation') {
    const [rotationCodec, structuredCodec] = await Promise.all([
      import('../../../../../scripts/fourcgs-so3-temporal-codec.mjs'),
      import('../../../../../scripts/fourcgs-v21-lossless-codec.mjs'),
    ]);
    const direct = await structuredCodec.decodeV22RotationReaders(stream);
    const activeObservationCount = request.manifest.segments.reduce((sum, segment) => sum + segment.gaussianCount, 0);
    const requestedPartitions = Math.max(1, Math.floor(request.parallelism ?? 1));
    // #WDD-gpt 2026-09-20 - 分区状态已按 Track 取模压缩且例外表零复制；8M/12M 级启用有界双 Worker，旧 20M/24M 超大边界仍保留单路可靠回退。
    const maximumSafePartitions = request.manifest.slotCount >= 16_000_000 || activeObservationCount >= 24_000_000
      ? 1
      : request.manifest.slotCount >= 8_000_000 || activeObservationCount >= 12_000_000
        ? 2
        : requestedPartitions;
    const partitionCount = Math.min(requestedPartitions, maximumSafePartitions);
    const shared = partitionCount > 1 && globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
    // #WDD-gpt 2026-09-20 - Rice 直接生成共享整数平面，避免中间 Varint 流的分配和重解析。
    const prepared = rotationCodec.prepareSo3RotationStreams(
      direct.metadata, direct.streams, request.manifest, activeSlots, shared, direct.readers,
    );
    if (shared) return decodeRotationPartitions(prepared, request, partitionCount);
    return rotationCodec.decodeSo3RotationPartition(prepared, request.manifest, activeSlots, rows, indices);
  }
  const [attributeCodec, structuredCodec] = await Promise.all([
    import('../../../../../scripts/fourcgs-temporal-attribute-codec.mjs'),
    import('../../../../../scripts/fourcgs-v21-lossless-codec.mjs'),
  ]);
  const direct = await structuredCodec.decodeV22DcReaders(stream);
  return attributeCodec.decodeTemporalAttributeReaders(direct.metadata, direct.readers, request.manifest, activeSlots, rows, indices);
}

self.addEventListener('message', (event: MessageEvent<DecodeRequest>) => {
  const startedAt = performance.now();
  void decode(event.data).then(
    (metrics) => {
      const workerCount = metrics && typeof metrics === 'object' && 'workerCount' in metrics
        ? Number((metrics as { workerCount?: unknown }).workerCount) || 1
        : 1;
      self.postMessage({
        type: 'result', task: event.data.task, metrics, workerCount, elapsedMs: performance.now() - startedAt,
      });
    },
    (error: unknown) => self.postMessage({
      type: 'error',
      task: event.data.task,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
});

export {};
