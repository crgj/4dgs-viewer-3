import { open, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createRaw4DGpuMemoryPlan } from '../../runtime/Raw4DGpuMemoryPlan';
import { measureRaw4DAssetBytes } from './Raw4DMemoryMetrics';
import { parseRaw4D } from './Raw4DParser';
import type { Raw4DSource } from './Raw4DTypes';

const sourcePath = process.env.RAW4D_TEST_FILE;

describe.skipIf(!sourcePath)('RAW4D real-file memory integration', () => {
  it('parses into one source-width backing store and a bounded GPU slot plan', async () => {
    const sourceStats = await stat(sourcePath!);
    const handle = await open(sourcePath!, 'r');
    const source: Raw4DSource = {
      size: sourceStats.size,
      slice(start = 0, end = sourceStats.size) {
        return {
          async arrayBuffer() {
            const bytes = new Uint8Array(Math.max(0, end - start));
            await handle.read(bytes, 0, bytes.length, start);
            return bytes.buffer;
          },
        } as Blob;
      },
    };
    try {
      const asset = await parseRaw4D(source, { sourceName: sourcePath!, chunkRows: 16_384 });
      const cpuResidentBytes = measureRaw4DAssetBytes(asset);
      const gpu = createRaw4DGpuMemoryPlan(asset);
      const buffers = new Set<ArrayBufferLike>();
      const add = (values: readonly (Float32Array | Uint16Array)[]) => {
        values.forEach((value) => buffers.add(value.buffer));
      };
      add(asset.position.values); add(asset.rotation.values); add(asset.colorDc.values);
      add(asset.scale.values); add(asset.opacity.values); add(asset.shRest);
      add([asset.lifetimeMu, asset.lifetimeW]);
      expect(buffers.size).toBe(1);
      expect(gpu.positionSlotCount).toBeLessThanOrEqual(3);
      expect(gpu.scaleSlotCount).toBeLessThanOrEqual(3);
      if (asset.sourceEncoding === 'float16') expect(asset.position.values[0]).toBeInstanceOf(Uint16Array);
      process.stdout.write(`${JSON.stringify({
        sourceEncoding: asset.sourceEncoding,
        splatCount: asset.splatCount,
        sourceM: sourceStats.size / 1_000_000,
        cpuResidentM: cpuResidentBytes / 1_000_000,
        gpuStreamingM: gpu.totalBytes / 1_000_000,
      })}\n`);
    } finally {
      await handle.close();
    }
  }, 120_000);
});
