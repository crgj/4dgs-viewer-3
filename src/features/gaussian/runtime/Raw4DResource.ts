import {
  FloatPacking,
  GSplatFormat,
  GSplatResourceBase,
  PIXELFORMAT_R32U,
  PIXELFORMAT_RGBA16F,
  PIXELFORMAT_RGBA32U,
  type BoundingBox,
  type GraphicsDevice,
  Vec3,
} from 'playcanvas';
import type { Raw4DAsset } from '../formats/raw4d/Raw4DTypes';
import { readRaw4DScalar, readRaw4DTrack } from '../formats/raw4d/Raw4DValues';

const SH_C0 = 0.28209479177387814;

function sigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

interface Raw4DResourceMetadata {
  readonly numSplats: number;
  readonly shBands: number;
  calcAabb(result: BoundingBox): boolean;
}

// #WDD-gpt 2026-08-16 - SH 打包范围必须覆盖首项为负数的情况，避免 f_rest_0 被错误裁剪。
export function raw4DShPackingMaximum(values: readonly number[]): number {
  let maximum = 0;
  for (const value of values) maximum = Math.max(maximum, Math.abs(value));
  return maximum;
}

export class Raw4DResource extends GSplatResourceBase {
  readonly shBands: number;
  readonly gpuByteSize: number;
  private displayShBands: number;

  constructor(device: GraphicsDevice, private readonly asset: Raw4DAsset) {
    const metadata: Raw4DResourceMetadata = {
      numSplats: asset.splatCount,
      shBands: asset.shBands,
      calcAabb: (result) => {
        result.setMinMax(new Vec3(...asset.bounds.min), new Vec3(...asset.bounds.max));
        return true;
      },
    };
    super(device, metadata as never, { prepareCenters: false });
    this.shBands = asset.shBands;
    this.displayShBands = asset.shBands;
    const streams: Array<{ name: string; format: number }> = [
      { name: 'splatColor', format: PIXELFORMAT_RGBA16F },
      { name: 'transformA', format: PIXELFORMAT_RGBA32U },
      { name: 'transformB', format: PIXELFORMAT_RGBA16F },
    ];
    if (this.shBands > 0) {
      streams.push({ name: 'splatSH_1to3', format: PIXELFORMAT_RGBA32U });
      if (this.shBands > 1) {
        streams.push({ name: 'splatSH_4to7', format: PIXELFORMAT_RGBA32U });
        streams.push({
          name: 'splatSH_8to11',
          format: this.shBands > 2 ? PIXELFORMAT_RGBA32U : PIXELFORMAT_R32U,
        });
        if (this.shBands > 2) streams.push({ name: 'splatSH_12to15', format: PIXELFORMAT_RGBA32U });
      }
    }
    this._format = new GSplatFormat(device, streams, {
      readGLSL: '#include "gsplatUncompressedVS"',
      readWGSL: '#include "gsplatUncompressedVS"',
    });
    this.streams.init(this.format, asset.splatCount);
    // #WDD-gpt 2026-08-16 - 直接从位保持 Canonical 数组生成 PlayCanvas 纹理，避免为一次性上传常驻解码 59 个 Float32Array。
    this.uploadColorAndTransform();
    if (this.shBands > 0) this.uploadSH();

    const texels = this.streams.textureDimensions.x * this.streams.textureDimensions.y;
    const shBytes = this.shBands === 0 ? 0 : this.shBands === 1 ? 16 : this.shBands === 2 ? 36 : 64;
    this.gpuByteSize = texels * (32 + shBytes);
  }

  override configureMaterialDefines(defines: Map<string, string | number | boolean>): void {
    defines.set('SH_BANDS', String(this.displayShBands));
  }

  setDisplayShBands(level: number): number {
    this.displayShBands = Math.max(0, Math.min(this.shBands, Math.round(level)));
    return this.displayShBands;
  }

