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
  readonly ellipse: Raw4DSelectionEllipseProperties | null;
}

export interface Raw4DSelectionEllipseProperties {
  readonly rotationW: Float32Array;
  readonly rotationX: Float32Array;
  readonly rotationY: Float32Array;
  readonly rotationZ: Float32Array;
  readonly scaleX: Float32Array;
  readonly scaleY: Float32Array;
  readonly scaleZ: Float32Array;
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
  private rotationPairIndex = -1;
  private rotationTheta: Float32Array | null = null;
  private rotationInverseSine: Float32Array | null = null;
  private rotationRightSign: Int8Array | null = null;

  constructor(private readonly asset: Raw4DAsset, includeEllipse = false) {
    this.properties = {
      x: new Float32Array(asset.splatCount),
      y: new Float32Array(asset.splatCount),
      z: new Float32Array(asset.splatCount),
      opacity: new Float32Array(asset.splatCount),
      ellipse: includeEllipse ? {
        rotationW: new Float32Array(asset.splatCount),
        rotationX: new Float32Array(asset.splatCount),
        rotationY: new Float32Array(asset.splatCount),
        rotationZ: new Float32Array(asset.splatCount),
        scaleX: new Float32Array(asset.splatCount),
        scaleY: new Float32Array(asset.splatCount),
        scaleZ: new Float32Array(asset.splatCount),
      } : null,
    };
  }

