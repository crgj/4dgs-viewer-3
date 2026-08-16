import type { Raw4DAsset, Raw4DTrack } from './Raw4DTypes';

function measureTrackBytes(track: Raw4DTrack): number {
  return track.values.reduce((total, values) => total + values.byteLength, 0);
}

export function measureRaw4DAssetBytes(asset: Raw4DAsset): number {
  // #WDD-gpt 2026-08-15 - RAW4D 指标只统计格式解码产生的 TypedArray backing store。
  return measureTrackBytes(asset.position)
    + measureTrackBytes(asset.rotation)
    + measureTrackBytes(asset.colorDc)
    + measureTrackBytes(asset.scale)
    + measureTrackBytes(asset.opacity)
    + asset.shRest.reduce((total, values) => total + values.byteLength, 0)
    + asset.lifetimeMu.byteLength
    + asset.lifetimeW.byteLength;
}
