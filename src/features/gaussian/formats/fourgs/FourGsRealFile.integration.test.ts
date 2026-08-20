import { existsSync, openAsBlob } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { readFourCgsManifest } from '../fourcgs/FourCgsContainer';
import { encodeRaw4DV26BrowserMemory } from '../fourcgs/FourCgsV26BrowserEncoder';
import { measureRaw4DAssetBytes } from '../raw4d/Raw4DMemoryMetrics';
import { parseFourGs, readFourGsHeader } from './FourGsParser';

const REAL_FILE = '/home/crgj/wdd/data/Row4D/4gs/scene.4gs';
const realFourCgsIt = process.env.RUN_FOURGS_4CGS_REAL === '1' ? it : it.skip;

describe.runIf(existsSync(REAL_FILE))('real integrated 4GS file', () => {
  it('streams the real file into one canonical asset without retaining the AoS payload', async () => {
    const source = await openAsBlob(REAL_FILE);
    const header = await readFourGsHeader(source);
    expect(header).toMatchObject({ version: 3, vertexCount: 908_268, frameCount: 30, shBands: 2, dataOffset: 1424, opacityThreshold: 0.005 });
    const asset = await parseFourGs(source, { sourceName: 'scene.4gs', chunkRows: 16_384 });
    expect(asset.splatCount).toBe(908_268);
    expect(asset.totalFrames).toBe(30);
    expect(asset.position.keyframes).toEqual([0, 29]);
    expect(asset.opacity.keyframes).toHaveLength(30);
    expect(asset.shRest).toHaveLength(24);
    expect(asset.positionTiming).toBe('per-point-lifetime-endpoints');
    expect(asset.opacityTiming).toBe('baked');
    expect(measureRaw4DAssetBytes(asset)).toBe(261_581_184);
    const diagnostics = (header.metadata?.temporal_diagnostics as Record<string, unknown>)?.opacity as Record<string, unknown>;
    const expectedCounts = (diagnostics.per_frame_active as Array<{ count: number }>).map((entry) => entry.count);
    const actualCounts = asset.opacity.values.map((values) => {
      let active = 0;
      for (const value of values as Float32Array) if (value > -65_504) active += 1;
      return active;
    });
    expect(actualCounts).toEqual(expectedCounts);

    // #WDD-gpt 2026-08-20 - 独立从真实 AoS 记录重算逐点生命周期端点，防止“能读”但速度单位、中心帧或端点时间解释错误。
    const propertyIndex = new Map(header.propertyNames.map((name, index) => [name, index]));
    const readOriginalRow = async (stableId: number) => {
      const bytes = await source.slice(
        header.dataOffset + stableId * header.recordBytes,
        header.dataOffset + (stableId + 1) * header.recordBytes,
      ).arrayBuffer();
      const view = new DataView(bytes);
      return (name: string) => view.getFloat32(propertyIndex.get(name)! * 4, true);
    };
    for (const stableId of [0, 123_456, 456_789, header.vertexCount - 1]) {
      const read = await readOriginalRow(stableId);
      const center = read('frame_center');
      const sigma = read('sigma_frames');
      const radius = read('radius_frames');
      const opacity = read('opacity');
      const logBaseAlpha = opacity >= 0
        ? -Math.log1p(Math.exp(-opacity))
        : opacity - Math.log1p(Math.exp(opacity));
      const support = logBaseAlpha < Math.log(header.opacityThreshold)
        ? 0
        : radius + sigma * Math.sqrt(Math.max(0, logBaseAlpha - Math.log(header.opacityThreshold)));
      const start = Math.max(header.firstFrame, Math.min(header.lastFrame, center - support));
      const end = Math.max(header.firstFrame, Math.min(header.lastFrame, center + support));
      expect((asset.lifetimeMu as Float32Array)[stableId]).toBeCloseTo((start + end) / 2 - header.firstFrame, 4);
      expect((asset.lifetimeW as Float32Array)[stableId]).toBeCloseTo((end - start) / 2, 4);
      for (let axis = 0; axis < 3; axis += 1) {
        const base = read(['x', 'y', 'z'][axis]);
        const velocity = read(`velocity_per_frame_${axis}`);
        expect((asset.position.values[axis] as Float32Array)[stableId]).toBeCloseTo(base + velocity * (start - center), 4);
        expect((asset.position.values[3 + axis] as Float32Array)[stableId]).toBeCloseTo(base + velocity * (end - center), 4);
      }
    }
    let maximumEndpointMagnitude = 0;
    for (const values of asset.position.values as readonly Float32Array[]) {
      for (const value of values) maximumEndpointMagnitude = Math.max(maximumEndpointMagnitude, Math.abs(value));
    }
    expect(maximumEndpointMagnitude).toBeLessThan(20);
  }, 120_000);

  // #WDD-gpt 2026-08-20 - 手动真实验收覆盖 SH2 补零工作副本、逐点位置端点时序和烘焙透明度进入同一 4CGS V2.6 容器。
  realFourCgsIt('exports the real 4GS canonical asset to a readable 4CGS container', async () => {
    const source = await openAsBlob(REAL_FILE);
    const asset = await parseFourGs(source, { sourceName: 'scene.4gs', chunkRows: 16_384 });
    const sourcePosition = (asset.position.values[0] as Float32Array)[123_456];
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith('file:') && url.endsWith('.wasm')) {
        return new Response(await readFile(fileURLToPath(url)), { headers: { 'content-type': 'application/wasm' } });
      }
      return nativeFetch(input, init);
    });
    const started = performance.now();
    try {
      const result = await encodeRaw4DV26BrowserMemory([{
        name: 'scene.4gs', asset,
        deletionWords: new Uint32Array(Math.ceil(asset.splatCount / 32)),
      }]);
      const { manifest } = await readFourCgsManifest(result.blob);
      const segment = manifest.segments[0];
      const raw4dExport = manifest.metadata?.raw4dExport as Record<string, unknown>;
      expect(segment).toMatchObject({
        totalFrames: 30, frameRate: 30,
        positionTiming: 'per-point-lifetime-endpoints', opacityTiming: 'baked',
      });
      expect(segment.bankCounts.position).toBe(2);
      expect(segment.bankCounts.opacity).toBe(30);
      expect(raw4dExport.sourceShBands).toEqual([2]);
      expect(raw4dExport.sourceScalarEncodings).toEqual(['float32']);
      expect((asset.position.values[0] as Float32Array)[123_456]).toBe(sourcePosition);
      if (process.env.FOURGS_REAL_4CGS_OUTPUT) {
        await writeFile(process.env.FOURGS_REAL_4CGS_OUTPUT, Buffer.from(await result.blob.arrayBuffer()));
      }
      process.stdout.write(`${JSON.stringify({
        sourceBytes: source.size,
        canonicalBytes: measureRaw4DAssetBytes(asset),
        outputBytes: result.outputBytes,
        compressionRatio: result.compressionRatio,
        elapsedSeconds: (performance.now() - started) / 1_000,
      })}\n`);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 600_000);
});
