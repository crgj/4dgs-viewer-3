export type SemanticClassificationBackend = 'webgpu-q4f16' | 'wasm-q8';

export interface SemanticModelProfile {
  readonly backend: SemanticClassificationBackend;
  readonly device: 'webgpu' | 'wasm';
  readonly dtype: 'q4f16' | 'q8';
  readonly weightBytes: number;
}

export const SEMANTIC_WEBGPU_PROFILE: SemanticModelProfile = {
  backend: 'webgpu-q4f16',
  device: 'webgpu',
  dtype: 'q4f16',
  weightBytes: 115_520_184,
};

export const SEMANTIC_WASM_PROFILE: SemanticModelProfile = {
  backend: 'wasm-q8',
  device: 'wasm',
  dtype: 'q8',
  weightBytes: 139_115_836,
};

// #WDD-gpt 2026-08-26 - q4f16 依赖 WebGPU shader-f16；没有该能力时选择官方 q8 ONNX，保证 WebGL2 浏览器也能完成本地分类。
export function selectSemanticModelProfile(
  hasWebGpuAdapter: boolean,
  supportsShaderF16: boolean,
): SemanticModelProfile {
  return hasWebGpuAdapter && supportsShaderF16
    ? SEMANTIC_WEBGPU_PROFILE
    : SEMANTIC_WASM_PROFILE;
}
