import { describe, expect, it } from 'vitest';
import { FloatPacking } from 'playcanvas';
import { createRaw4DStorageModifierWGSL, raw4DSortCentersNeedRefresh } from './Raw4DGpuPlayback';

describe('RAW4D storage playback shader', () => {
  it('refreshes WebGL sort centers for every changed frame', () => {
    expect(raw4DSortCentersNeedRefresh(25, 24)).toBe(true);
    expect(raw4DSortCentersNeedRefresh(25, 25)).toBe(false);
    expect(raw4DSortCentersNeedRefresh(25.25, 25)).toBe(true);
  });

  it('replaces full-keyframe textures with three float storage bindings', () => {
    const shader = createRaw4DStorageModifierWGSL(false);
    expect(shader).toContain('var<storage, read> dongRaw4dPositionData: array<vec4f>');
    expect(shader).toContain('var<storage, read> dongRaw4dVectorData: array<vec4f>');
    expect(shader).toContain('var<storage, read> dongRaw4dScalarData: array<f32>');
    expect(shader).not.toContain('var dongRaw4dPositionTex');
    expect(shader).not.toContain('dongRaw4dLifetimeTex');
    expect(shader).toContain('dongRaw4dDeleteMaskTex');
  });

  it('unpacks source FP16 bits directly in the half-width storage variant', () => {
    const shader = createRaw4DStorageModifierWGSL(true);
    expect(shader).toContain('array<vec2u>');
    expect(shader).toContain('array<u32>');
    expect(shader).toContain('unpack2x16float');
    expect((shader.match(/\{/g) ?? []).length).toBe((shader.match(/\}/g) ?? []).length);
  });

  it('preserves negative-infinity opacity and uses Python-compatible interpolation', () => {
    const shader = createRaw4DStorageModifierWGSL(true);

    expect(FloatPacking.float2Half(-Infinity)).toBe(0xfc00);
    expect(shader).toContain('fn dongIsNegativeInfinity');
    expect(shader).toContain('bitcast<u32>(value) == 0xff800000u');
    expect(shader).toContain('if (bitcast<u32>(value) == 0xff800000u) { return 0.0; }');
    expect(shader).toContain('let opacityLogit = dongInterpolateExtended(');
    expect(shader).toContain('return bitcast<f32>(0xff800000u);');
  });
});