  refreshSourceData(): void {
    this.uploadColorAndTransform();
    if (this.shBands > 0) this.uploadSH();
    this.aabb.setMinMax(new Vec3(...this.asset.bounds.min), new Vec3(...this.asset.bounds.max));
  }

  private uploadColorAndTransform(): void {
    const color = this.streams.getTexture('splatColor')!.lock() as Uint16Array;
    const transformA = this.streams.getTexture('transformA')!.lock() as Uint32Array;
    const transformAFloat = new Float32Array(transformA.buffer, transformA.byteOffset, transformA.length);
    const transformB = this.streams.getTexture('transformB')!.lock() as Uint16Array;
    const float2Half = FloatPacking.float2Half;

    for (let index = 0; index < this.asset.splatCount; index += 1) {
      const colorOffset = index * 4;
      color[colorOffset] = float2Half(readRaw4DTrack(this.asset.colorDc, 0, index) * SH_C0 + 0.5);
      color[colorOffset + 1] = float2Half(readRaw4DTrack(this.asset.colorDc, 1, index) * SH_C0 + 0.5);
      color[colorOffset + 2] = float2Half(readRaw4DTrack(this.asset.colorDc, 2, index) * SH_C0 + 0.5);
      const mu = readRaw4DScalar(this.asset.lifetimeMu, index, this.asset.sourceEncoding);
      const width = readRaw4DScalar(this.asset.lifetimeW, index, this.asset.sourceEncoding);
      const gate = this.asset.opacityTiming === 'baked'
        ? 1
        : sigmoid(10 * (0 - (mu - width))) * sigmoid(10 * ((mu + width) - 0));
      color[colorOffset + 3] = float2Half(sigmoid(readRaw4DTrack(this.asset.opacity, 0, index)) * gate);

      const transformOffset = index * 4;
      transformAFloat[transformOffset] = readRaw4DTrack(this.asset.position, 0, index);
      transformAFloat[transformOffset + 1] = readRaw4DTrack(this.asset.position, 1, index);
      transformAFloat[transformOffset + 2] = readRaw4DTrack(this.asset.position, 2, index);
      let w = readRaw4DTrack(this.asset.rotation, 0, index);
      let x = readRaw4DTrack(this.asset.rotation, 1, index);
      let y = readRaw4DTrack(this.asset.rotation, 2, index);
      let z = readRaw4DTrack(this.asset.rotation, 3, index);
      const length = Math.hypot(w, x, y, z);
      if (length > 1e-12) {
        w /= length; x /= length; y /= length; z /= length;
      } else {
        w = 1; x = 0; y = 0; z = 0;
      }
      if (w < 0) {
        w *= -1; x *= -1; y *= -1; z *= -1;
      }
      transformA[transformOffset + 3] = float2Half(x) | (float2Half(y) << 16);
      transformB[transformOffset] = float2Half(Math.exp(readRaw4DTrack(this.asset.scale, 0, index)));
      transformB[transformOffset + 1] = float2Half(Math.exp(readRaw4DTrack(this.asset.scale, 1, index)));
      transformB[transformOffset + 2] = float2Half(Math.exp(readRaw4DTrack(this.asset.scale, 2, index)));
      transformB[transformOffset + 3] = float2Half(z);
    }

    this.streams.getTexture('splatColor')!.unlock();
    this.streams.getTexture('transformA')!.unlock();
    this.streams.getTexture('transformB')!.unlock();
  }

