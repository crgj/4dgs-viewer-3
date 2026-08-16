import {
  createGaussianStableId,
  GAUSSIAN_CANONICAL_PAGE_POINTS,
  type GaussianCanonicalDataset,
  type GaussianCanonicalPage,
  type GaussianCanonicalTrackSource,
} from '../../data/GaussianCanonicalDataset';
import type { Raw4DAsset, Raw4DTrack } from './Raw4DTypes';

function createTrackSource(
  id: string,
  track: Raw4DTrack,
  pointCount: number,
  pageSize: number,
): GaussianCanonicalTrackSource {
  return {
    id,
    encoding: track.encoding,
    components: track.components,
    keyframes: track.keyframes,
    getPage: (keyframeIndex, pageIndex): GaussianCanonicalPage => {
      if (keyframeIndex < 0 || keyframeIndex >= track.keyframes.length) throw new RangeError('Invalid keyframe index.');
      const firstPoint = pageIndex * pageSize;
      const pagePointCount = Math.min(pageSize, Math.max(0, pointCount - firstPoint));
      if (pagePointCount <= 0) throw new RangeError('Invalid Gaussian page index.');
      const valueOffset = keyframeIndex * track.components;
      return {
        pageIndex,
        firstPoint,
        pointCount: pagePointCount,
        encoding: track.encoding,
        components: track.components,
        values: Array.from({ length: track.components }, (_, component) => (
          track.values[valueOffset + component].subarray(firstPoint, firstPoint + pagePointCount)
        )),
      };
    },
  };
}
export class Raw4DCanonicalDataset implements GaussianCanonicalDataset {
  readonly pointCount: number;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly tracks: ReadonlyMap<string, GaussianCanonicalTrackSource>;

  constructor(readonly asset: Raw4DAsset, pageSize = GAUSSIAN_CANONICAL_PAGE_POINTS) {
    this.pointCount = asset.splatCount;
    this.pageSize = Math.max(1, Math.floor(pageSize));
    this.pageCount = Math.ceil(this.pointCount / this.pageSize);
    // #WDD-gpt 2026-08-16 - 格式适配器只暴露统一的分页轨迹语义，后续压缩格式无需进入渲染与编辑层。
    this.tracks = new Map([
      ['position', createTrackSource('position', asset.position, this.pointCount, this.pageSize)],
      ['rotation', createTrackSource('rotation', asset.rotation, this.pointCount, this.pageSize)],
      ['colorDc', createTrackSource('colorDc', asset.colorDc, this.pointCount, this.pageSize)],
      ['scale', createTrackSource('scale', asset.scale, this.pointCount, this.pageSize)],
      ['opacity', createTrackSource('opacity', asset.opacity, this.pointCount, this.pageSize)],
    ]);
  }

  stableId(pageIndex: number, localIndex: number): number {
    const id = createGaussianStableId(pageIndex, localIndex, this.pageSize);
    if (id >= this.pointCount) throw new RangeError('Gaussian stable ID is outside this dataset.');
    return id;
  }

  locate(stableId: number): { readonly pageIndex: number; readonly localIndex: number } {
    if (!Number.isSafeInteger(stableId) || stableId < 0 || stableId >= this.pointCount) {
      throw new RangeError('Gaussian stable ID is outside this dataset.');
    }
    return {
      pageIndex: Math.floor(stableId / this.pageSize),
      localIndex: stableId % this.pageSize,
    };
  }
}
