import { FloatPacking } from 'playcanvas';
import { describe, expect, it } from 'vitest';
import { makeStaticAsset } from '../../features/gaussian/formats/import/GaussianImportUtils';
import { findCompletelyInvisibleStableIds, inspectGaussianModel } from './ModelHealth';

describe('model health', () => {
  it('reports and safely repairs invalid values without changing point count', () => {
    const array = (values: number[]) => new Float32Array(values);
    const asset = makeStaticAsset({
      sourceName: 'bad.ply',
      position: [array([0, Number.NaN]), array([0, 1]), array([0, 1])],
      rotation: [array([2, 0]), array([0, 0]), array([0, 0]), array([0, 0])],
      colorDc: [array([0, 0]), array([0, 0]), array([0, 0])],
      scale: [array([100, 0]), array([0, 0]), array([0, 0])],
      opacity: array([100, 0]),
      shRest: [],
    });
    const before = inspectGaussianModel(asset);
    expect(before.healthy).toBe(false);

    const repaired = inspectGaussianModel(asset, true);
    expect(repaired.fixedValues).toBeGreaterThan(0);
    expect(asset.splatCount).toBe(2);
    expect(inspectGaussianModel(asset).healthy).toBe(true);
  });

  it('keeps a point which is invisible now but visible in another playback frame', () => {
    const asset = makeStaticAsset({
      sourceName: 'animated.ply',
      position: [new Float32Array(2), new Float32Array(2), new Float32Array(2)],
      rotation: [new Float32Array([1, 1]), new Float32Array(2), new Float32Array(2), new Float32Array(2)],
      colorDc: [new Float32Array(2), new Float32Array(2), new Float32Array(2)],
      scale: [new Float32Array(2), new Float32Array(2), new Float32Array(2)],
      opacity: new Float32Array([-20, -20]),
      shRest: [],
    });
    const firstOpacity = new Float32Array([-20, -20]);
    const lastOpacity = new Float32Array([4, -20]);
    (asset as unknown as { totalFrames: number }).totalFrames = 5;
    (asset as unknown as { opacity: typeof asset.opacity }).opacity = {
      encoding: 'float32', components: 1, keyframes: [0, 4], values: [firstOpacity, lastOpacity],
    };
    asset.lifetimeMu.fill(2);
    asset.lifetimeW.fill(3);

    expect(findCompletelyInvisibleStableIds(asset)).toEqual([1]);
  });

  it('checks non-key playback frames before declaring a point completely invisible', () => {
    const asset = makeStaticAsset({
      sourceName: 'lifetime-window.ply',
      position: [new Float32Array(2), new Float32Array(2), new Float32Array(2)],
      rotation: [new Float32Array([1, 1]), new Float32Array(2), new Float32Array(2), new Float32Array(2)],
      colorDc: [new Float32Array(2), new Float32Array(2), new Float32Array(2)],
      scale: [new Float32Array(2), new Float32Array(2), new Float32Array(2)],
      opacity: new Float32Array([0, -6]),
      shRest: [],
    });
    (asset as unknown as { totalFrames: number }).totalFrames = 5;
    asset.lifetimeMu.set([2, 2]);
    asset.lifetimeW.set([0.1, 5]);

    expect(findCompletelyInvisibleStableIds(asset)).toEqual([1]);
  });

  it('does not use invalid opacity or lifetime data as deletion evidence', () => {
    const asset = makeStaticAsset({
      sourceName: 'uncertain.ply',
      position: [new Float32Array(3), new Float32Array(3), new Float32Array(3)],
      rotation: [new Float32Array([1, 1, 1]), new Float32Array(3), new Float32Array(3), new Float32Array(3)],
      colorDc: [new Float32Array(3), new Float32Array(3), new Float32Array(3)],
      scale: [new Float32Array(3), new Float32Array(3), new Float32Array(3)],
      opacity: new Float32Array([Number.NaN, -20, -20]),
      shRest: [],
    });
    asset.lifetimeW[1] = Number.NaN;

    expect(findCompletelyInvisibleStableIds(asset)).toEqual([2]);
  });

  it('repairs positive infinite opacity without making an opaque point disappear', () => {
    const asset = makeStaticAsset({
      sourceName: 'infinite-opacity.ply',
      position: [new Float32Array(1), new Float32Array(1), new Float32Array(1)],
      rotation: [new Float32Array([1]), new Float32Array(1), new Float32Array(1), new Float32Array(1)],
      colorDc: [new Float32Array(1), new Float32Array(1), new Float32Array(1)],
      scale: [new Float32Array(1), new Float32Array(1), new Float32Array(1)],
      opacity: new Float32Array([Number.POSITIVE_INFINITY]),
      shRest: [],
    });

    expect(findCompletelyInvisibleStableIds(asset)).toEqual([]);
    inspectGaussianModel(asset, true, { includeVisibility: false });
    expect(asset.opacity.values[0][0]).toBe(20);
    expect(findCompletelyInvisibleStableIds(asset)).toEqual([]);
  });

  it('repairs unknown opacity to a visible neutral value instead of creating a delete candidate', () => {
    const asset = makeStaticAsset({
      sourceName: 'unknown-opacity.ply',
      position: [new Float32Array(1), new Float32Array(1), new Float32Array(1)],
      rotation: [new Float32Array([1]), new Float32Array(1), new Float32Array(1), new Float32Array(1)],
      colorDc: [new Float32Array(1), new Float32Array(1), new Float32Array(1)],
      scale: [new Float32Array(1), new Float32Array(1), new Float32Array(1)],
      opacity: new Float32Array([Number.NaN]),
      shRest: [],
    });

    inspectGaussianModel(asset, true, { includeVisibility: false });
    expect(asset.opacity.values[0][0]).toBe(0);
    expect(findCompletelyInvisibleStableIds(asset)).toEqual([]);
  });

  it('rebuilds bounds from decoded FP16 positions across every animation keyframe', () => {
    const asset = makeStaticAsset({
      sourceName: 'animated-fp16.raw4d',
      position: [new Float32Array(1), new Float32Array(1), new Float32Array(1)],
      rotation: [new Float32Array([1]), new Float32Array(1), new Float32Array(1), new Float32Array(1)],
      colorDc: [new Float32Array(1), new Float32Array(1), new Float32Array(1)],
      scale: [new Float32Array(1), new Float32Array(1), new Float32Array(1)],
      opacity: new Float32Array([0]),
      shRest: [],
    });
    const half = (value: number) => new Uint16Array([FloatPacking.float2Half(value)]);
    (asset as unknown as { totalFrames: number }).totalFrames = 2;
    (asset as unknown as { position: typeof asset.position }).position = {
      encoding: 'float16',
      components: 3,
      keyframes: [0, 1],
      values: [half(0), half(1), half(2), half(100), half(-3), half(8)],
    };

    inspectGaussianModel(asset, true, { includeVisibility: false });

    expect(asset.bounds.min).toEqual([0, -3, 2]);
    expect(asset.bounds.max).toEqual([100, 1, 8]);
  });
});