  private uploadSH(): void {
    const sh1to3Texture = this.streams.getTexture('splatSH_1to3')!;
    const sh4to7Texture = this.streams.getTexture('splatSH_4to7');
    const sh8to11Texture = this.streams.getTexture('splatSH_8to11');
    const sh12to15Texture = this.streams.getTexture('splatSH_12to15');
    const sh1to3 = sh1to3Texture.lock() as Uint32Array;
    const sh4to7 = sh4to7Texture?.lock() as Uint32Array | undefined;
    const sh8to11 = sh8to11Texture?.lock() as Uint32Array | undefined;
    const sh12to15 = sh12to15Texture?.lock() as Uint32Array | undefined;
    sh1to3.fill(0);
    sh4to7?.fill(0);
    sh8to11?.fill(0);
    sh12to15?.fill(0);
    const coefficientCount = ({ 1: 3, 2: 8, 3: 15 } as const)[this.shBands as 1 | 2 | 3];
    const values = new Array<number>(coefficientCount * 3).fill(0);
    const floatBits = new Float32Array(1);
    const uintBits = new Uint32Array(floatBits.buffer);
    const t11 = (1 << 11) - 1;
    const t10 = (1 << 10) - 1;

    for (let index = 0; index < this.asset.splatCount; index += 1) {
      for (let coefficient = 0; coefficient < coefficientCount; coefficient += 1) {
        values[coefficient * 3] = readRaw4DScalar(
          this.asset.shRest[coefficient], index, this.asset.sourceEncoding,
        );
        values[coefficient * 3 + 1] = readRaw4DScalar(
          this.asset.shRest[coefficient + coefficientCount], index, this.asset.sourceEncoding,
        );
        values[coefficient * 3 + 2] = readRaw4DScalar(
          this.asset.shRest[coefficient + coefficientCount * 2], index, this.asset.sourceEncoding,
        );
      }
      const maximum = raw4DShPackingMaximum(values);
      if (maximum === 0) continue;
      for (let coefficient = 0; coefficient < coefficientCount; coefficient += 1) {
        const offset = coefficient * 3;
        values[offset] = Math.max(0, Math.min(t11, Math.floor((values[offset] / maximum * 0.5 + 0.5) * t11 + 0.5)));
        values[offset + 1] = Math.max(0, Math.min(t10, Math.floor((values[offset + 1] / maximum * 0.5 + 0.5) * t10 + 0.5)));
        values[offset + 2] = Math.max(0, Math.min(t11, Math.floor((values[offset + 2] / maximum * 0.5 + 0.5) * t11 + 0.5)));
      }
      floatBits[0] = maximum;
      const base = index * 4;
      sh1to3[base] = uintBits[0];
      sh1to3[base + 1] = values[0] << 21 | values[1] << 11 | values[2];
      sh1to3[base + 2] = values[3] << 21 | values[4] << 11 | values[5];
      sh1to3[base + 3] = values[6] << 21 | values[7] << 11 | values[8];
      if (this.shBands > 1) {
        sh4to7![base] = values[9] << 21 | values[10] << 11 | values[11];
        sh4to7![base + 1] = values[12] << 21 | values[13] << 11 | values[14];
        sh4to7![base + 2] = values[15] << 21 | values[16] << 11 | values[17];
        sh4to7![base + 3] = values[18] << 21 | values[19] << 11 | values[20];
        if (this.shBands > 2) {
          sh8to11![base] = values[21] << 21 | values[22] << 11 | values[23];
          sh8to11![base + 1] = values[24] << 21 | values[25] << 11 | values[26];
          sh8to11![base + 2] = values[27] << 21 | values[28] << 11 | values[29];
          sh8to11![base + 3] = values[30] << 21 | values[31] << 11 | values[32];
          sh12to15![base] = values[33] << 21 | values[34] << 11 | values[35];
          sh12to15![base + 1] = values[36] << 21 | values[37] << 11 | values[38];
          sh12to15![base + 2] = values[39] << 21 | values[40] << 11 | values[41];
          sh12to15![base + 3] = values[42] << 21 | values[43] << 11 | values[44];
        } else {
          sh8to11![index] = values[21] << 21 | values[22] << 11 | values[23];
        }
      }
    }
    sh1to3Texture.unlock();
    sh4to7Texture?.unlock();
    sh8to11Texture?.unlock();
    sh12to15Texture?.unlock();
  }
}
