import { FloatPacking } from 'playcanvas';
import { describe, expect, it } from 'vitest';
import { makeStaticAsset } from '../../features/gaussian/formats/import/GaussianImportUtils';
import { findCompletelyInvisibleStableIds, inspectGaussianModel, mergeModelHealthReports } from './ModelHealth';

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

  it('keeps every point with a finite opacity key even when it is below the render threshold', () => {
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

    expect(findCompletelyInvisibleStableIds(asset)).toEqual([]);
  });

  it('does not use a narrow lifetime window as deletion evidence', () => {
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

    expect(findCompletelyInvisibleStableIds(asset)).toEqual([]);
  });

  it('does not use invalid opacity or lifetime data as deletion evidence', () => {
    const asset = makeStaticAsset({
      sourceName: 'uncertain.ply',
      position: [new Float32Array(3), new Float32Array(3), new Float32Array(3)],
      rotation: [new Float32Array([1, 1, 1]), new Float32Array(3), new Float32Array(3), new Float32Array(3)],
      colorDc: [new Float32Array(3), new Float32Array(3), new Float32Array(3)],
      scale: [new Float32Array(3), new Float32Array(3), new Float32Array(3)],
      opacity: new Float32Array([Number.NaN, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]),
      shRest: [],
    });
    asset.lifetimeW[1] = Number.NaN;

    expect(findCompletelyInvisibleStableIds(asset)).toEqual([2]);
  });

  it('treats negative-infinity opacity as valid and preserves its exact value', () => {
    const asset = makeStaticAsset({
      sourceName: 'negative-infinity-opacity.ply',
      position: [new Float32Array(2), new Float32Array(2), new Float32Array(2)],
      rotation: [new Float32Array([1, 1]), new Float32Array(2), new Float32Array(2), new Float32Array(2)],
      colorDc: [new Float32Array(2), new Float32Array(2), new Float32Array(2)],
      scale: [new Float32Array(2), new Float32Array(2), new Float32Array(2)],
      opacity: new Float32Array([Number.NEGATIVE_INFINITY, 0]),
      shRest: [],
    });

    const inspected = inspectGaussianModel(asset, false, { includeVisibility: false });
    expect(inspected.issues.some((issue) => issue.code === 'nonfinite-opacity')).toBe(false);
    expect(inspected.issues.some((issue) => issue.code === 'opacity-range')).toBe(false);

    const repaired = inspectGaussianModel(asset, true, { includeVisibility: false });
    expect(repaired.fixedValues).toBe(0);
    expect(asset.opacity.values[0][0]).toBe(Number.NEGATIVE_INFINITY);
  });

  it('preserves the FP16 negative-infinity bit pattern and accepts it as exact zero alpha', () => {
    const asset = makeStaticAsset({
      sourceName: 'negative-infinity-opacity-fp16.raw4d',
      position: [new Float32Array(1), new Float32Array(1), new Float32Array(1)],
      rotation: [new Float32Array([1]), new Float32Array(1), new Float32Array(1), new Float32Array(1)],
      colorDc: [new Float32Array(1), new Float32Array(1), new Float32Array(1)],
      scale: [new Float32Array(1), new Float32Array(1), new Float32Array(1)],
      opacity: new Float32Array(1),
      shRest: [],
    });
    const negativeInfinityBits = FloatPacking.float2Half(Number.NEGATIVE_INFINITY);
    (asset as unknown as { opacity: typeof asset.opacity }).opacity = {
      encoding: 'float16',
      components: 1,
      keyframes: [0],
      values: [new Uint16Array([negativeInfinityBits])],
    };

    expect(findCompletelyInvisibleStableIds(asset)).toEqual([0]);
    inspectGaussianModel(asset, true, { includeVisibility: false });
    expect(asset.opacity.values[0][0]).toBe(negativeInfinityBits);
  });

  it('only marks points whose every opacity key is exactly negative infinity', () => {
    const asset = makeStaticAsset({
      sourceName: 'strict-zero-alpha.raw4d',
      position: [new Float32Array(4), new Float32Array(4), new Float32Array(4)],
      rotation: [new Float32Array([1, 1, 1, 1]), new Float32Array(4), new Float32Array(4), new Float32Array(4)],
      colorDc: [new Float32Array(4), new Float32Array(4), new Float32Array(4)],
      scale: [new Float32Array(4), new Float32Array(4), new Float32Array(4)],
      opacity: new Float32Array(4),
      shRest: [],
    });
    (asset as unknown as { totalFrames: number }).totalFrames = 5;
    (asset as unknown as { opacity: typeof asset.opacity }).opacity = {
      encoding: 'float32',
      components: 1,
      keyframes: [0, 4],
      values: [
        new Float32Array([Number.NEGATIVE_INFINITY, -20, Number.NEGATIVE_INFINITY, Number.NaN]),
        new Float32Array([Number.NEGATIVE_INFINITY, -20, -20, Number.NEGATIVE_INFINITY]),
      ],
    };

    expect(findCompletelyInvisibleStableIds(asset)).toEqual([0]);
    const report = inspectGaussianModel(asset);
    expect(report.safeDeletionCandidates).toBe(1);
  });

  it('merges full-sequence health counts without weakening deletion evidence', () => {
    const first = makeStaticAsset({
      sourceName: 'segment-1.raw4d',
      position: [new Float32Array(2), new Float32Array(2), new Float32Array(2)],
      rotation: [new Float32Array([1, 1]), new Float32Array(2), new Float32Array(2), new Float32Array(2)],
      colorDc: [new Float32Array(2), new Float32Array(2), new Float32Array(2)],
      scale: [new Float32Array(2), new Float32Array(2), new Float32Array(2)],
      opacity: new Float32Array([Number.NEGATIVE_INFINITY, 0]),
      shRest: [],
    });
    const second = makeStaticAsset({
      sourceName: 'segment-2.raw4d',
      position: [new Float32Array([Number.NaN]), new Float32Array(1), new Float32Array(1)],
      rotation: [new Float32Array([1]), new Float32Array(1), new Float32Array(1), new Float32Array(1)],
      colorDc: [new Float32Array(1), new Float32Array(1), new Float32Array(1)],
      scale: [new Float32Array(1), new Float32Array(1), new Float32Array(1)],
      opacity: new Float32Array([Number.NEGATIVE_INFINITY]),
      shRest: [],
    });

    const merged = mergeModelHealthReports([
      inspectGaussianModel(first),
      inspectGaussianModel(second),
    ]);

    expect(merged.checkedSegments).toBe(2);
    expect(merged.checkedPoints).toBe(3);
    expect(merged.safeDeletionCandidates).toBe(2);
    expect(merged.healthy).toBe(false);
    expect(merged.issues.find((issue) => issue.code === 'nonfinite-position')?.count).toBe(1);
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
