import { describe, expect, it } from 'vitest';
import { normalizeMemoryPressureOptions } from './BrowserMemoryPressureTest';

describe('browser memory pressure test', () => {
  it('clamps unsafe targets and chunk sizes to bounded values', () => {
    expect(normalizeMemoryPressureOptions(1, 1)).toEqual({
      targetBytes: 64 * 1024 ** 2,
      chunkBytes: 16 * 1024 ** 2,
    });
    expect(normalizeMemoryPressureOptions(64 * 1024 ** 3, 1024 ** 3)).toEqual({
      targetBytes: 32 * 1024 ** 3,
      chunkBytes: 256 * 1024 ** 2,
    });
  });
});
