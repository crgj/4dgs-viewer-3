import { describe, expect, it } from 'vitest';
import { createRaw4DStorageModifierWGSL } from './Raw4DGpuPlayback';

describe('RAW4D storage playback shader', () => {
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
});
