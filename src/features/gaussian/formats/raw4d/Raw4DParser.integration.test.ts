/// <reference types="node" />

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseRaw4D, readRaw4DHeader } from './Raw4DParser';
import { Raw4DWasmExtractor } from './Raw4DWasmExtractor';

const fixturePath = process.env.RAW4D_FIXTURE_PATH;
const fixtureTest = fixturePath ? it : it.skip;

describe('RAW4D real-file integration', () => {
  // #WDD-gpt  2026-08-15 - 通过环境变量对真实大文件做验收，默认测试不依赖工作区外的数据目录。
  fixtureTest('fully parses a collected fp16 segment', async () => {
    const bytes = await readFile(fixturePath!);
    const exactBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const source = new Blob([exactBuffer]);
    const header = await readRaw4DHeader(source);
    const extractor = await Raw4DWasmExtractor.create();
    const asset = await parseRaw4D(source, {
      sourceName: fixturePath!.split('/').at(-1),
      extractChunk: extractor.extract,
    });

    expect(header.scalarEncoding).toBe('float16');
    expect(header.recordBytes).toBe(header.propertyNames.length * Uint16Array.BYTES_PER_ELEMENT);
    expect(source.size).toBe(header.dataOffset + header.vertexCount * header.recordBytes);
    expect(asset.sourceEncoding).toBe('float16');
    expect(asset.splatCount).toBe(header.vertexCount);
    expect(asset.totalFrames).toBe(header.totalFrames);
    expect(asset.shBands).toBe(3);
    expect(asset.position.keyframes).toHaveLength(11);
    expect([...asset.bounds.min, ...asset.bounds.max].every(Number.isFinite)).toBe(true);
  }, 60_000);
});
