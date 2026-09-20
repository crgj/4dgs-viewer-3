/// <reference lib="webworker" />

import type { FourCgsManifest, FourCgsSegment } from './FourCgsTypes';
import { fourCgsDecodedPropertyNames } from './FourCgsRaw4D';

interface RotationPartitionRequest {
  readonly prepared: unknown;
  readonly manifest: FourCgsManifest;
  readonly activeSlotBuffers: readonly SharedArrayBuffer[];
  readonly rowBuffers: readonly SharedArrayBuffer[];
  readonly partitionIndex: number;
  readonly partitionCount: number;
}

function propertyNames(segment: FourCgsSegment): string[] {
  return fourCgsDecodedPropertyNames(segment);
}

// #WDD-gpt 2026-08-16 - 每个子 Worker 只重建固定永久 Track 分区，输出列共享但写入行互不重叠。
self.addEventListener('message', (event: MessageEvent<RotationPartitionRequest>) => {
  const startedAt = performance.now();
  void import('../../../../../scripts/fourcgs-so3-temporal-codec.mjs').then(
    (codec) => {
      const names = event.data.manifest.segments.map(propertyNames);
      const indices = names.map((items) => new Map(items.map((name, index) => [name, index])));
      const activeSlots = event.data.activeSlotBuffers.map((buffer, index) => new Int32Array(
        buffer, 0, event.data.manifest.segments[index].gaussianCount,
      ));
      const rows = event.data.rowBuffers.map((buffer, index) => new Uint16Array(
        buffer, 0, event.data.manifest.segments[index].gaussianCount * names[index].length,
      ));
      const metrics = codec.decodeSo3RotationPartition(
        event.data.prepared,
        event.data.manifest,
        activeSlots,
        rows,
        indices,
        event.data.partitionIndex,
        event.data.partitionCount,
      );
      self.postMessage({ type: 'result', metrics, elapsedMs: performance.now() - startedAt });
    },
  ).catch(
    // #WDD-gpt 2026-09-20 - 捕获解码回调中的同步异常，确保主线程收到错误并可执行降级。
    (error: unknown) => self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    }),
  );
});

export {};
