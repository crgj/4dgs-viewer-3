import type { Raw4DAsset, Raw4DBounds, Raw4DTrack } from '../raw4d/Raw4DTypes';
import { measureRaw4DAssetBytes } from '../raw4d/Raw4DMemoryMetrics';
import type {
  GaussianAssetDecodeOptions,
  GaussianSourceFormat,
  ImportedGaussianAsset,
} from './GaussianImportTypes';

export const SH_COEFFICIENTS_BY_BAND = [0, 3, 8, 15] as const;

export function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Gaussian import was cancelled.', 'AbortError');
}

export function staticTrack(components: number, values: readonly Float32Array[]): Raw4DTrack {
  return { encoding: 'float32', components, keyframes: [0], values };
}

export function calculateBounds(
  x: ArrayLike<number>, y: ArrayLike<number>, z: ArrayLike<number>,
): Raw4DBounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < x.length; index += 1) {
    const px = x[index]; const py = y[index]; const pz = z[index];
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;
    minX = Math.min(minX, px); minY = Math.min(minY, py); minZ = Math.min(minZ, pz);
    maxX = Math.max(maxX, px); maxY = Math.max(maxY, py); maxZ = Math.max(maxZ, pz);
  }
  if (!Number.isFinite(minX)) return { min: [-1, -1, -1], max: [1, 1, 1] };
  const epsilon = 1e-4;
  return {
    min: [minX, minY, minZ],
    max: [Math.max(maxX, minX + epsilon), Math.max(maxY, minY + epsilon), Math.max(maxZ, minZ + epsilon)],
  };
}

export function makeStaticAsset(input: {
  readonly sourceName: string;
  readonly position: readonly [Float32Array, Float32Array, Float32Array];
  readonly rotation: readonly [Float32Array, Float32Array, Float32Array, Float32Array];
  readonly colorDc: readonly [Float32Array, Float32Array, Float32Array];
  readonly scale: readonly [Float32Array, Float32Array, Float32Array];
  readonly opacity: Float32Array;
  readonly shRest: readonly Float32Array[];
}): Raw4DAsset {
  const count = input.position[0].length;
  const lifetimeMu = new Float32Array(count);
  const lifetimeW = new Float32Array(count);
  lifetimeW.fill(1);
  const shBands = input.shRest.length >= 45 ? 3 : input.shRest.length >= 24 ? 2 : input.shRest.length >= 9 ? 1 : 0;
  const coefficientCount = SH_COEFFICIENTS_BY_BAND[shBands] * 3;
  return {
    sourceName: input.sourceName,
    sourceEncoding: 'float32',
    splatCount: count,
    totalFrames: 1,
    shBands,
    position: staticTrack(3, input.position),
    rotation: staticTrack(4, input.rotation),
    colorDc: staticTrack(3, input.colorDc),
    scale: staticTrack(3, input.scale),
    opacity: staticTrack(1, [input.opacity]),
    shRest: input.shRest.slice(0, coefficientCount),
    lifetimeMu,
    lifetimeW,
    bounds: calculateBounds(...input.position),
  };
}

export function finalizeImportedAsset(
  file: File,
  format: GaussianSourceFormat,
  asset: Raw4DAsset,
  options: GaussianAssetDecodeOptions,
  decodeBackend: ImportedGaussianAsset['decodeBackend'] = 'typed-array',
): ImportedGaussianAsset {
  const cpuResidentBytes = measureRaw4DAssetBytes(asset);
  if (cpuResidentBytes > options.cpuBudgetBytes) {
    throw new Error(`解码后需要 ${(cpuResidentBytes / 1e9).toFixed(2)} GB，超过当前统一 CPU 内存预算。`);
  }
  // #WDD-gpt 2026-08-16 - 各格式仅在这里生成统一驻留描述，后续全部交给 GaussianMemoryCoordinator。
  const bufferId = `${format.toLowerCase()}:${file.name}:${file.size}:${file.lastModified}`;
  return {
    asset,
    bufferId,
    cpuResidentBytes,
    decodeBackend,
    format,
    sourceToResidentRatio: file.size / Math.max(1, cpuResidentBytes),
    transport: 'transferable',
    releaseBacking: () => undefined,
  };
}

