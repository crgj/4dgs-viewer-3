import { Raw4DAssetLoader } from '../raw4d/Raw4DAssetLoader';
import type { GaussianAssetDecodeOptions, GaussianSourceFormat, ImportedGaussianAsset } from './GaussianImportTypes';
import { decodePlyGaussian } from './PlyGaussianDecoder';
import { decodeSogGaussian } from './SogGaussianDecoder';

// #WDD-gpt 2026-08-16 - 单一导入入口负责格式路由，内存注册仍由 ViewportRuntime 统一完成。

export function detectGaussianSourceFormat(fileName: string): GaussianSourceFormat | null {
  const extension = fileName.split('.').pop()?.toLowerCase();
  if (extension === 'raw4d') return 'RAW4D';
  if (extension === 'ply4') return 'PLY4';
  if (extension === 'sog') return 'SOG';
  if (extension === 'ply') return 'PLY';
  return null;
}

export class GaussianAssetImporter {
  private readonly raw4DLoader = new Raw4DAssetLoader();

  async load(file: File, options: GaussianAssetDecodeOptions): Promise<ImportedGaussianAsset> {
    const format = detectGaussianSourceFormat(file.name);
    if (!format) throw new Error('仅支持 .raw4d、.ply4、.sog 和 .ply 文件。');
    if (format === 'PLY' || format === 'PLY4') return decodePlyGaussian(file, options);
    if (format === 'SOG') return decodeSogGaussian(file, options);
    const loaded = await this.raw4DLoader.load(file, options.cpuBudgetBytes, {
      signal: options.signal,
      onProgress: (progress) => options.onProgress?.(progress),
    });
    return { ...loaded, format: 'RAW4D' };
  }

  destroy(): void {
    this.raw4DLoader.destroy();
  }
}
