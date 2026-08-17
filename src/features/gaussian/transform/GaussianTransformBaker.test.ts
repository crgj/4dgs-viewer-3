import { FloatPacking, Quat, Vec3 } from 'playcanvas';
import { describe, expect, it } from 'vitest';
import type { Raw4DAsset, Raw4DTrack } from '../formats/raw4d/Raw4DTypes';
import { readRaw4DScalar } from '../formats/raw4d/Raw4DValues';
import { bakeGaussianAssetTransform } from './GaussianTransformBaker';

// #WDD-gpt 2026-08-17 - 覆盖全部关键帧、椭球四元数/尺度与 SH1-3 方向等价性，防止原点重设只改中心点。

const array = (...values: number[]) => Float32Array.from(values);

function track(components: number, keyframes: readonly number[], values: readonly Float32Array[]): Raw4DTrack {
  return { encoding: 'float32', components, keyframes, values };
}

function fixture(shBands: 0 | 1 | 2 | 3 = 3): Raw4DAsset {
  const coefficientCount = shBands === 0 ? 0 : shBands === 1 ? 3 : shBands === 2 ? 8 : 15;
  return {
    sourceName: 'bake-test.raw4d',
    sourceEncoding: 'float32',
    splatCount: 2,
    totalFrames: 11,
    shBands,
    position: track(3, [0, 10], [
      array(1, -2), array(2, 0), array(3, 4),
      array(5, 1), array(6, -1), array(7, 2),
    ]),
    rotation: track(4, [0, 10], [
      array(1, 1), array(0, 0), array(0, 0), array(0, 0),
      array(1, 1), array(0, 0), array(0, 0), array(0, 0),
    ]),
    colorDc: track(3, [0], [array(0.1, 0.2), array(0.3, 0.4), array(0.5, 0.6)]),
    scale: track(3, [0, 10], [
      array(0, 0), array(0.1, 0.2), array(-0.2, -0.3),
      array(0.3, 0.4), array(0.5, 0.6), array(0.7, 0.8),
    ]),
    opacity: track(1, [0], [array(2, 3)]),
    shRest: Array.from({ length: coefficientCount * 3 }, (_, coefficient) => (
      array((coefficient + 1) * 0.001, -(coefficient + 1) * 0.0007)
    )),
    lifetimeMu: array(5, 5),
    lifetimeW: array(5, 5),
    bounds: { min: [-2, -1, 2], max: [5, 6, 7] },
  };
}

function fp16Fixture(): Raw4DAsset {
  const source = fixture(3);
  const convert = (values: Float32Array) => Uint16Array.from(values, FloatPacking.float2Half);
  const convertTrack = (value: Raw4DTrack): Raw4DTrack => ({
    ...value,
    encoding: 'float16',
    values: value.values.map((values) => convert(values as Float32Array)),
  });
  return {
    ...source,
    sourceEncoding: 'float16',
    position: convertTrack(source.position),
    rotation: convertTrack(source.rotation),
    colorDc: convertTrack(source.colorDc),
    scale: convertTrack(source.scale),
    opacity: convertTrack(source.opacity),
    shRest: source.shRest.map((values) => convert(values as Float32Array)),
    lifetimeMu: convert(source.lifetimeMu as Float32Array),
    lifetimeW: convert(source.lifetimeW as Float32Array),
  };
}

function evaluateSh(asset: Raw4DAsset, stableId: number, direction: readonly [number, number, number]): number[] {
  const [x, y, z] = direction;
  const basis = [
    -0.4886025119029199 * y,
    0.4886025119029199 * z,
    -0.4886025119029199 * x,
    1.0925484305920792 * x * y,
    -1.0925484305920792 * y * z,
    0.31539156525252005 * (2 * z * z - x * x - y * y),
    -1.0925484305920792 * x * z,
    0.5462742152960396 * (x * x - y * y),
    -0.5900435899266435 * y * (3 * x * x - y * y),
    2.890611442640554 * x * y * z,
    -0.4570457994644658 * y * (4 * z * z - x * x - y * y),
    0.3731763325901154 * z * (2 * z * z - 3 * x * x - 3 * y * y),
    -0.4570457994644658 * x * (4 * z * z - x * x - y * y),
    1.445305721320277 * z * (x * x - y * y),
    -0.5900435899266435 * x * (x * x - 3 * y * y),
  ];
  const coefficientCount = asset.shBands === 1 ? 3 : asset.shBands === 2 ? 8 : asset.shBands === 3 ? 15 : 0;
  return Array.from({ length: 3 }, (_, channel) => basis.slice(0, coefficientCount).reduce(
    (sum, value, coefficient) => sum + value * asset.shRest[channel * coefficientCount + coefficient][stableId],
    0,
  ));
}

