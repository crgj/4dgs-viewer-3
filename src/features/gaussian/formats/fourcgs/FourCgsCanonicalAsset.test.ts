// #WDD-gpt 2026-09-20 - 直接 Canonical RAM 与完整 PLY 导入逐位一致，覆盖边界 FP16 和数值校验失败。
import { expect, it } from 'vitest';
import { FloatPacking } from 'playcanvas';
import { createFourCgsCanonicalAsset } from './FourCgsCanonicalAsset';
import { createFourCgsCanonicalRaw4D, fourCgsDecodedPropertyNames } from './FourCgsRaw4D';
import { parseRaw4D } from '../raw4d/Raw4DParser';
import type { FourCgsSegment } from './FourCgsTypes';
const segment = { name: 'direct', gaussianCount: 3, totalFrames: 11, firstFrame: 0, lastFrame: 10, shBands: 3,
  bankCounts: { position: 2, rotation: 2, colorDc: 2, scale: 2, opacity: 2 }, frameRate: 30,
  opacityTiming: 'baked', positionTiming: 'per-point-lifetime-endpoints',
} as FourCgsSegment;
const names = fourCgsDecodedPropertyNames(segment);
function fixture() {
  return Uint16Array.from({ length: names.length * 3 }, (_, i) => {
    const name = names[i % names.length];
    return FloatPacking.float2Half(name.startsWith('rot_bank') ? (name.endsWith('_w') ? 1 : 0)
      : name.startsWith('opacity_bank') ? -Infinity : name === 'lifetime_w' ? -.0001 : (i % 17 - 8) / 10);
  });
}
it('matches the existing file path for every track, SH value, bound and timing', async () => {
  const rows = fixture();
  const expected = await parseRaw4D(new Blob([createFourCgsCanonicalRaw4D(segment, names, rows) as Uint8Array<ArrayBuffer>]), { sourceName: 'direct.raw4d' });
  for (const shared of [false, true]) {
    const actual = createFourCgsCanonicalAsset(segment, names, rows, shared);
    expect(actual).toEqual(expected);
    expect(actual.position.values[0].buffer instanceof SharedArrayBuffer).toBe(shared);
  }
});
it('rejects invalid quaternions, lifetimes, opacity and insufficient RAM', () => {
  for (const [name, value] of [['rot_bank_0_w', 0], ['lifetime_mu', Infinity], ['opacity_bank_0', NaN]] as const) {
    const rows = fixture(); rows[names.indexOf(name)] = FloatPacking.float2Half(value);
    expect(() => createFourCgsCanonicalAsset(segment, names, rows)).toThrow();
  }
  expect(() => createFourCgsCanonicalAsset(segment, names, fixture(), false, 1)).toThrow('budget exceeded');
});
