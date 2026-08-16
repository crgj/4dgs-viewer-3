export const GAUSSIAN_CANONICAL_PAGE_POINTS = 65_536;

export type GaussianCanonicalEncoding = 'float16' | 'float32';
export type GaussianCanonicalArray = Uint16Array | Float32Array;

export interface GaussianCanonicalPage {
  readonly pageIndex: number;
  readonly firstPoint: number;
  readonly pointCount: number;
  readonly encoding: GaussianCanonicalEncoding;
  readonly components: number;
  readonly values: readonly GaussianCanonicalArray[];
}

export interface GaussianCanonicalTrackSource {
  readonly id: string;
  readonly encoding: GaussianCanonicalEncoding;
  readonly components: number;
  readonly keyframes: readonly number[];
  getPage(keyframeIndex: number, pageIndex: number): GaussianCanonicalPage | Promise<GaussianCanonicalPage>;
  prefetchPage?(keyframeIndex: number, pageIndex: number): void;
  releasePage?(keyframeIndex: number, pageIndex: number): void;
}

export interface GaussianCanonicalDataset {
  readonly pointCount: number;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly tracks: ReadonlyMap<string, GaussianCanonicalTrackSource>;
  stableId(pageIndex: number, localIndex: number): number;
  locate(stableId: number): { readonly pageIndex: number; readonly localIndex: number };
}

export function createGaussianStableId(pageIndex: number, localIndex: number, pageSize: number): number {
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || !Number.isSafeInteger(localIndex) || localIndex < 0) {
    throw new RangeError('Gaussian stable ID coordinates must be non-negative integers.');
  }
  const result = pageIndex * pageSize + localIndex;
  if (!Number.isSafeInteger(result)) throw new RangeError('Gaussian stable ID exceeds Number safe integer range.');
  return result;
}
