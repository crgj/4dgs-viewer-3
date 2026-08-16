import { describe, expect, it } from 'vitest';
import type { Raw4DAsset, Raw4DScalarEncoding, Raw4DTrack } from '../formats/raw4d/Raw4DTypes';
import { createRaw4DGpuMemoryPlan } from './Raw4DGpuMemoryPlan';

function track(pointCount: number, components: number, keys: number, encoding: Raw4DScalarEncoding): Raw4DTrack {
  const ArrayType = encoding === 'float16' ? Uint16Array : Float32Array;
  return {
    encoding,
    components,
    keyframes: Array.from({ length: keys }, (_, index) => index * 3),
    values: Array.from({ length: components * keys }, () => new ArrayType(pointCount)),
  };
}

function masterShape(encoding: Raw4DScalarEncoding): Raw4DAsset {
  const pointCount = 287_093;
  const ArrayType = encoding === 'float16' ? Uint16Array : Float32Array;
  return {
    sourceName: 'master.raw4d', sourceEncoding: encoding, splatCount: pointCount, totalFrames: 31, shBands: 3,
    position: track(pointCount, 3, 11, encoding), rotation: track(pointCount, 4, 2, encoding),
    colorDc: track(pointCount, 3, 2, encoding), scale: track(pointCount, 3, 4, encoding),
    opacity: track(pointCount, 1, 4, encoding), shRest: [],
    lifetimeMu: new ArrayType(pointCount), lifetimeW: new ArrayType(pointCount),
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  };
}

describe('RAW4D WebGPU memory plan', () => {
  it('caps residency at 2+1 slots instead of scaling with every playback keyframe', () => {
    const floatPlan = createRaw4DGpuMemoryPlan(masterShape('float32'));
    const halfPlan = createRaw4DGpuMemoryPlan(masterShape('float16'));
    expect(floatPlan.positionSlotCount).toBe(3);
    expect(floatPlan.rotationSlotCount).toBe(2);
    expect(floatPlan.scaleSlotCount).toBe(3);
    expect(floatPlan.opacitySlotCount).toBe(3);
    expect(floatPlan.totalBytes).toBe(51_676_740);
    expect(halfPlan.totalBytes).toBe(25_838_380);
    expect(halfPlan.totalBytes).toBeLessThan(96_463_248 * 0.27);
  });
});
