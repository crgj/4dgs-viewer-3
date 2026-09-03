import type { Raw4DAsset, Raw4DTrack } from '../../../gaussian/formats/raw4d/Raw4DTypes';
import { readRaw4DScalar } from '../../../gaussian/formats/raw4d/Raw4DValues';

interface TrackSpan {
  readonly left: number;
  readonly right: number;
  readonly alpha: number;
}

export interface Raw4DSelectionFrameProperties {
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly opacity: Float32Array;
}

function trackSpan(track: Raw4DTrack, frame: number): TrackSpan {
  if (track.keyframes.length === 1 || frame <= track.keyframes[0]) {
    return { left: 0, right: 0, alpha: 0 };
  }
  const last = track.keyframes.length - 1;
  if (frame >= track.keyframes[last]) return { left: last, right: last, alpha: 0 };
  for (let right = 1; right < track.keyframes.length; right += 1) {
    if (frame <= track.keyframes[right]) {
      const left = right - 1;
      return {
        left,
        right,
        alpha: (frame - track.keyframes[left]) / (track.keyframes[right] - track.keyframes[left]),
      };
    }
  }
  return { left: last, right: last, alpha: 0 };
}

function stableSigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

function interpolateExtended(left: number, right: number, alpha: number): number {
  if (alpha <= 0 || left === right) return left;
  if (alpha >= 1) return right;
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    if (left === -Infinity || right === -Infinity) return -Infinity;
  }
  return left + (right - left) * alpha;
}

// #WDD-gpt  2026-08-16 - 选择扫描器只保留 XYZO 四个数组，避免全局框选复制 SH、旋转、缩放和颜色数据。
export class Raw4DSelectionFrameSampler {
  readonly properties: Raw4DSelectionFrameProperties;
  private sampledFrame = Number.NaN;

  constructor(private readonly asset: Raw4DAsset) {
    this.properties = {
      x: new Float32Array(asset.splatCount),
      y: new Float32Array(asset.splatCount),
      z: new Float32Array(asset.splatCount),
      opacity: new Float32Array(asset.splatCount),
    };
  }

  sample(requestedFrame: number): boolean {
    const frame = Math.min(this.asset.totalFrames - 1, Math.max(0, requestedFrame));
    if (frame === this.sampledFrame) return false;
    this.samplePosition(frame);
    this.sampleOpacity(frame);
    this.sampledFrame = frame;
    return true;
  }

  private samplePosition(frame: number): void {
    const track = this.asset.position;
    // #WDD-gpt 2026-08-27 - 4GS 两个位置 bank 是每点生命周期端点，不是全局首尾帧；选择、分类与渲染必须使用同一逐点时间参数。
    if (this.asset.positionTiming === 'per-point-lifetime-endpoints') {
      const destinations = [this.properties.x, this.properties.y, this.properties.z];
      for (let index = 0; index < this.asset.splatCount; index += 1) {
        const center = readRaw4DScalar(this.asset.lifetimeMu, index, this.asset.sourceEncoding);
        const halfWidth = Math.max(0, readRaw4DScalar(this.asset.lifetimeW, index, this.asset.sourceEncoding));
        const start = center - halfWidth;
        const end = center + halfWidth;
        const alpha = end > start ? Math.max(0, Math.min(1, (frame - start) / (end - start))) : 0;
        for (let component = 0; component < 3; component += 1) {
          const left = readRaw4DScalar(track.values[component], index, track.encoding);
          const right = readRaw4DScalar(track.values[3 + component], index, track.encoding);
          destinations[component][index] = left + (right - left) * alpha;
        }
      }
      return;
    }
    const span = trackSpan(track, frame);
    const destinations = [this.properties.x, this.properties.y, this.properties.z];
    for (let component = 0; component < 3; component += 1) {
      const destination = destinations[component];
      const left = track.values[span.left * track.components + component];
      const right = track.values[span.right * track.components + component];
      for (let index = 0; index < destination.length; index += 1) {
        const leftValue = readRaw4DScalar(left, index, track.encoding);
        const rightValue = readRaw4DScalar(right, index, track.encoding);
        destination[index] = leftValue + (rightValue - leftValue) * span.alpha;
      }
    }
  }

  private sampleOpacity(frame: number): void {
    const track = this.asset.opacity;
    const span = trackSpan(track, frame);
    const left = track.values[span.left];
    const right = track.values[span.right];
    for (let index = 0; index < this.properties.opacity.length; index += 1) {
      const logit = interpolateExtended(
        readRaw4DScalar(left, index, track.encoding),
        readRaw4DScalar(right, index, track.encoding),
        span.alpha,
      );
      let gate = 1;
      if (this.asset.opacityTiming !== 'baked') {
        const lifetimeMu = readRaw4DScalar(this.asset.lifetimeMu, index, this.asset.sourceEncoding);
        const lifetimeW = readRaw4DScalar(this.asset.lifetimeW, index, this.asset.sourceEncoding);
        gate = stableSigmoid(10 * (frame - (lifetimeMu - lifetimeW)))
          * stableSigmoid(10 * ((lifetimeMu + lifetimeW) - frame));
      }
      this.properties.opacity[index] = stableSigmoid(logit) * gate;
    }
  }
}
