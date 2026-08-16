import type { Raw4DAsset } from '../raw4d/Raw4DTypes';

// #WDD-gpt 2026-08-16 - 统一描述所有前端 Gaussian 导入结果，使格式差异停留在解码边界。

export type GaussianSourceFormat = 'RAW4D' | 'PLY4' | 'SOG' | 'PLY';

export interface GaussianImportProgress {
  readonly ratio: number;
  readonly stage: string;
  readonly message: string;
}

export interface ImportedGaussianAsset {
  readonly asset: Raw4DAsset;
  readonly bufferId: string;
  readonly cpuResidentBytes: number;
  readonly decodeBackend: 'wasm' | 'fp16-bits' | 'typed-array' | 'image-codebook';
  readonly format: GaussianSourceFormat;
  readonly sourceToResidentRatio: number;
  readonly transport: 'shared-array-buffer' | 'transferable';
  releaseBacking(): void;
}

export interface GaussianAssetDecodeOptions {
  readonly cpuBudgetBytes: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: GaussianImportProgress) => void;
}