  sample(requestedFrame: number): boolean {
    const frame = Math.min(this.asset.totalFrames - 1, Math.max(0, requestedFrame));
    if (frame === this.sampledFrame) return false;
    this.samplePosition(frame);
    this.sampleOpacity(frame);
    if (this.properties.ellipse) {
      this.sampleScale(frame, this.properties.ellipse);
      this.sampleRotation(frame, this.properties.ellipse);
    }
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

  private sampleScale(frame: number, ellipse: Raw4DSelectionEllipseProperties): void {
    const track = this.asset.scale;
    const span = trackSpan(track, frame);
    const destinations = [ellipse.scaleX, ellipse.scaleY, ellipse.scaleZ];
    for (let component = 0; component < 3; component += 1) {
      const left = track.values[span.left * 3 + component];
      const right = track.values[span.right * 3 + component];
      const destination = destinations[component];
      for (let index = 0; index < destination.length; index += 1) {
        destination[index] = Math.exp(interpolateExtended(
          readRaw4DScalar(left, index, track.encoding),
          readRaw4DScalar(right, index, track.encoding),
          span.alpha,
        ));
      }
    }
  }

  // #WDD-gpt 2026-09-20 - 椭圆选择按渲染器同样的最短弧 slerp 采样旋转，并只缓存当前关键帧对的系数。
  private prepareRotationPair(leftKey: number): void {
    if (this.rotationPairIndex === leftKey) return;
    const track = this.asset.rotation;
    const leftOffset = leftKey * 4;
    const rightOffset = leftOffset + 4;
    const theta = new Float32Array(this.asset.splatCount);
    const inverseSine = new Float32Array(this.asset.splatCount);
    const rightSign = new Int8Array(this.asset.splatCount);
    for (let index = 0; index < this.asset.splatCount; index += 1) {
      const lw = readRaw4DScalar(track.values[leftOffset], index, track.encoding);
      const lx = readRaw4DScalar(track.values[leftOffset + 1], index, track.encoding);
      const ly = readRaw4DScalar(track.values[leftOffset + 2], index, track.encoding);
      const lz = readRaw4DScalar(track.values[leftOffset + 3], index, track.encoding);
      const rw = readRaw4DScalar(track.values[rightOffset], index, track.encoding);
      const rx = readRaw4DScalar(track.values[rightOffset + 1], index, track.encoding);
      const ry = readRaw4DScalar(track.values[rightOffset + 2], index, track.encoding);
      const rz = readRaw4DScalar(track.values[rightOffset + 3], index, track.encoding);
      const leftLength = Math.hypot(lw, lx, ly, lz);
      const rightLength = Math.hypot(rw, rx, ry, rz);
      let cosine = leftLength > 1e-12 && rightLength > 1e-12
        ? (lw * rw + lx * rx + ly * ry + lz * rz) / (leftLength * rightLength)
        : 1;
      const sign = cosine < 0 ? -1 : 1;
      cosine = Math.min(1, Math.max(-1, cosine * sign));
      const angle = Math.acos(cosine);
      const sine = Math.sin(angle);
      theta[index] = angle;
      inverseSine[index] = sine > 1e-5 ? 1 / sine : 0;
      rightSign[index] = sign;
    }
    this.rotationPairIndex = leftKey;
    this.rotationTheta = theta;
    this.rotationInverseSine = inverseSine;
    this.rotationRightSign = rightSign;
  }

  private sampleRotation(frame: number, ellipse: Raw4DSelectionEllipseProperties): void {
    const track = this.asset.rotation;
    const span = trackSpan(track, frame);
    const destinations = [ellipse.rotationW, ellipse.rotationX, ellipse.rotationY, ellipse.rotationZ];
    if (span.left === span.right) {
      const offset = span.left * 4;
      for (let index = 0; index < this.asset.splatCount; index += 1) {
        const w = readRaw4DScalar(track.values[offset], index, track.encoding);
        const x = readRaw4DScalar(track.values[offset + 1], index, track.encoding);
        const y = readRaw4DScalar(track.values[offset + 2], index, track.encoding);
        const z = readRaw4DScalar(track.values[offset + 3], index, track.encoding);
        const inverseLength = 1 / Math.max(1e-12, Math.hypot(w, x, y, z));
        destinations[0][index] = w * inverseLength;
        destinations[1][index] = x * inverseLength;
        destinations[2][index] = y * inverseLength;
        destinations[3][index] = z * inverseLength;
      }
      return;
    }

    this.prepareRotationPair(span.left);
    const theta = this.rotationTheta!;
    const inverseSine = this.rotationInverseSine!;
    const rightSign = this.rotationRightSign!;
    const leftOffset = span.left * 4;
    const rightOffset = span.right * 4;
    for (let index = 0; index < this.asset.splatCount; index += 1) {
      let lw = readRaw4DScalar(track.values[leftOffset], index, track.encoding);
      let lx = readRaw4DScalar(track.values[leftOffset + 1], index, track.encoding);
      let ly = readRaw4DScalar(track.values[leftOffset + 2], index, track.encoding);
      let lz = readRaw4DScalar(track.values[leftOffset + 3], index, track.encoding);
      let rw = readRaw4DScalar(track.values[rightOffset], index, track.encoding);
      let rx = readRaw4DScalar(track.values[rightOffset + 1], index, track.encoding);
      let ry = readRaw4DScalar(track.values[rightOffset + 2], index, track.encoding);
      let rz = readRaw4DScalar(track.values[rightOffset + 3], index, track.encoding);
      const leftInverseLength = 1 / Math.max(1e-12, Math.hypot(lw, lx, ly, lz));
      const rightInverseLength = rightSign[index] / Math.max(1e-12, Math.hypot(rw, rx, ry, rz));
      lw *= leftInverseLength; lx *= leftInverseLength; ly *= leftInverseLength; lz *= leftInverseLength;
      rw *= rightInverseLength; rx *= rightInverseLength; ry *= rightInverseLength; rz *= rightInverseLength;
      const leftWeight = inverseSine[index]
        ? Math.sin((1 - span.alpha) * theta[index]) * inverseSine[index]
        : 1 - span.alpha;
      const rightWeight = inverseSine[index]
        ? Math.sin(span.alpha * theta[index]) * inverseSine[index]
        : span.alpha;
      const w = lw * leftWeight + rw * rightWeight;
      const x = lx * leftWeight + rx * rightWeight;
      const y = ly * leftWeight + ry * rightWeight;
      const z = lz * leftWeight + rz * rightWeight;
      const inverseLength = 1 / Math.max(1e-12, Math.hypot(w, x, y, z));
      destinations[0][index] = w * inverseLength;
      destinations[1][index] = x * inverseLength;
      destinations[2][index] = y * inverseLength;
      destinations[3][index] = z * inverseLength;
    }
  }
}
