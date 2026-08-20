import { GSplatData } from 'playcanvas';
import type { Raw4DAsset, Raw4DTrack } from '../formats/raw4d/Raw4DTypes';
import { decodeRaw4DArray, readRaw4DScalar, readRaw4DTrack } from '../formats/raw4d/Raw4DValues';

interface TrackSpan {
  left: number;
  right: number;
  alpha: number;
}

interface RotationPair {
  theta: Float32Array;
  inverseSinTheta: Float32Array;
  rightSign: Int8Array;
}

export interface Raw4DFrameProperties {
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly rotationW: Float32Array;
  readonly rotationX: Float32Array;
  readonly rotationY: Float32Array;
  readonly rotationZ: Float32Array;
  readonly scaleX: Float32Array;
  readonly scaleY: Float32Array;
  readonly scaleZ: Float32Array;
  readonly colorR: Float32Array;
  readonly colorG: Float32Array;
  readonly colorB: Float32Array;
  readonly opacity: Float32Array;
}

function trackSpan(track: Raw4DTrack, frame: number): TrackSpan {
  if (track.keyframes.length === 1 || frame <= track.keyframes[0]) {
    return { left: 0, right: 0, alpha: 0 };
  }
  const last = track.keyframes.length - 1;
  if (frame >= track.keyframes[last]) {
    return { left: last, right: last, alpha: 0 };
  }
  for (let right = 1; right < track.keyframes.length; right += 1) {
    if (frame <= track.keyframes[right]) {
      const left = right - 1;
      const alpha = (frame - track.keyframes[left]) / (track.keyframes[right] - track.keyframes[left]);
      return { left, right, alpha };
    }
  }
  return { left: last, right: last, alpha: 0 };
}

