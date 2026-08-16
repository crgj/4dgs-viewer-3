/// <reference lib="webworker" />

import { Buffer } from 'buffer';
import type { FourCgsManifest, FourCgsSegment } from './FourCgsTypes';

type AttributeTask = 'position' | 'rotation' | 'scale' | 'dc';

interface DecodeRequest {
  readonly task: AttributeTask;
  readonly manifest: FourCgsManifest;
  readonly activeSlotBuffers: readonly SharedArrayBuffer[];
  readonly rowBuffers: readonly SharedArrayBuffer[];
  readonly stream: ArrayBuffer;
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

async function decode(request: DecodeRequest): Promise<unknown> {
  // #WDD-gpt 2026-08-16 - 离线解码器使用 Buffer 读二进制；Worker 只注入浏览器 Buffer，不开放任何 Node 文件或进程能力。
  (globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;
  const [prs, rotationCodec, attributeCodec, structuredCodec] = await Promise.all([
    import('../../../../../scripts/fourcgs-prs-codec.mjs'),
    import('../../../../../scripts/fourcgs-so3-temporal-codec.mjs'),
    import('../../../../../scripts/fourcgs-temporal-attribute-codec.mjs'),
    import('../../../../../scripts/fourcgs-v21-lossless-codec.mjs'),
  ]);
  const names = request.manifest.segments.map(propertyNames);
  const indices = names.map((items) => new Map(items.map((name, index) => [name, index])));
  const activeSlots = request.activeSlotBuffers.map((buffer, index) => new Int32Array(buffer, 0, request.manifest.segments[index].gaussianCount));
  const rows = request.rowBuffers.map((buffer, index) => new Uint16Array(buffer, 0, request.manifest.segments[index].gaussianCount * names[index].length));
  const stream = Buffer.from(request.stream);
  if (request.task === 'position') {
    const direct = await structuredCodec.decodeV21PositionContexts(stream);
    return prs.decodePositionContextStreams(direct.contexts, request.manifest, activeSlots, rows, indices);
  }
  if (request.task === 'scale') {
    const direct = await structuredCodec.decodeV22ScaleReaders(stream);
    return attributeCodec.decodeTemporalAttributeReaders(direct.metadata, direct.readers, request.manifest, activeSlots, rows, indices);
  }
  const streamName = request.task === 'rotation' ? 'so3_rotation' : 'tattr_dc';
  const direct = await structuredCodec.decodeV22StructuredParts(streamName, stream);
  return request.task === 'rotation'
    ? rotationCodec.decodeSo3RotationStreams(direct.metadata, direct.streams, request.manifest, activeSlots, rows, indices)
    : attributeCodec.decodeTemporalAttributeStreams(direct.metadata, direct.streams, request.manifest, activeSlots, rows, indices);
}

self.addEventListener('message', (event: MessageEvent<DecodeRequest>) => {
  void decode(event.data).then(
    (metrics) => self.postMessage({ type: 'result', task: event.data.task, metrics }),
    (error: unknown) => self.postMessage({
      type: 'error',
      task: event.data.task,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
});

export {};
