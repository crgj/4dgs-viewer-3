import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { decodePositionContextStreams, decodePositions } from './fourcgs-prs-codec.mjs';
import { decodeSo3RotationStreams } from './fourcgs-so3-temporal-codec.mjs';
import { decodeTemporalAttributeReaders, decodeTemporalAttributeStreams } from './fourcgs-temporal-attribute-codec.mjs';
import { decodeV21PositionContexts, decodeV22ScaleReaders, decodeV22StructuredParts, isV21StructuredStream } from './fourcgs-v21-lossless-codec.mjs';

function propertyNames(segment) {
  const names = [];
  for (let bank = 0; bank < segment.bankCounts.position; bank += 1) for (const component of ['x', 'y', 'z']) names.push(`xyz_bank_${bank}_${component}`);
  for (let bank = 0; bank < segment.bankCounts.rotation; bank += 1) for (const component of ['w', 'x', 'y', 'z']) names.push(`rot_bank_${bank}_${component}`);
  for (let bank = 0; bank < segment.bankCounts.colorDc; bank += 1) for (const component of ['0', '1', '2']) names.push(`f_dc_bank_${bank}_${component}`);
  for (let bank = 0; bank < segment.bankCounts.scale; bank += 1) for (const component of ['0', '1', '2']) names.push(`scale_bank_${bank}_${component}`);
  for (let bank = 0; bank < segment.bankCounts.opacity; bank += 1) names.push(`opacity_bank_${bank}`);
  names.push('lifetime_mu', 'lifetime_w');
  for (let coefficient = 0; coefficient < 45; coefficient += 1) names.push(`f_rest_${coefficient}`);
  return names;
}

// #WDD-gpt 2026-08-16 - V2.4 将互不重叠的 Position/Rotation/Scale/DC 属性写入共享行缓冲，四个 Worker 真并行解码。
async function main() {
  const started = performance.now();
  const { task, manifest } = workerData;
  const activeSlots = workerData.activeSlots.map((values) => new Int32Array(values.buffer, values.byteOffset, values.length));
  const names = manifest.segments.map(propertyNames);
  const indices = names.map((items) => new Map(items.map((name, index) => [name, index])));
  const rows = workerData.rowBuffers.map((buffer, index) => new Uint16Array(buffer, 0, manifest.segments[index].gaussianCount * names[index].length));
  const stream = Buffer.from(workerData.stream.buffer, workerData.stream.byteOffset, workerData.stream.byteLength);
  let metrics;
  let prepareMilliseconds = 0;
  if (task === 'position') {
    if (isV21StructuredStream(stream)) {
      const prepareStarted = performance.now();
      const direct = await decodeV21PositionContexts(stream);
      prepareMilliseconds = performance.now() - prepareStarted;
      metrics = decodePositionContextStreams(direct.contexts, manifest, activeSlots, rows, indices);
    } else metrics = decodePositions(stream, manifest, activeSlots, rows, indices);
  } else if (task === 'scale') {
    const prepareStarted = performance.now();
    const direct = await decodeV22ScaleReaders(stream);
    prepareMilliseconds = performance.now() - prepareStarted;
    metrics = decodeTemporalAttributeReaders(direct.metadata, direct.readers, manifest, activeSlots, rows, indices);
  } else {
    const prepareStarted = performance.now();
    const direct = await decodeV22StructuredParts(task === 'rotation' ? 'so3_rotation' : task === 'scale' ? 'tattr_scale' : 'tattr_dc', stream);
    prepareMilliseconds = performance.now() - prepareStarted;
    if (task === 'rotation') metrics = decodeSo3RotationStreams(direct.metadata, direct.streams, manifest, activeSlots, rows, indices);
    else metrics = decodeTemporalAttributeStreams(direct.metadata, direct.streams, manifest, activeSlots, rows, indices);
  }
  parentPort.postMessage({ task, metrics, prepareMilliseconds, elapsedMilliseconds: performance.now() - started });
}

await main();