function stableSigmoid(value: number): number {
  if (value >= 0) {
    return 1 / (1 + Math.exp(-value));
  }
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

function prepareRotationPairs(track: Raw4DTrack): RotationPair[] {
  const pairs: RotationPair[] = [];
  for (let key = 0; key < track.keyframes.length - 1; key += 1) {
    const leftOffset = key * 4;
    const rightOffset = leftOffset + 4;
    const theta = new Float32Array(track.values[leftOffset].length);
    const inverseSinTheta = new Float32Array(theta.length);
    const rightSign = new Int8Array(theta.length);
    for (let index = 0; index < theta.length; index += 1) {
      const leftW = readRaw4DTrack(track, leftOffset, index);
      const leftX = readRaw4DTrack(track, leftOffset + 1, index);
      const leftY = readRaw4DTrack(track, leftOffset + 2, index);
      const leftZ = readRaw4DTrack(track, leftOffset + 3, index);
      const rightW = readRaw4DTrack(track, rightOffset, index);
      const rightX = readRaw4DTrack(track, rightOffset + 1, index);
      const rightY = readRaw4DTrack(track, rightOffset + 2, index);
      const rightZ = readRaw4DTrack(track, rightOffset + 3, index);
      const leftLength = Math.hypot(leftW, leftX, leftY, leftZ);
      const rightLength = Math.hypot(rightW, rightX, rightY, rightZ);
      let dot = leftLength > 1e-12 && rightLength > 1e-12
        ? (leftW * rightW + leftX * rightX + leftY * rightY + leftZ * rightZ) / (leftLength * rightLength)
        : 1;
      const sign = dot < 0 ? -1 : 1;
      dot = Math.min(1, Math.max(-1, dot * sign));
      const angle = Math.acos(dot);
      const sine = Math.sin(angle);
      theta[index] = angle;
      inverseSinTheta[index] = sine > 1e-5 ? 1 / sine : 0;
      rightSign[index] = sign;
    }
    pairs.push({ theta, inverseSinTheta, rightSign });
  }
  return pairs;
}

function createProperties(count: number): Raw4DFrameProperties {
  const arrays = Array.from({ length: 14 }, () => new Float32Array(count));
  return {
    x: arrays[0], y: arrays[1], z: arrays[2],
    rotationW: arrays[3], rotationX: arrays[4], rotationY: arrays[5], rotationZ: arrays[6],
    scaleX: arrays[7], scaleY: arrays[8], scaleZ: arrays[9],
    colorR: arrays[10], colorG: arrays[11], colorB: arrays[12], opacity: arrays[13],
  };
}

export class Raw4DFrameSampler {
  readonly properties: Raw4DFrameProperties;
  readonly gsplatData: GSplatData;
  private readonly rotationPairs: RotationPair[];
  private sampledFrame = Number.NaN;

  constructor(readonly asset: Raw4DAsset) {
    this.properties = createProperties(asset.splatCount);
    this.rotationPairs = prepareRotationPairs(asset.rotation);
    const properties = [
      ['x', this.properties.x], ['y', this.properties.y], ['z', this.properties.z],
      ['rot_0', this.properties.rotationW], ['rot_1', this.properties.rotationX],
      ['rot_2', this.properties.rotationY], ['rot_3', this.properties.rotationZ],
      ['scale_0', this.properties.scaleX], ['scale_1', this.properties.scaleY],
      ['scale_2', this.properties.scaleZ], ['f_dc_0', this.properties.colorR],
      ['f_dc_1', this.properties.colorG], ['f_dc_2', this.properties.colorB],
      ['opacity', this.properties.opacity],
      ...asset.shRest.map((storage, index) => [
        `f_rest_${index}`,
        decodeRaw4DArray(storage, asset.sourceEncoding),
      ] as const),
    ] as const;
    this.gsplatData = new GSplatData([{
      name: 'vertex',
      count: asset.splatCount,
      properties: properties.map(([name, storage]) => ({
        type: 'float', name, storage, byteSize: Float32Array.BYTES_PER_ELEMENT,
      })),
    }], [`RAW4D source: ${asset.sourceName}`]);
    this.gsplatData.activated = true;
    this.sample(0);
  }

  sample(requestedFrame: number): boolean {
    const frame = Math.min(this.asset.totalFrames - 1, Math.max(0, requestedFrame));
    if (frame === this.sampledFrame) return false;
    this.samplePositionTrack(frame);
    this.sampleRotation(frame);
    this.sampleScale(frame);
    this.sampleLinearTrack(this.asset.colorDc, frame, [this.properties.colorR, this.properties.colorG, this.properties.colorB]);
    this.sampleOpacity(frame);
    this.sampledFrame = frame;
    return true;
  }

  samplePosition(requestedFrame: number): void {
    const frame = Math.min(this.asset.totalFrames - 1, Math.max(0, requestedFrame));
    this.samplePositionTrack(frame);
  }

  private samplePositionTrack(frame: number): void {
    if (this.asset.positionTiming !== 'per-point-lifetime-endpoints') {
      this.sampleLinearTrack(this.asset.position, frame, [this.properties.x, this.properties.y, this.properties.z]);
      return;
    }
    const track = this.asset.position;
    const destinations = [this.properties.x, this.properties.y, this.properties.z];
    for (let index = 0; index < this.asset.splatCount; index += 1) {
      const center = readRaw4DScalar(this.asset.lifetimeMu, index, this.asset.sourceEncoding);
      const halfWidth = Math.max(0, readRaw4DScalar(this.asset.lifetimeW, index, this.asset.sourceEncoding));
      const start = center - halfWidth;
      const end = center + halfWidth;
      const alpha = end > start ? Math.max(0, Math.min(1, (frame - start) / (end - start))) : 0;
      for (let component = 0; component < 3; component += 1) {
        const left = readRaw4DTrack(track, component, index);
        const right = readRaw4DTrack(track, 3 + component, index);
        destinations[component][index] = left + (right - left) * alpha;
      }
    }
  }

  private sampleLinearTrack(track: Raw4DTrack, frame: number, destinations: readonly Float32Array[]): void {
    const span = trackSpan(track, frame);
    for (let component = 0; component < track.components; component += 1) {
      const destination = destinations[component];
      const left = track.values[span.left * track.components + component];
      if (span.left === span.right) {
        if (track.encoding === 'float32') destination.set(left as Float32Array);
        else {
          for (let index = 0; index < destination.length; index += 1) {
            destination[index] = readRaw4DScalar(left, index, track.encoding);
          }
        }
        continue;
      }
      const right = track.values[span.right * track.components + component];
      for (let index = 0; index < destination.length; index += 1) {
        const leftValue = readRaw4DScalar(left, index, track.encoding);
        const rightValue = readRaw4DScalar(right, index, track.encoding);
        destination[index] = leftValue + (rightValue - leftValue) * span.alpha;
      }
    }
  }

  private sampleScale(frame: number): void {
    const track = this.asset.scale;
    const span = trackSpan(track, frame);
    const destinations = [this.properties.scaleX, this.properties.scaleY, this.properties.scaleZ];
    for (let component = 0; component < 3; component += 1) {
      const destination = destinations[component];
      const left = track.values[span.left * 3 + component];
      const right = track.values[span.right * 3 + component];
      for (let index = 0; index < destination.length; index += 1) {
        destination[index] = Math.exp(interpolateExtended(
          readRaw4DScalar(left, index, track.encoding),
          readRaw4DScalar(right, index, track.encoding),
          span.alpha,
        ));
      }
    }
  }

  private sampleOpacity(frame: number): void {
    const track = this.asset.opacity;
    const span = trackSpan(track, frame);
    const left = track.values[span.left];
    const right = track.values[span.right];
    const destination = this.properties.opacity;
    for (let index = 0; index < destination.length; index += 1) {
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
      destination[index] = stableSigmoid(logit) * gate;
    }
  }

  private sampleRotation(frame: number): void {
    const track = this.asset.rotation;
    const span = trackSpan(track, frame);
    const destinations = [
      this.properties.rotationW, this.properties.rotationX,
      this.properties.rotationY, this.properties.rotationZ,
    ];
    if (span.left === span.right) {
      for (let index = 0; index < destinations[0].length; index += 1) {
        const offset = span.left * 4;
        const w = readRaw4DTrack(track, offset, index);
        const x = readRaw4DTrack(track, offset + 1, index);
        const y = readRaw4DTrack(track, offset + 2, index);
        const z = readRaw4DTrack(track, offset + 3, index);
        const length = Math.hypot(w, x, y, z);
        destinations[0][index] = length > 1e-12 ? w / length : 1;
        destinations[1][index] = length > 1e-12 ? x / length : 0;
        destinations[2][index] = length > 1e-12 ? y / length : 0;
        destinations[3][index] = length > 1e-12 ? z / length : 0;
      }
      return;
    }
    const pair = this.rotationPairs[span.left];
    for (let index = 0; index < destinations[0].length; index += 1) {
      const leftOffset = span.left * 4;
      const rightOffset = span.right * 4;
      let leftW = readRaw4DTrack(track, leftOffset, index);
      let leftX = readRaw4DTrack(track, leftOffset + 1, index);
      let leftY = readRaw4DTrack(track, leftOffset + 2, index);
      let leftZ = readRaw4DTrack(track, leftOffset + 3, index);
      let rightW = readRaw4DTrack(track, rightOffset, index);
      let rightX = readRaw4DTrack(track, rightOffset + 1, index);
      let rightY = readRaw4DTrack(track, rightOffset + 2, index);
      let rightZ = readRaw4DTrack(track, rightOffset + 3, index);
      const leftLength = Math.hypot(leftW, leftX, leftY, leftZ);
      const rightLength = Math.hypot(rightW, rightX, rightY, rightZ);
      if (leftLength > 1e-12) {
        leftW /= leftLength; leftX /= leftLength; leftY /= leftLength; leftZ /= leftLength;
      } else {
        leftW = 1; leftX = 0; leftY = 0; leftZ = 0;
      }
      const rightScale = (rightLength > 1e-12 ? 1 / rightLength : 0) * pair.rightSign[index];
      if (rightLength > 1e-12) {
        rightW *= rightScale; rightX *= rightScale; rightY *= rightScale; rightZ *= rightScale;
      } else {
        rightW = pair.rightSign[index]; rightX = 0; rightY = 0; rightZ = 0;
      }
      const inverseSine = pair.inverseSinTheta[index];
      const leftWeight = inverseSine
        ? Math.sin((1 - span.alpha) * pair.theta[index]) * inverseSine
        : 1 - span.alpha;
      const rightWeight = inverseSine
        ? Math.sin(span.alpha * pair.theta[index]) * inverseSine
        : span.alpha;
      let w = leftW * leftWeight + rightW * rightWeight;
      let x = leftX * leftWeight + rightX * rightWeight;
      let y = leftY * leftWeight + rightY * rightWeight;
      let z = leftZ * leftWeight + rightZ * rightWeight;
      const lengthSquared = w * w + x * x + y * y + z * z;
      const inverseLength = lengthSquared > 1e-12 ? 1 / Math.sqrt(lengthSquared) : 1;
      w *= inverseLength; x *= inverseLength; y *= inverseLength; z *= inverseLength;
      destinations[0][index] = w;
      destinations[1][index] = x;
      destinations[2][index] = y;
      destinations[3][index] = z;
    }
  }
}
