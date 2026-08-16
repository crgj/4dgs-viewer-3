import { Raw4DAssetLoader } from '../raw4d/Raw4DAssetLoader';
import type { GaussianAssetDecodeOptions, GaussianSourceFormat, ImportedGaussianAsset } from './GaussianImportTypes';
import { decodePlyGaussian } from './PlyGaussianDecoder';
import { decodeSogGaussian } from './SogGaussianDecoder';

// #WDD-gpt 2026-08-16 - 单一导入入口负责格式路由，内存注册仍由 ViewportRuntime 统一完成。

function preferredRaw4DWorkerCount(): number {
  const hardwareConcurrency = typeof navigator === 'undefined' ? 4 : navigator.hardwareConcurrency || 4;
  if (hardwareConcurrency >= 12) return 3;
  if (hardwareConcurrency >= 6) return 2;
  return 1;
}

export function detectGaussianSourceFormat(fileName: string): GaussianSourceFormat | null {
  const extension = fileName.split('.').pop()?.toLowerCase();
  if (extension === 'raw4d') return 'RAW4D';
  if (extension === 'ply4') return 'PLY4';
  if (extension === 'sog') return 'SOG';
  if (extension === 'ply') return 'PLY';
  return null;
}

export class GaussianAssetImporter {
  // #WDD-gpt 2026-08-16 - 三个 Loader Worker 足以并行六段 RAW4D；继续增加只会放大大数组分配和内存带宽争用。
  private readonly raw4DLoaders: readonly Raw4DAssetLoader[];
  private nextRaw4DLoader = 0;

  constructor(raw4DWorkerCount = preferredRaw4DWorkerCount()) {
    const workerCount = Math.max(1, Math.min(3, Math.floor(raw4DWorkerCount)));
    this.raw4DLoaders = Array.from({ length: workerCount }, () => new Raw4DAssetLoader());
  }

  get raw4DWorkerCount(): number {
    return this.raw4DLoaders.length;
  }

  async load(file: File, options: GaussianAssetDecodeOptions): Promise<ImportedGaussianAsset> {
    const format = detectGaussianSourceFormat(file.name);
    if (!format) throw new Error('仅支持 .raw4d、.ply4、.sog 和 .ply 文件。');
    if (format === 'PLY' || format === 'PLY4') return decodePlyGaussian(file, options);
    if (format === 'SOG') return decodeSogGaussian(file, options);
    const loader = this.raw4DLoaders[this.nextRaw4DLoader];
    this.nextRaw4DLoader = (this.nextRaw4DLoader + 1) % this.raw4DLoaders.length;
    const loaded = await loader.load(file, options.cpuBudgetBytes, {
      signal: options.signal,
      onProgress: (progress) => options.onProgress?.(progress),
    });
    return { ...loaded, format: 'RAW4D' };
  }

  destroy(): void {
    for (const loader of this.raw4DLoaders) loader.destroy();
  }
}
