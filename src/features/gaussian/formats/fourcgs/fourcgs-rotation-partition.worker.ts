/// <reference lib="webworker" />

import type { FourCgsManifest, FourCgsSegment } from './FourCgsTypes';

interface RotationPartitionRequest {
  readonly prepared: unknown;
  readonly manifest: FourCgsManifest;
  readonly activeSlotBuffers: readonly SharedArrayBuffer[];
  readonly rowBuffers: readonly SharedArrayBuffer[];
  readonly partitionIndex: number;
  readonly partitionCount: number;
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
    (error: unknown) => self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    }),
  );
});

export {};
