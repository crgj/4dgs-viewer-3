import { describe, expect, it } from 'vitest';
import { fourCgsUnorderedHalf, planFourCgsExportGpuChunks } from './FourCgsExportGpu';

function orderedHalf(bits: number): number {
  return bits & 0x8000 ? (~bits) & 0xffff : bits ^ 0x8000;
}

describe('4CGS export WebGPU helpers', () => {
  // #WDD-gpt 2026-09-20 - GPU 原子 min/max 使用可排序 FP16 位模式；必须覆盖负零、正零、有限极值并可无损还原。
  it('round-trips finite ordered FP16 bit patterns', () => {
    const finiteBits = [0xfbff, 0xbc00, 0x8000, 0x0000, 0x3c00, 0x7bff];
    expect(finiteBits.map((bits) => fourCgsUnorderedHalf(orderedHalf(bits)))).toEqual(finiteBits);
    expect(finiteBits.map(orderedHalf)).toEqual([...finiteBits.map(orderedHalf)].sort((a, b) => a - b));
  });

  // #WDD-gpt 2026-09-20 - 超大导出分块必须连续覆盖、4 字节对齐，并同时满足 source/output/dispatch 上限。
  it('plans bounded crop and alpha chunks for multi-gigabyte assets', () => {
    const chunks = planFourCgsExportGpuChunks(40_000_007, 118, 4, 64 * 1024 * 1024, 65_535);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].firstPoint).toBe(0);
    expect(chunks.at(-1)!.firstPoint + chunks.at(-1)!.pointCount).toBe(40_000_007);
    chunks.forEach((chunk, index) => {
      expect(chunk.sourceBytes % 4).toBe(0);
      expect(chunk.outputBytes % 4).toBe(0);
      expect(chunk.sourceBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
      expect(chunk.outputBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
      expect(Math.ceil(chunk.pointCount / 256)).toBeLessThanOrEqual(65_535);
      if (index > 0) expect(chunk.firstPoint).toBe(chunks[index - 1].firstPoint + chunks[index - 1].pointCount);
    });
  });
});
