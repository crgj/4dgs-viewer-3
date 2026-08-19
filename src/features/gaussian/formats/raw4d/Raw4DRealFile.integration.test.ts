import { open, readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createRaw4DGpuMemoryPlan } from '../../runtime/Raw4DGpuMemoryPlan';
import { readFourCgsManifest } from '../fourcgs/FourCgsContainer';
import { encodeRaw4DV26BrowserMemory } from '../fourcgs/FourCgsV26BrowserEncoder';
import { measureRaw4DAssetBytes } from './Raw4DMemoryMetrics';
import { parseRaw4D } from './Raw4DParser';
import type { Raw4DSource } from './Raw4DTypes';

const sourcePath = process.env.RAW4D_TEST_FILE;
const realFourCgsIt = sourcePath && process.env.RUN_REAL_4CGS_MEMORY === '1' ? it : it.skip;

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

  // #WDD-gpt 2026-08-18 - 手动真实文件验收覆盖 PLY4 Float32 Canonical RAM 到 V2.6 FP16 工作副本、容器写盘和清单回读。
  realFourCgsIt('encodes the real Canonical RAM snapshot as a readable 4CGS container', async () => {
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
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith('file:') && url.endsWith('.wasm')) {
        return new Response(await readFile(fileURLToPath(url)), { headers: { 'content-type': 'application/wasm' } });
      }
      return nativeFetch(input, init);
    });
    try {
      const asset = await parseRaw4D(source, { sourceName: sourcePath!, chunkRows: 16_384 });
      const started = performance.now();
      const result = await encodeRaw4DV26BrowserMemory([{
        name: sourcePath!.split('/').at(-1)!,
        asset,
        deletionWords: new Uint32Array(Math.ceil(asset.splatCount / 32)),
      }]);
      const { manifest } = await readFourCgsManifest(result.blob);
      const raw4dExport = manifest.metadata?.raw4dExport as Record<string, unknown>;
      expect(manifest.format).toBe('4CGS');
      expect(manifest.segments[0].gaussianCount).toBe(asset.splatCount);
      expect(raw4dExport.sourceScalarEncodings).toEqual([asset.sourceEncoding]);
      expect(raw4dExport.encodedScalarEncoding).toBe('float16');
      if (process.env.RAW4D_REAL_4CGS_OUTPUT) {
        await writeFile(process.env.RAW4D_REAL_4CGS_OUTPUT, Buffer.from(await result.blob.arrayBuffer()));
      }
      process.stdout.write(`${JSON.stringify({
        sourceEncoding: asset.sourceEncoding,
        sourceBytes: result.sourceBytes,
        outputBytes: result.outputBytes,
        compressionRatio: result.compressionRatio,
        elapsedSeconds: (performance.now() - started) / 1000,
        codecName: manifest.codecName,
      })}\n`);
    } finally {
      vi.unstubAllGlobals();
      await handle.close();
    }
  }, 600_000);
});
