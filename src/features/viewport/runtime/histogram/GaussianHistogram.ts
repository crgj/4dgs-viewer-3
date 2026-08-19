import type { Raw4DAsset, Raw4DTrack } from '../../../gaussian/formats/raw4d/Raw4DTypes';
import { readRaw4DScalar } from '../../../gaussian/formats/raw4d/Raw4DValues';

export type GaussianHistogramMetric = 'opacity' | 'scale-max' | 'volume' | 'x' | 'y' | 'z' | 'distance' | 'lifetime-center' | 'lifetime-width';
export type GaussianHistogramAggregation = 'minimum' | 'mean' | 'maximum';

interface TrackSpan {
  readonly alpha: number;
  readonly left: number;
  readonly right: number;
}

function trackSpan(track: Raw4DTrack, frame: number): TrackSpan {
  if (track.keyframes.length === 1 || frame <= track.keyframes[0]) return { alpha: 0, left: 0, right: 0 };
  const last = track.keyframes.length - 1;
  if (frame >= track.keyframes[last]) return { alpha: 0, left: last, right: last };
  for (let right = 1; right < track.keyframes.length; right += 1) {
    if (frame <= track.keyframes[right]) {
      const left = right - 1;
      return {
        alpha: (frame - track.keyframes[left]) / (track.keyframes[right] - track.keyframes[left]),
        left,
        right,
      };
    }
  }
  return { alpha: 0, left: last, right: last };
}

function sigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

function interpolate(left: number, right: number, alpha: number): number {
  if (alpha <= 0 || left === right) return left;
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    if (left === -Infinity || right === -Infinity) return -Infinity;
  }
  return left + (right - left) * alpha;
}

// #WDD-gpt 2026-08-19 - 直方图扫描器只解码所选指标、位置/尺度和可见度，不创建 GSplatData 或复制 SH。
export class Raw4DHistogramFrameSampler {
  readonly opacity: Float32Array;
  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private readonly z: Float32Array;
  private readonly scaleX: Float32Array;
  private readonly scaleY: Float32Array;
  private readonly scaleZ: Float32Array;

  constructor(private readonly asset: Raw4DAsset, private readonly metric: GaussianHistogramMetric) {
    this.opacity = new Float32Array(asset.splatCount);
    this.x = new Float32Array(asset.splatCount);
    this.y = new Float32Array(asset.splatCount);
    this.z = new Float32Array(asset.splatCount);
    this.scaleX = new Float32Array(asset.splatCount);
    this.scaleY = new Float32Array(asset.splatCount);
    this.scaleZ = new Float32Array(asset.splatCount);
  }

  sample(frame: number): void {
    const clamped = Math.max(0, Math.min(this.asset.totalFrames - 1, frame));
    this.sampleOpacity(clamped);
    if (this.metric === 'x' || this.metric === 'y' || this.metric === 'z' || this.metric === 'distance') {
      this.sampleTrack(this.asset.position, clamped, [this.x, this.y, this.z], false);
    } else if (this.metric === 'scale-max' || this.metric === 'volume') {
      this.sampleTrack(this.asset.scale, clamped, [this.scaleX, this.scaleY, this.scaleZ], true);
    }
  }

  value(stableId: number): number {
    switch (this.metric) {
      case 'opacity': return this.opacity[stableId];
      case 'scale-max': return Math.max(this.scaleX[stableId], this.scaleY[stableId], this.scaleZ[stableId]);
      case 'volume': return this.scaleX[stableId] * this.scaleY[stableId] * this.scaleZ[stableId];
      case 'x': return this.x[stableId];
      case 'y': return this.y[stableId];
      case 'z': return this.z[stableId];
      case 'distance': return Math.hypot(this.x[stableId], this.y[stableId], this.z[stableId]);
      case 'lifetime-center': return readRaw4DScalar(this.asset.lifetimeMu, stableId, this.asset.sourceEncoding);
      case 'lifetime-width': return readRaw4DScalar(this.asset.lifetimeW, stableId, this.asset.sourceEncoding);
    }
  }

  private sampleTrack(track: Raw4DTrack, frame: number, outputs: readonly Float32Array[], exponential: boolean): void {
    const span = trackSpan(track, frame);
    for (let component = 0; component < outputs.length; component += 1) {
      const output = outputs[component];
      const left = track.values[span.left * track.components + component];
      const right = track.values[span.right * track.components + component];
      for (let stableId = 0; stableId < output.length; stableId += 1) {
        const value = interpolate(
          readRaw4DScalar(left, stableId, track.encoding),
          readRaw4DScalar(right, stableId, track.encoding),
          span.alpha,
        );
        output[stableId] = exponential ? Math.exp(value) : value;
      }
    }
  }

  private sampleOpacity(frame: number): void {
    const track = this.asset.opacity;
    const span = trackSpan(track, frame);
    const left = track.values[span.left];
    const right = track.values[span.right];
    for (let stableId = 0; stableId < this.opacity.length; stableId += 1) {
      const logit = interpolate(
        readRaw4DScalar(left, stableId, track.encoding),
        readRaw4DScalar(right, stableId, track.encoding),
        span.alpha,
      );
      const center = readRaw4DScalar(this.asset.lifetimeMu, stableId, this.asset.sourceEncoding);
      const width = readRaw4DScalar(this.asset.lifetimeW, stableId, this.asset.sourceEncoding);
      const leftGate = sigmoid(10 * (frame - (center - width)));
      const rightGate = sigmoid(10 * ((center + width) - frame));
      this.opacity[stableId] = sigmoid(logit) * leftGate * rightGate;
    }
  }
}

export function histogramRangeIds(
  values: Float32Array,
  eligible: Uint8Array,
  lower: number,
  upper: number,
): number[] {
  const min = Math.min(lower, upper);
  const max = Math.max(lower, upper);
  const result: number[] = [];
  for (let stableId = 0; stableId < values.length; stableId += 1) {
    if (eligible[stableId] && values[stableId] >= min && values[stableId] <= max) result.push(stableId);
  }
  return result;
}

export function buildGaussianHistogramBins(
  groups: readonly { readonly eligible: Uint8Array; readonly values: Float32Array }[],
  binCount = 48,
): { readonly bins: readonly number[]; readonly count: number; readonly rangeMax: number; readonly rangeMin: number; readonly valueMax: number; readonly valueMin: number } {
  let valueMin = Number.POSITIVE_INFINITY;
  let valueMax = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const group of groups) {
    for (let index = 0; index < group.values.length; index += 1) {
      const value = group.values[index];
      if (!group.eligible[index] || !Number.isFinite(value)) continue;
      valueMin = Math.min(valueMin, value);
      valueMax = Math.max(valueMax, value);
      count += 1;
    }
  }
  if (count === 0) return { bins: Array(binCount).fill(0), count: 0, rangeMax: 1, rangeMin: 0, valueMax: 0, valueMin: 0 };
  const padding = valueMin === valueMax ? Math.max(0.5, Math.abs(valueMin) * 0.05) : 0;
  const rangeMin = valueMin - padding;
  const rangeMax = valueMax + padding;
  const span = Math.max(Number.EPSILON, rangeMax - rangeMin);
  const bins = Array(binCount).fill(0) as number[];
  for (const group of groups) {
    for (let index = 0; index < group.values.length; index += 1) {
      const value = group.values[index];
      if (!group.eligible[index] || !Number.isFinite(value)) continue;
      const bin = Math.min(binCount - 1, Math.max(0, Math.floor((value - rangeMin) / span * binCount)));
      bins[bin] += 1;
    }
  }
  return { bins, count, rangeMax, rangeMin, valueMax, valueMin };
}