describe('GaussianTransformBaker', () => {
  it('bakes world TRS into every keyframe and preserves directional SH appearance', async () => {
    const asset = fixture(3);
    const originalSh = asset.shRest.map((values) => values.slice());
    const originalColor = asset.colorDc.values.map((values) => values.slice());
    const transform = {
      position: [10, 20, 30] as const,
      rotation: [0, 90, 0] as const,
      scale: [2, 2, 2] as const,
    };
    const quaternion = new Quat().setFromEulerAngles(...transform.rotation).normalize();
    const inverse = quaternion.clone().invert();
    const testDirections = [
      new Vec3(1, 2, 3).normalize(),
      new Vec3(-2, 1, 0.5).normalize(),
      new Vec3(0.2, -0.8, 1).normalize(),
    ];
    const originalAsset = { ...asset, shRest: originalSh } as Raw4DAsset;
    const expectedSh = testDirections.map((direction) => {
      const oldDirection = inverse.transformVector(direction, new Vec3());
      return evaluateSh(originalAsset, 0, [oldDirection.x, oldDirection.y, oldDirection.z]);
    });

    const result = await bakeGaussianAssetTransform(asset, transform);

    expect(result).toMatchObject({
      pointCount: 2,
      positionKeyframes: 2,
      rotationKeyframes: 2,
      scaleKeyframes: 2,
      rotatedSh: true,
      shBands: 3,
    });
    const expectedPosition0 = quaternion.transformVector(new Vec3(2, 4, 6), new Vec3()).add(new Vec3(10, 20, 30));
    const expectedPosition1 = quaternion.transformVector(new Vec3(10, 12, 14), new Vec3()).add(new Vec3(10, 20, 30));
    expect(asset.position.values[0][0]).toBeCloseTo(expectedPosition0.x, 5);
    expect(asset.position.values[1][0]).toBeCloseTo(expectedPosition0.y, 5);
    expect(asset.position.values[2][0]).toBeCloseTo(expectedPosition0.z, 5);
    expect(asset.position.values[3][0]).toBeCloseTo(expectedPosition1.x, 5);
    expect(asset.position.values[4][0]).toBeCloseTo(expectedPosition1.y, 5);
    expect(asset.position.values[5][0]).toBeCloseTo(expectedPosition1.z, 5);
    for (const keyOffset of [0, 4]) {
      expect(asset.rotation.values[keyOffset][0]).toBeCloseTo(quaternion.w, 5);
      expect(asset.rotation.values[keyOffset + 1][0]).toBeCloseTo(quaternion.x, 5);
      expect(asset.rotation.values[keyOffset + 2][0]).toBeCloseTo(quaternion.y, 5);
      expect(asset.rotation.values[keyOffset + 3][0]).toBeCloseTo(quaternion.z, 5);
    }
    for (let key = 0; key < 2; key += 1) {
      for (let component = 0; component < 3; component += 1) {
        const original = [0, 0.1, -0.2, 0.3, 0.5, 0.7][key * 3 + component];
        expect(asset.scale.values[key * 3 + component][0]).toBeCloseTo(original + Math.log(2), 5);
      }
    }
    for (let index = 0; index < originalColor.length; index += 1) {
      expect([...asset.colorDc.values[index]]).toEqual([...originalColor[index]]);
    }
    testDirections.forEach((direction, directionIndex) => {
      const actual = evaluateSh(asset, 0, [direction.x, direction.y, direction.z]);
      expect(actual[0]).toBeCloseTo(expectedSh[directionIndex][0], 5);
      expect(actual[1]).toBeCloseTo(expectedSh[directionIndex][1], 5);
      expect(actual[2]).toBeCloseTo(expectedSh[directionIndex][2], 5);
    });
    expect(asset.bounds.min[0]).toBeLessThanOrEqual(Math.min(expectedPosition0.x, expectedPosition1.x));
    expect(asset.bounds.max[2]).toBeGreaterThanOrEqual(Math.max(expectedPosition0.z, expectedPosition1.z));
  });

  it('does not rewrite SH when the scene rotation is identity', async () => {
    const asset = fixture(3);
    const original = asset.shRest.map((values) => values.slice());
    const result = await bakeGaussianAssetTransform(asset, {
      position: [1, 2, 3], rotation: [0, 0, 0], scale: [1.5, 1.5, 1.5],
    });
    expect(result.rotatedSh).toBe(false);
    asset.shRest.forEach((values, index) => expect([...values]).toEqual([...original[index]]));
  });

  it('rejects non-uniform scale before changing canonical data', async () => {
    const asset = fixture(1);
    const original = asset.position.values.map((values) => values.slice());
    await expect(bakeGaussianAssetTransform(asset, {
      position: [0, 0, 0], rotation: [0, 30, 0], scale: [1, 2, 1],
    })).rejects.toThrow(/等比缩放/);
    asset.position.values.forEach((values, index) => expect([...values]).toEqual([...original[index]]));
  });

  it('keeps FP16 writes finite and derives bounds from the quantized positions', async () => {
    const asset = fp16Fixture();
    await bakeGaussianAssetTransform(asset, {
      position: [1, 2, 3], rotation: [12, 34, -8], scale: [1.25, 1.25, 1.25],
    });
    const decodedAxes = asset.position.values.map((values) => Array.from(values, (_, index) => (
      readRaw4DScalar(values, index, 'float16')
    )));
    expect(decodedAxes.flat().every(Number.isFinite)).toBe(true);
    const xs = decodedAxes.filter((_, index) => index % 3 === 0).flat();
    const ys = decodedAxes.filter((_, index) => index % 3 === 1).flat();
    const zs = decodedAxes.filter((_, index) => index % 3 === 2).flat();
    expect(asset.bounds.min).toEqual([Math.min(...xs), Math.min(...ys), Math.min(...zs)]);
    expect(asset.bounds.max).toEqual([Math.max(...xs), Math.max(...ys), Math.max(...zs)]);
    expect(asset.shRest.flatMap((values) => Array.from(values, (_, index) => (
      readRaw4DScalar(values, index, 'float16')
    ))).every(Number.isFinite)).toBe(true);
  });
});
