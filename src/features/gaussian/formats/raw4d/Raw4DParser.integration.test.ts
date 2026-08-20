/// <reference types="node" />

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseRaw4D, readRaw4DHeader } from './Raw4DParser';
import { exportCompactedRaw4DSource } from './Raw4DExporter';
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
    expect(source.size).toBe(header.dataOffset + header.payloadBytes);
    expect(asset.sourceEncoding).toBe('float16');
    expect(asset.splatCount).toBe(header.pointCount);
    expect(asset.totalFrames).toBe(header.totalFrames);
    expect(asset.shBands).toBe(3);
    expect(asset.position.keyframes).toHaveLength(11);
    expect([...asset.bounds.min, ...asset.bounds.max].every(Number.isFinite)).toBe(true);
    const staticElement = header.elements.find((element) => element.name === 'vertex_static');
    if (staticElement) {
      expect(header.vertexCount).toBe(88_287);
      expect(staticElement.count).toBe(24_712);
      expect(asset.temporalLayout?.pointGroups[1].trackKeyframes.position).toEqual([0, header.totalFrames - 1]);
      const firstStatic = header.vertexCount;
      const lastPositionOffset = (asset.position.keyframes.length - 1) * asset.position.components;
      for (let component = 0; component < asset.position.components; component += 1) {
        // #WDD-gpt 2026-08-19 - 静态 element 只读一份源值，但统一时间轨道的首尾端点必须保持逐位相等。
        expect(asset.position.values[component][firstStatic]).toBe(
          asset.position.values[lastPositionOffset + component][firstStatic],
        );
      }
      const deletionWords = new Uint32Array(Math.ceil(header.pointCount / 32));
      deletionWords[0] |= 1;
      deletionWords[header.vertexCount >>> 5] |= 1 << (header.vertexCount & 31);
      const compacted = await exportCompactedRaw4DSource(source, deletionWords);
      const compactedHeader = await readRaw4DHeader(compacted);
      expect(compactedHeader.vertexCount).toBe(header.vertexCount - 1);
      expect(compactedHeader.elements.find((element) => element.name === 'vertex_static')?.count)
        .toBe(staticElement.count - 1);
      expect(compacted.size).toBe(compactedHeader.dataOffset + compactedHeader.payloadBytes);
    }
  }, 60_000);
});
