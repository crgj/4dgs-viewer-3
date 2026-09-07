import { describe, expect, it, vi } from 'vitest';
import type { Raw4DAsset, Raw4DTrack } from './Raw4DTypes';
import { exportCompactedRaw4D } from './Raw4DExporter';
import { parseRaw4D } from './Raw4DParser';
import { exportRaw4DSegmentBatch } from './Raw4DSegmentExporter';

const values = (input: readonly number[]) => Float32Array.from(input);
const track = (components: number, offset: number): Raw4DTrack => ({
  encoding: 'float32',
  components,
  keyframes: [0, 1],
  values: Array.from({ length: components * 2 }, (_, column) => values([offset + column, offset + column + 100])),
});

function fixture(name: string, offset: number): Raw4DAsset {
  return {
    sourceName: name,
    sourceEncoding: 'float32',
    splatCount: 2,
    totalFrames: 2,
    shBands: 0,
    position: track(3, offset),
    rotation: track(4, offset + 10),
    colorDc: track(3, offset + 20),
    scale: track(3, offset + 30),
    opacity: track(1, offset + 40),
    shRest: [],
    lifetimeMu: values([0.25, 0.75]),
    lifetimeW: values([1, 1]),
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  };
}

describe('exportRaw4DSegmentBatch', () => {
  it('writes one compacted RAW4D per source segment in order', async () => {
    const first = fixture('segment_0_1.raw4d', 0);
    const second = fixture('segment_1_2.raw4d', 1_000);
    const firstSource = await exportCompactedRaw4D(first, new Uint32Array(1));
    const written: { filename: string; blob: Blob; sourcePreserved: boolean }[] = [];
    const progress = vi.fn();
    const result = await exportRaw4DSegmentBatch([
      {
        asset: first,
        deletionWords: Uint32Array.of(1 << 1),
        filename: 'segment_0_1.raw4d',
        source: Object.assign(firstSource, { name: 'segment_0_1.raw4d' }),
        sourcePreserved: true,
      },
      {
        asset: second,
        deletionWords: new Uint32Array(1),
        filename: 'segment_1_2.raw4d',
        sourcePreserved: false,
      },
    ], {
      onProgress: progress,
      writeSegment: async (file) => { written.push(file); },
    });

    expect(written.map((file) => file.filename)).toEqual(['segment_0_1.raw4d', 'segment_1_2.raw4d']);
    expect(written.map((file) => file.sourcePreserved)).toEqual([true, false]);
    expect((await parseRaw4D(written[0].blob)).splatCount).toBe(1);
    expect((await parseRaw4D(written[1].blob)).splatCount).toBe(2);
    expect(result).toMatchObject({ fileCount: 2, pointCount: 3, sourcePreservedCount: 1 });
    expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({
      completedSegments: 2,
      filename: 'segment_1_2.raw4d',
      ratio: 1,
      stage: 'complete',
    });
  });

  it('stops before writing when cancellation is already requested', async () => {
    const controller = new AbortController();
    controller.abort();
    const writeSegment = vi.fn();
    await expect(exportRaw4DSegmentBatch([{
      asset: fixture('cancel.raw4d', 0),
      deletionWords: new Uint32Array(1),
      filename: 'cancel.raw4d',
      sourcePreserved: false,
    }], { signal: controller.signal, writeSegment })).rejects.toMatchObject({ name: 'AbortError' });
    expect(writeSegment).not.toHaveBeenCalled();
  });
});
