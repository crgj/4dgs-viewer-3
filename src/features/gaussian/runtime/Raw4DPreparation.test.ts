// #WDD-gpt 2026-09-20 - 验证 Worker 纹理布局、负数 SH、FP16 无穷与奇数点对齐，避免线程迁移改变画面。
import { describe, expect, it } from 'vitest';
import { FloatPacking } from 'playcanvas';
import { prepareRaw4D } from './Raw4DPreparation';
import type { Raw4DAsset, Raw4DTrack } from '../formats/raw4d/Raw4DTypes';
const track = (values: number[][], components: number): Raw4DTrack => ({ encoding: 'float32', components, keyframes: Array.from({ length: values.length / components }, (_, i) => i), values: values.map((column) => new Float32Array(column)) });
const f16 = FloatPacking.float2Half;
describe('background RAW4D preparation', () => {
  it('packs point-major temporal vectors with rotation component order preserved', () => {
    const source = track([[1, 2], [3, 4], [5, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16]], 4);
    const { data } = prepareRaw4D({ kind: 'track', track: source, components: [1, 2, 3, 0], half: false, layout: 'vector', preserveHalf: false });
    expect([...data]).toEqual([3, 5, 7, 1, 11, 13, 15, 9, 4, 6, 8, 2, 12, 14, 16, 10]);
  });
  it('retains IEEE half bits and pads odd scalar uploads for WebGPU alignment', () => {
    const { data } = prepareRaw4D({ kind: 'track', track: { encoding: 'float16', components: 1, keyframes: [0], values: [new Uint16Array([0xfc00, 0x8000, 0x7e01])] }, components: [0], half: true, layout: 'scalar', preserveHalf: true });
    expect([...data]).toEqual([0xfc00, 0x8000, 0x7e01, 0]);
    expect(data.byteLength % 4).toBe(0);
  });
  it('keeps opacity banks grouped per point and unused channels at minus twenty', () => {
    const { data } = prepareRaw4D({ kind: 'track', track: track([[-Infinity, 0], [1, 2], [3, 4], [5, 6], [7, 8]], 1), components: [0], half: true, layout: 'opacity', preserveHalf: false });
    expect([...data]).toEqual([-Infinity, 1, 3, 5, 7, -20, -20, -20, 0, 2, 4, 6, 8, -20, -20, -20].map(f16));
  });
  it('preserves frame-zero transforms, baked opacity and the negative SH maximum', () => {
    const asset: Raw4DAsset = { sourceName: 'fixture', sourceEncoding: 'float32', splatCount: 1, totalFrames: 1, shBands: 1,
      position: track([[1], [2], [3]], 3), rotation: track([[1], [0], [0], [0]], 4), scale: track([[0], [Math.log(2)], [0]], 3),
      colorDc: track([[0], [0], [0]], 3), opacity: track([[0]], 1), opacityTiming: 'baked', shRest: Array.from({ length: 9 }, (_, i) => new Float32Array([i === 0 ? -0.75 : 0])),
      lifetimeMu: new Float32Array([0]), lifetimeW: new Float32Array([0]), bounds: { min: [0, 0, 0], max: [3, 3, 3] } };
    const result = prepareRaw4D({ kind: 'resource', asset, shBands: 1 });
    expect([...result.splatColor]).toEqual([0.5, 0.5, 0.5, 0.5].map(f16));
    expect([...new Float32Array(result.transformA.buffer).slice(0, 3)]).toEqual([1, 2, 3]);
    expect([...result.transformB]).toEqual([1, 2, 1, 0].map(f16));
    expect(new Float32Array(result.splatSH_1to3.buffer)[0]).toBe(0.75);
    expect(result.splatSH_1to3[1] >>> 21).toBe(0);
  });
});

// #WDD-gpt 2026-09-20 - 穷举所有 FP16 位模式验证纹理 round-trip；有限位置从 FP32 纹理切回 FP16 数值完全相同。
it('preserves every finite FP16 position and original texture round-trip', () => {
  const bits = Uint16Array.from({ length: 65536 }, (_, i) => i);
  const source: Raw4DTrack = { encoding: 'float16', components: 1, keyframes: [0], values: [bits] };
  const floats = prepareRaw4D({ kind: 'track', track: source, components: [0], half: false, layout: 'scalar', preserveHalf: false }).data;
  const halves = prepareRaw4D({ kind: 'track', track: source, components: [0], half: true, layout: 'scalar', preserveHalf: false }).data;
  const expected = Uint16Array.from(floats, FloatPacking.float2Half);
  expect(halves).toEqual(expected);
  for (let i = 0; i < bits.length; i++) if (Number.isFinite(floats[i])) expect(halves[i]).toBe(bits[i]);
});
