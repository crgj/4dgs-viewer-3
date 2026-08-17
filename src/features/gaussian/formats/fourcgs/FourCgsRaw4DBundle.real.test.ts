import { File as NodeFile } from 'node:buffer';
import { openAsBlob } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { unzlibSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { FOUR_CGS_HEADER_BYTES, readFourCgsManifest } from './FourCgsContainer';
import { raw4DBundleMetadata, unshuffle16 } from './FourCgsRaw4DBundle';
import { encodeRaw4DBundle } from './fourcgs-encoder.worker';
import { encodeRaw4DV26Browser } from './FourCgsV26BrowserEncoder';
import { readRaw4DHeader } from '../raw4d/Raw4DParser';

const realDirectory = process.env.RAW4D_REAL_DIR;
const realIt = realDirectory && process.env.RUN_REAL_4CGS_BUNDLE === '1' ? it : it.skip;
const adaptiveIt = realDirectory && process.env.RUN_REAL_4CGS_ADAPTIVE === '1' ? it : it.skip;

describe('RAW4D dynamic browser encoder real files', () => {
  realIt('encodes the selected files and restores every original byte hash', async () => {
    const names = (await readdir(realDirectory!)).filter((name) => /\.(?:raw4d|ply4)$/i.test(name)).sort();
    const files: globalThis.File[] = await Promise.all(names.map(async (name) => new NodeFile([
      await openAsBlob(join(realDirectory!, name)),
    ], name) as unknown as globalThis.File));
    const started = performance.now();
    const result = await encodeRaw4DBundle(files);
    const { manifest, manifestBytes } = await readFourCgsManifest(result.blob);
    const bundle = raw4DBundleMetadata(manifest)!;
    let streamOffset = FOUR_CGS_HEADER_BYTES + manifestBytes;
    const hashers = manifest.segments.map(() => sha256.create());
    const restoredLengths = new Array<number>(manifest.segments.length).fill(0);
    for (const stream of manifest.streams) {
      const match = /^raw4d_segment:(\d+):(\d+)$/.exec(stream.name);
      expect(match).not.toBeNull();
      const segmentIndex = Number(match![1]);
      const stored = new Uint8Array(await result.blob.slice(streamOffset, streamOffset + stream.storedBytes).arrayBuffer());
      streamOffset += stream.storedBytes;
      const restored = unshuffle16(unzlibSync(stored));
      const remaining = bundle.sourceByteLengths[segmentIndex] - restoredLengths[segmentIndex];
      const source = restored.subarray(0, Math.min(bundle.chunkBytes, remaining));
      hashers[segmentIndex].update(source);
      restoredLengths[segmentIndex] += source.byteLength;
    }
    expect(restoredLengths).toEqual(bundle.sourceByteLengths);
    expect(hashers.map((hasher) => bytesToHex(hasher.digest()))).toEqual(bundle.sourceSha256);
    expect(streamOffset).toBe(result.blob.size);
    expect(result.sourceBytes).toBe(files.reduce((sum, file) => sum + file.size, 0));
    console.info(JSON.stringify({
      sourceBytes: result.sourceBytes,
      outputBytes: result.outputBytes,
      compressionRatio: result.compressionRatio,
      elapsedSeconds: (performance.now() - started) / 1000,
      segmentCount: files.length,
    }));
  }, 240_000);

  adaptiveIt('encodes arbitrary current inputs with adaptive quality templates', async () => {
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith('file:') && url.endsWith('.wasm')) {
        return new Response(await readFile(fileURLToPath(url)), { headers: { 'content-type': 'application/wasm' } });
      }
      return nativeFetch(input, init);
    });
    try {
      const names = (await readdir(realDirectory!)).filter((name) => /\.(?:raw4d|ply4)$/i.test(name)).sort();
      const files: globalThis.File[] = await Promise.all(names.map(async (name) => new NodeFile([
        await openAsBlob(join(realDirectory!, name)),
      ], name) as unknown as globalThis.File));
      const started = performance.now();
      const result = await encodeRaw4DV26Browser(
        files,
        await Promise.all(files.map(async (file) => new Uint32Array(Math.ceil((await readRaw4DHeader(file)).vertexCount / 32)))),
      );
      const { manifest } = await readFourCgsManifest(result.blob);
      const policy = manifest.compressionV26 as Record<string, any>;
      expect(manifest.codecName).toContain('AdaptivePQ');
      expect(policy.sourceProfileSha256).toBeUndefined();
      expect(policy.qualityGate.status).toBe('numeric-passed');
      expect(policy.shPolicy.measuredRmse).toBeLessThanOrEqual(0.0130001);
      expect(policy.shPolicy.maximumCoefficientError).toBeLessThanOrEqual(0.0500001);
      if (process.env.RAW4D_ADAPTIVE_OUTPUT) {
        await writeFile(process.env.RAW4D_ADAPTIVE_OUTPUT, Buffer.from(await result.blob.arrayBuffer()));
      }
      console.info(JSON.stringify({
        sourceBytes: result.sourceBytes,
        outputBytes: result.outputBytes,
        compressionRatio: result.compressionRatio,
        elapsedSeconds: (performance.now() - started) / 1000,
        segmentCount: files.length,
        shPolicy: policy.shPolicy,
      }));
    } finally {
      vi.unstubAllGlobals();
    }
  }, 600_000);
});
