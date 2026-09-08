import { describe, expect, it, vi } from 'vitest';
import { strToU8, unzipSync, zipSync } from 'fflate';
import {
  FourCgsRaw4DZipWriter,
  extractRaw4DFilesFromFourCgsZip,
  isFourCgsRaw4DZip,
} from './FourCgsRaw4DZip';

function archive(entries: Record<string, Uint8Array>, level: 0 | 6 = 6): File {
  return new File([zipSync(entries, { level }).slice().buffer as ArrayBuffer], 'scene.4cgs');
}

describe('4CGS RAW4D ZIP container', () => {
  it('detects ZIP signatures without confusing the legacy binary 4CGS header', async () => {
    expect(await isFourCgsRaw4DZip(archive({
      'a.raw4d': strToU8('a'),
      'b.raw4d': strToU8('b'),
    }))).toBe(true);
    expect(await isFourCgsRaw4DZip(new File([
      strToU8('4CGSPRS2').slice().buffer as ArrayBuffer,
    ], 'legacy.4cgs'))).toBe(false);
  });

  it.each([0, 6] as const)('extracts ordered RAW4D files at ZIP level %i and ignores metadata', async (level) => {
    const progress = vi.fn();
    const files = await extractRaw4DFilesFromFourCgsZip(archive({
      'segments/segment_0_30.raw4d': strToU8('first'),
      '4cgs-manifest.json': strToU8('{"version":1}'),
      'segments/segment_30_60.raw4d': strToU8('second'),
    }, level), { onProgress: progress });

    expect(files.map((file) => file.name)).toEqual([
      'segment_0_30.raw4d',
      'segment_30_60.raw4d',
    ]);
    expect(await Promise.all(files.map((file) => file.text()))).toEqual(['first', 'second']);
    expect(progress).toHaveBeenCalled();
    expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({
      completedSegments: 2,
      discoveredSegments: 2,
      ratio: 1,
    });
  });

  it('rejects archives with fewer than two RAW4D segments', async () => {
    await expect(extractRaw4DFilesFromFourCgsZip(archive({
      'segment_0_30.raw4d': strToU8('only'),
    }))).rejects.toThrow('至少需要包含两个');
  });

  it('rejects duplicate RAW4D basenames from different folders', async () => {
    await expect(extractRaw4DFilesFromFourCgsZip(archive({
      'first/segment.raw4d': strToU8('a'),
      'second/segment.raw4d': strToU8('b'),
    }))).rejects.toThrow('重复的 RAW4D 文件名');
  });

  it('streams a standards-compatible stored ZIP without accumulating one output Blob', async () => {
    const chunks: Uint8Array[] = [];
    const writer = new FourCgsRaw4DZipWriter(async (chunk) => {
      chunks.push(chunk.slice());
    });
    await writer.addRaw4D('segment_0_30.raw4d', new Blob([strToU8('first').slice().buffer as ArrayBuffer]));
    await writer.addRaw4D('segment_30_60.raw4d', new Blob([strToU8('second').slice().buffer as ArrayBuffer]));
    const result = await writer.close();
    const archiveBytes = new Uint8Array(result.outputBytes);
    let offset = 0;
    for (const chunk of chunks) {
      archiveBytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const files = unzipSync(archiveBytes);

    expect(result.fileCount).toBe(2);
    expect(Object.keys(files)).toEqual(['segment_0_30.raw4d', 'segment_30_60.raw4d']);
    expect(new TextDecoder().decode(files['segment_0_30.raw4d'])).toBe('first');
    expect(new TextDecoder().decode(files['segment_30_60.raw4d'])).toBe('second');
  });
});
