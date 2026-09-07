/// <reference types="node" />

import { createHash } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { readRaw4DHeader } from './Raw4DParser';
import { exportRaw4DSegmentBatch } from './Raw4DSegmentExporter';
import type { Raw4DAsset, Raw4DSource } from './Raw4DTypes';

const sourcePaths = process.env.RAW4D_MULTI_EXPORT_FILES?.split(',').filter(Boolean) ?? [];

describe.skipIf(sourcePaths.length < 2)('RAW4D real multi-segment export', () => {
  it('writes every real source as a separate readable RAW4D without merging boundaries', async () => {
    const handles = [];
    try {
      const inputs = [];
      const sourceSizes: number[] = [];
      const sourceHashes: string[] = [];
      for (const [index, path] of sourcePaths.entries()) {
        const sourceStats = await stat(path);
        const handle = await open(path, 'r');
        handles.push(handle);
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
        const header = await readRaw4DHeader(source);
        const filename = path.split('/').at(-1)!;
        sourceSizes.push(sourceStats.size);
        sourceHashes.push(createHash('sha256').update(await readFile(path)).digest('hex'));
        inputs.push({
          asset: { sourceName: filename, splatCount: header.pointCount } as Raw4DAsset,
          deletionWords: new Uint32Array(Math.ceil(header.pointCount / 32)),
          filename,
          source,
          sourcePreserved: true,
        });
      }

      const written: { filename: string; hash: string; size: number; totalFrames: number }[] = [];
      const result = await exportRaw4DSegmentBatch(inputs, {
        writeSegment: async (file) => {
          const header = await readRaw4DHeader(file.blob);
          written.push({
            filename: file.filename,
            hash: createHash('sha256').update(new Uint8Array(await file.blob.arrayBuffer())).digest('hex'),
            size: file.blob.size,
            totalFrames: header.totalFrames,
          });
        },
      });

      expect(written.map((file) => file.filename)).toEqual(sourcePaths.map((path) => path.split('/').at(-1)!));
      expect(written.map((file) => file.size)).toEqual(sourceSizes);
      expect(written.map((file) => file.hash)).toEqual(sourceHashes);
      expect(written.every((file) => file.totalFrames > 1)).toBe(true);
      expect(result.fileCount).toBe(sourcePaths.length);
      expect(result.sourcePreservedCount).toBe(sourcePaths.length);
    } finally {
      await Promise.all(handles.map((handle) => handle.close()));
    }
  }, 120_000);
});
