import { describe, expect, it } from 'vitest';
import { raw4DShPackingMaximum } from './Raw4DResource';

describe('RAW4D resource packing', () => {
  // #WDD-gpt 2026-08-16 - 回归首个 SH 系数为绝对值最大负数时的归一化范围错误。
  it('uses the absolute value of the first SH coefficient', () => {
    expect(raw4DShPackingMaximum([-0.75, 0.25, -0.5])).toBe(0.75);
    expect(raw4DShPackingMaximum([0, 0, 0])).toBe(0);
  });
});
