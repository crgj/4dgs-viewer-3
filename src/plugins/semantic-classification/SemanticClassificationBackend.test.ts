import { describe, expect, it } from 'vitest';
import {
  SEMANTIC_WASM_PROFILE,
  SEMANTIC_WEBGPU_PROFILE,
  selectSemanticModelProfile,
} from './SemanticClassificationBackend';

describe('selectSemanticModelProfile', () => {
  it('keeps q4f16 when WebGPU and shader-f16 are both available', () => {
    expect(selectSemanticModelProfile(true, true)).toBe(SEMANTIC_WEBGPU_PROFILE);
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
  ])('uses the stable q8 WASM fallback for capability combination %s/%s', (adapter, shaderF16) => {
    expect(selectSemanticModelProfile(adapter, shaderF16)).toBe(SEMANTIC_WASM_PROFILE);
  });
});
