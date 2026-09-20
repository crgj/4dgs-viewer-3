import { describe, expect, it } from 'vitest';
import { fourCgsUnorderedHalf } from './FourCgsExportGpu';

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
});
