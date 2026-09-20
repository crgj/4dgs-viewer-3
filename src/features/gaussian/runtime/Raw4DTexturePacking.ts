// #WDD-gpt 2026-09-20 - 纹理打包纯计算与图形设备分离，主线程和后台 Worker 共用同一位级算法。
import { FloatPacking } from 'playcanvas';
import { RAW4D_FLOAT16_DECODE_TABLE } from '../formats/raw4d/Raw4DFloat16';
import type { Raw4DAsset } from '../formats/raw4d/Raw4DTypes';
import { readRaw4DScalar, readRaw4DTrack } from '../formats/raw4d/Raw4DValues';
const SH_C0 = 0.28209479177387814;
function sigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponential = Math.exp(value); return exponential / (1 + exponential);
}
// #WDD-gpt 2026-09-20 - FP16 输入的固定颜色、尺度和烘焙透明度转换查表，精确复用原计算结果。
const dcHalf = Uint16Array.from(RAW4D_FLOAT16_DECODE_TABLE, value => FloatPacking.float2Half(value * SH_C0 + .5));
const scaleHalf = Uint16Array.from(RAW4D_FLOAT16_DECODE_TABLE, value => FloatPacking.float2Half(Math.exp(value)));
const opacityHalf = Uint16Array.from(RAW4D_FLOAT16_DECODE_TABLE, value => FloatPacking.float2Half(sigmoid(value)));
// #WDD-gpt 2026-08-16 - SH 打包范围必须覆盖首项为负数的情况，避免 f_rest_0 被错误裁剪。
export function raw4DShPackingMaximum(values: readonly number[]): number {
  let maximum = 0;
  for (const value of values) maximum = Math.max(maximum, Math.abs(value));
  return maximum;
}

export function fillRaw4DColorTransform(asset: Raw4DAsset, color: Uint16Array, transformA: Uint32Array, transformB: Uint16Array) {
  const transformAFloat = new Float32Array(transformA.buffer, transformA.byteOffset, transformA.length);
    const float2Half = FloatPacking.float2Half;

    for (let index = 0; index < asset.splatCount; index += 1) {
      const colorOffset = index * 4;
      color[colorOffset] = asset.colorDc.encoding === 'float16' ? dcHalf[asset.colorDc.values[0][index]] : float2Half(readRaw4DTrack(asset.colorDc, 0, index) * SH_C0 + 0.5);
      color[colorOffset + 1] = asset.colorDc.encoding === 'float16' ? dcHalf[asset.colorDc.values[1][index]] : float2Half(readRaw4DTrack(asset.colorDc, 1, index) * SH_C0 + 0.5);
      color[colorOffset + 2] = asset.colorDc.encoding === 'float16' ? dcHalf[asset.colorDc.values[2][index]] : float2Half(readRaw4DTrack(asset.colorDc, 2, index) * SH_C0 + 0.5);
      const mu = readRaw4DScalar(asset.lifetimeMu, index, asset.sourceEncoding);
      const width = readRaw4DScalar(asset.lifetimeW, index, asset.sourceEncoding);
      const gate = asset.opacityTiming === 'baked'
        ? 1
        : sigmoid(10 * (0 - (mu - width))) * sigmoid(10 * ((mu + width) - 0));
      color[colorOffset + 3] = asset.opacityTiming === 'baked' && asset.opacity.encoding === 'float16'
        ? opacityHalf[asset.opacity.values[0][index]] : float2Half(sigmoid(readRaw4DTrack(asset.opacity, 0, index)) * gate);

      const transformOffset = index * 4;
      transformAFloat[transformOffset] = readRaw4DTrack(asset.position, 0, index);
      transformAFloat[transformOffset + 1] = readRaw4DTrack(asset.position, 1, index);
      transformAFloat[transformOffset + 2] = readRaw4DTrack(asset.position, 2, index);
      let w = readRaw4DTrack(asset.rotation, 0, index);
      let x = readRaw4DTrack(asset.rotation, 1, index);
      let y = readRaw4DTrack(asset.rotation, 2, index);
      let z = readRaw4DTrack(asset.rotation, 3, index);
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
      transformB[transformOffset] = asset.scale.encoding === 'float16' ? scaleHalf[asset.scale.values[0][index]] : float2Half(Math.exp(readRaw4DTrack(asset.scale, 0, index)));
      transformB[transformOffset + 1] = asset.scale.encoding === 'float16' ? scaleHalf[asset.scale.values[1][index]] : float2Half(Math.exp(readRaw4DTrack(asset.scale, 1, index)));
      transformB[transformOffset + 2] = asset.scale.encoding === 'float16' ? scaleHalf[asset.scale.values[2][index]] : float2Half(Math.exp(readRaw4DTrack(asset.scale, 2, index)));
      transformB[transformOffset + 3] = float2Half(z);
    }

}
export function fillRaw4DSH(asset: Raw4DAsset, shBands: number, sh1to3: Uint32Array, sh4to7?: Uint32Array, sh8to11?: Uint32Array, sh12to15?: Uint32Array) {
    sh1to3.fill(0);
    sh4to7?.fill(0);
    sh8to11?.fill(0);
    sh12to15?.fill(0);
    const coefficientCount = ({ 1: 3, 2: 8, 3: 15 } as const)[shBands as 1 | 2 | 3];
    const sourceCoefficientCount = ({ 1: 3, 2: 8, 3: 15 } as const)[asset.shBands as 1 | 2 | 3];
    const values = new Array<number>(coefficientCount * 3).fill(0);
    const floatBits = new Float32Array(1);
    const uintBits = new Uint32Array(floatBits.buffer);
    const t11 = (1 << 11) - 1;
    const t10 = (1 << 10) - 1;

    for (let index = 0; index < asset.splatCount; index += 1) {
      for (let coefficient = 0; coefficient < coefficientCount; coefficient += 1) {
        values[coefficient * 3] = readRaw4DScalar(
          asset.shRest[coefficient], index, asset.sourceEncoding,
        );
        values[coefficient * 3 + 1] = readRaw4DScalar(
          asset.shRest[coefficient + sourceCoefficientCount], index, asset.sourceEncoding,
        );
        values[coefficient * 3 + 2] = readRaw4DScalar(
          asset.shRest[coefficient + sourceCoefficientCount * 2], index, asset.sourceEncoding,
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
      if (shBands > 1) {
        sh4to7![base] = values[9] << 21 | values[10] << 11 | values[11];
        sh4to7![base + 1] = values[12] << 21 | values[13] << 11 | values[14];
        sh4to7![base + 2] = values[15] << 21 | values[16] << 11 | values[17];
        sh4to7![base + 3] = values[18] << 21 | values[19] << 11 | values[20];
        if (shBands > 2) {
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
}
