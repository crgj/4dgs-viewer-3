/// <reference lib="webworker" />

import { Buffer } from 'buffer';
import type { FourCgsSegment } from './FourCgsTypes';

type EncodeTask = 'position' | 'rotation' | 'scale0' | 'scale1' | 'scale2' | 'dc';

interface BrowserSegmentInput {
  readonly path: string;
  readonly count: number;
  readonly propertyNames: readonly string[];
  readonly propertyIndex: ReadonlyMap<string, number>;
  readonly comments: ReadonlyMap<string, string>;
  readonly rows: Uint16Array;
}

interface EncodeRequest {
  readonly task: EncodeTask;
  readonly segments: readonly BrowserSegmentInput[];
  readonly layout: Record<string, unknown>;
  readonly descriptors: readonly FourCgsSegment[];
  readonly options: Readonly<Record<string, unknown>>;
}

function transferableBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function positionEnvelopeWorkerCount(): number {
  const hardwareConcurrency = navigator.hardwareConcurrency || 4;
  // #WDD-gpt 2026-08-16 - 实测 13980HX 上六路 Brotli 会争抢带宽，24+ 线程仍以四个持久 WASM Worker 获得更短墙钟时间。
  return hardwareConcurrency >= 12 ? 4 : hardwareConcurrency >= 8 ? 3 : 2;
}

async function compressPositionParts(
  parts: readonly Uint8Array[],
  quality: number,
): Promise<readonly Uint8Array[]> {
  const workerCount = Math.min(parts.length, positionEnvelopeWorkerCount());
  const output = new Array<Uint8Array>(parts.length);
  let nextPart = 0;
  const runLane = async (): Promise<void> => {
    const worker = new Worker(new URL('./fourcgs-brotli-compress.worker.ts', import.meta.url), { type: 'module' });
    try {
      for (;;) {
        const partIndex = nextPart++;
        if (partIndex >= parts.length) return;
        const source = new Uint8Array(parts[partIndex].byteLength);
        source.set(parts[partIndex]);
        output[partIndex] = await new Promise<Uint8Array>((resolve, reject) => {
          const onMessage = (event: MessageEvent<{
            readonly type: 'result' | 'error';
            readonly requestId: number;
            readonly bytes?: ArrayBuffer;
            readonly message?: string;
          }>) => {
            if (event.data.requestId !== partIndex) return;
            worker.removeEventListener('message', onMessage);
            if (event.data.type === 'error' || !event.data.bytes) reject(new Error(event.data.message ?? 'Position Brotli Worker 失败。'));
            else resolve(new Uint8Array(event.data.bytes));
          };
          worker.addEventListener('message', onMessage);
          worker.addEventListener('error', (event) => reject(new Error(event.message || 'Position Brotli Worker 崩溃。')), { once: true });
          worker.postMessage({ requestId: partIndex, bytes: source.buffer, quality }, [source.buffer]);
        });
      }
    } finally {
      worker.terminate();
    }
  };
  // #WDD-gpt 2026-08-16 - Position 六条上下文由 2~4 个持久 Worker 动态取块，避免每块重复初始化 Brotli WASM。
  await Promise.all(Array.from({ length: workerCount }, () => runLane()));
  return output;
}

async function encode(request: EncodeRequest, onStarted: () => void): Promise<{
  readonly encoded: ArrayBuffer;
  readonly metrics: Record<string, unknown>;
}> {
  (globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;
  const structuredCodec = await import('../../../../../scripts/fourcgs-v21-lossless-codec.mjs');
  if (request.task === 'position') {
    const prsCodec = await import('../../../../../scripts/fourcgs-prs-codec.mjs');
    onStarted();
    const codecStartedAt = performance.now();
    const result = prsCodec.encodePositionRaw(
      request.segments,
      request.layout,
      request.descriptors.map((segment) => segment.bankCounts.position),
      request.options,
    );
    const codecMs = performance.now() - codecStartedAt;
    const envelopeStartedAt = performance.now();
    const stored = await structuredCodec.encodeV21StructuredStream(
      'prs_position', { mainRaw: result.mainRaw, exceptionRaw: result.exceptionRaw }, { segments: request.descriptors },
      { blockCompression: 'brotli', brotliQuality: 9, compressPositionParts },
    );
    const envelopeMs = performance.now() - envelopeStartedAt;
    // #WDD-gpt 2026-08-16 - 单独记录 Position 预测编码与 Brotli 封装，监督窗口可据此判断下一步该优化算法还是压缩后端。
    return {
      encoded: transferableBytes(stored.encoded),
      metrics: {
        ...result.metrics,
        codecMs,
        envelopeMs,
        envelopeWorkerCount: positionEnvelopeWorkerCount(),
        skippedTransientRansBytes: result.mainRaw.byteLength + result.exceptionRaw.byteLength,
      },
    };
  }
  if (request.task === 'rotation') {
    const rotationCodec = await import('../../../../../scripts/fourcgs-so3-temporal-codec.mjs');
    onStarted();
    const result = rotationCodec.encodeSo3Rotations(
      request.segments,
      request.layout,
      request.descriptors.map((segment) => segment.bankCounts.rotation),
      request.options,
    );
    const stored = await structuredCodec.encodeV22StructuredStream(
      'so3_rotation', result.encoded, { blockCompression: 'brotli', brotliQuality: 9 },
    );
    return { encoded: transferableBytes(stored.encoded), metrics: result.metrics };
  }
  const attributeCodec = await import('../../../../../scripts/fourcgs-temporal-attribute-codec.mjs');
  onStarted();
  const scale = request.task.startsWith('scale');
  const scaleComponent = scale ? request.task.slice(-1) : '';
  const result = attributeCodec.encodeTemporalAttribute(request.segments, request.layout, {
    prefix: scale ? 'scale_bank' : 'f_dc_bank',
    components: scale ? [scaleComponent] : ['0', '1', '2'],
    bankCounts: request.descriptors.map((segment) => (
      scale ? segment.bankCounts.scale : segment.bankCounts.colorDc
    )),
    exactHalf: false,
    step: request.options.step,
  });
  const streamName = scale ? `tattr_scale_${scaleComponent}` : 'tattr_dc';
  const stored = await structuredCodec.encodeV22StructuredStream(
    streamName, result.encoded, { blockCompression: 'brotli', brotliQuality: 9 },
  );
  return { encoded: transferableBytes(stored.encoded), metrics: result.metrics };
}

self.addEventListener('message', (event: MessageEvent<EncodeRequest>) => {
  const startedAt = performance.now();
  let started = false;
  const reportStarted = () => {
    if (started) return;
    started = true;
    self.postMessage({ type: 'started', task: event.data.task });
  };
  void encode(event.data, reportStarted).then(
    (result) => self.postMessage({
      type: 'result', task: event.data.task, ...result, elapsedMs: performance.now() - startedAt,
    }, [result.encoded]),
    (error: unknown) => self.postMessage({
      type: 'error', task: event.data.task,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
});

export {};
